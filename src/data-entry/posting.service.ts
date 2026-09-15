import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

const EPSILON = 0.02;

@Injectable()
export class PostingService {
  constructor(private readonly prisma: PrismaService) {}

  async postImport(importId: string, companyId: string, userId: string) {
    const imported = await this.prisma.dataImport.findFirst({
      where: { id: importId, companyId },
      select: { id: true, status: true, totalRows: true },
    });
    if (!imported) throw new NotFoundException('Import session not found.');

    if (!userId) throw new BadRequestException('x-user-id header is required until authentication is integrated.');

    const user = await this.prisma.user.findFirst({ where: { id: userId, companyId }, select: { id: true } });
    if (!user) throw new BadRequestException('User does not belong to this company.');

    const rows = await this.prisma.dataImportRow.findMany({
      where: { importId },
      orderBy: { rowNumber: 'asc' },
      select: {
        id: true,
        rowNumber: true,
        status: true,
        normalizedData: true,
        calculatedGst: true,
        validationErrors: true,
        matchResults: true,
        postedJournalId: true,
      },
    });

    if (!rows.length) throw new BadRequestException('Import contains no rows.');

    const blocked = rows.filter((row) => row.status === 'ERROR' || row.status === 'DUPLICATE' || row.status === 'FAILED');
    if (blocked.length) {
      throw new BadRequestException(`Posting blocked: ${blocked.length} row(s) still have accounting errors or duplicates.`);
    }

    const alreadyPosted = rows.filter((row) => row.postedJournalId || row.status === 'POSTED');
    if (alreadyPosted.length === rows.length) {
      return { importId, status: 'COMPLETED', postedRows: 0, alreadyPostedRows: alreadyPosted.length, journalIds: alreadyPosted.map((row) => row.postedJournalId).filter(Boolean) };
    }

    const journalIds: string[] = [];
    let postedRows = 0;
    let skippedRows = 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.dataImport.update({ where: { id: importId }, data: { status: 'POSTING' } });

      for (const row of rows) {
        if (row.postedJournalId || row.status === 'POSTED') {
          skippedRows++;
          if (row.postedJournalId) journalIds.push(row.postedJournalId);
          continue;
        }

        const preview = this.getPreview(row.matchResults);
        if (!preview || preview.errors.length > 0 || !preview.balanced) {
          throw new BadRequestException(`Row ${row.rowNumber} cannot be posted because its accounting preview is invalid.`);
        }

        const lines = preview.lines as Array<{ accountRole: string; side: 'DEBIT' | 'CREDIT'; amount: number; accountId?: string; accountName?: string }>;
        const debitTotal = this.money(lines.filter((line) => line.side === 'DEBIT').reduce((sum, line) => sum + line.amount, 0));
        const creditTotal = this.money(lines.filter((line) => line.side === 'CREDIT').reduce((sum, line) => sum + line.amount, 0));
        if (Math.abs(debitTotal - creditTotal) > EPSILON) {
          throw new BadRequestException(`Row ${row.rowNumber} is not balanced.`);
        }

        const accountIds = [...new Set(lines.map((line) => line.accountId).filter(Boolean))] as string[];
        if (accountIds.length !== lines.filter((line) => line.amount > 0).length) {
          throw new BadRequestException(`Row ${row.rowNumber} has unmapped ledger accounts. Map all required accounts before posting.`);
        }

        const accounts = await tx.account.findMany({
          where: { id: { in: accountIds }, companyId, isActive: true },
          select: { id: true, name: true },
        });
        const accountMap = new Map(accounts.map((account) => [account.id, account.name]));
        if (accountMap.size !== accountIds.length) {
          throw new BadRequestException(`Row ${row.rowNumber} references an invalid or inactive ledger account.`);
        }

        const data = this.asObject(row.normalizedData);
        const invoiceNumber = this.text(data.invoice_number);
        const transactionType = this.text(data.transaction_type) || 'transaction';
        const entryDate = this.parseDate(data.invoice_date) ?? new Date();
        const entryNumber = await this.nextEntryNumber(tx, companyId);
        const sourceKey = `IMPORT_ROW:${row.id}`;

        const existing = await tx.journalEntry.findFirst({ where: { companyId, sourceType: 'DATA_IMPORT', sourceId: row.id }, select: { id: true } });
        if (existing) {
          journalIds.push(existing.id);
          await tx.dataImportRow.update({ where: { id: row.id }, data: { postedJournalId: existing.id, status: 'POSTED' } });
          skippedRows++;
          continue;
        }

        const journal = await tx.journalEntry.create({
          data: {
            companyId,
            entryNumber,
            entryDate,
            sourceType: 'DATA_IMPORT',
            sourceId: row.id,
            narration: `${transactionType}${invoiceNumber ? ` - ${invoiceNumber}` : ''}`,
            lines: {
              create: lines.filter((line) => line.amount > 0).map((line) => ({
                accountId: line.accountId!,
                debit: line.side === 'DEBIT' ? new Prisma.Decimal(line.amount.toFixed(2)) : new Prisma.Decimal(0),
                credit: line.side === 'CREDIT' ? new Prisma.Decimal(line.amount.toFixed(2)) : new Prisma.Decimal(0),
                description: line.accountName || line.accountRole,
              })),
            },
          },
          select: { id: true, lines: { select: { debit: true, credit: true } } },
        });

        const actualDebit = this.money(journal.lines.reduce((sum, line) => sum + Number(line.debit), 0));
        const actualCredit = this.money(journal.lines.reduce((sum, line) => sum + Number(line.credit), 0));
        if (Math.abs(actualDebit - actualCredit) > EPSILON || actualDebit <= 0) {
          throw new BadRequestException(`Row ${row.rowNumber} produced an invalid journal.`);
        }

        await tx.dataImportRow.update({ where: { id: row.id }, data: { postedJournalId: journal.id, status: 'POSTED' } });
        await tx.auditLog.create({
          data: {
            companyId,
            userId,
            action: 'POST',
            entity: 'JournalEntry',
            entityId: journal.id,
            newValue: { importId, rowId: row.id, rowNumber: row.rowNumber, sourceKey, debit: actualDebit, credit: actualCredit } as Prisma.InputJsonValue,
          },
        });

        journalIds.push(journal.id);
        postedRows++;
      }

      const postedCount = await tx.dataImportRow.count({ where: { importId, status: 'POSTED' } });
      await tx.dataImport.update({
        where: { id: importId },
        data: { status: postedCount === rows.length ? 'COMPLETED' : 'POSTING', processedRows: postedCount },
      });
    });

    return { importId, status: postedRows + skippedRows === rows.length ? 'COMPLETED' : 'POSTING', postedRows, skippedRows, journalIds };
  }

  async getPosted(importId: string, companyId: string) {
    const imported = await this.prisma.dataImport.findFirst({ where: { id: importId, companyId }, select: { id: true, status: true } });
    if (!imported) throw new NotFoundException('Import session not found.');

    const rows = await this.prisma.dataImportRow.findMany({
      where: { importId, status: 'POSTED' },
      select: { id: true, rowNumber: true, postedJournalId: true },
      orderBy: { rowNumber: 'asc' },
    });
    const journalIds = rows.map((row) => row.postedJournalId).filter(Boolean) as string[];
    const journals = await this.prisma.journalEntry.findMany({
      where: { companyId, id: { in: journalIds } },
      include: { lines: true },
      orderBy: { entryNumber: 'asc' },
    });
    return { importId, status: imported.status, rows, journals };
  }

  private async nextEntryNumber(tx: Prisma.TransactionClient, companyId: string): Promise<string> {
    const last = await tx.journalEntry.findFirst({ where: { companyId }, orderBy: { createdAt: 'desc' }, select: { entryNumber: true } });
    const match = last?.entryNumber?.match(/(\d+)$/);
    const next = match ? Number(match[1]) + 1 : 1;
    return `JE-${String(next).padStart(8, '0')}`;
  }

  private getPreview(value: Prisma.JsonValue | null) {
    const root = this.asObject(value);
    const preview = this.asObject(root.accountingPreview);
    return preview;
  }

  private asObject(value: Prisma.JsonValue | null | undefined): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  }

  private text(value: unknown): string {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  private parseDate(value: unknown): Date | null {
    if (!value) return null;
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private money(value: number): number {
    return Number(value.toFixed(2));
  }
}
