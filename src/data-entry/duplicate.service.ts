import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

const AMOUNT_TOLERANCE = 0.02;
const DATE_WINDOW_DAYS = 7;

interface RowData {
  invoice_number?: unknown;
  invoice_date?: unknown;
  customer_name?: unknown;
  vendor_name?: unknown;
  transaction_type?: unknown;
  total_amount?: unknown;
}

interface Candidate {
  rowId: string;
  rowNumber: number;
  scope: 'CURRENT_IMPORT' | 'HISTORICAL';
  kind: 'EXACT' | 'NEAR_MATCH';
  score: number;
  reasons: string[];
}

@Injectable()
export class DuplicateService {
  constructor(private readonly prisma: PrismaService) {}

  async detectDuplicates(importId: string, companyId: string) {
    const imported = await this.prisma.dataImport.findFirst({
      where: { id: importId, companyId },
      select: { id: true, rows: { orderBy: { rowNumber: 'asc' }, select: { id: true, rowNumber: true, normalizedData: true, rawData: true, status: true } } },
    });
    if (!imported) throw new NotFoundException('Import session not found.');

    const historical = await this.prisma.dataImportRow.findMany({
      where: {
        importId: { not: importId },
        import: { companyId, status: { in: ['READY', 'POSTING', 'COMPLETED'] } },
        status: { in: ['VALID', 'READY', 'POSTED'] },
      },
      select: { id: true, rowNumber: true, normalizedData: true, rawData: true },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    const current = imported.rows.map((row) => ({ ...row, data: this.record(row.normalizedData ?? row.rawData) }));
    const old = historical.map((row) => ({ ...row, data: this.record(row.normalizedData ?? row.rawData) }));
    const candidates = new Map<string, Candidate[]>();

    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const result = this.compare(current[i].data, current[j].data);
        if (result.kind !== 'NONE') {
          this.add(candidates, current[i].id, { ...result, rowId: current[j].id, rowNumber: current[j].rowNumber, scope: 'CURRENT_IMPORT' });
          this.add(candidates, current[j].id, { ...result, rowId: current[i].id, rowNumber: current[i].rowNumber, scope: 'CURRENT_IMPORT' });
        }
      }
    }

    for (const row of current) {
      for (const candidate of old) {
        const result = this.compare(row.data, candidate.data);
        if (result.kind !== 'NONE') {
          this.add(candidates, row.id, { ...result, rowId: candidate.id, rowNumber: candidate.rowNumber, scope: 'HISTORICAL' });
        }
      }
    }

    let duplicateRows = 0;
    let warningRows = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const row of current) {
        const matches = candidates.get(row.id) ?? [];
        const exact = matches.filter((match) => match.kind === 'EXACT');
        const near = matches.filter((match) => match.kind === 'NEAR_MATCH');
        const existingErrors = this.parseErrors(await this.existingErrors(tx, row.id));
        const cleanErrors = existingErrors.filter((error) => !this.isDuplicateError(error));

        let status: 'DUPLICATE' | 'WARNING' | 'VALID' | 'ERROR' = row.status === 'ERROR' ? 'ERROR' : 'VALID';
        if (exact.length) {
          status = 'DUPLICATE';
          duplicateRows++;
        } else if (near.length && status !== 'ERROR') {
          status = 'WARNING';
          warningRows++;
        }

        const duplicateErrors = exact.length
          ? exact.map((match) => ({
              code: 'DUPLICATE_INVOICE',
              severity: 'ERROR',
              message: `Exact duplicate candidate found at row ${match.rowNumber}.`,
              scope: match.scope,
              confidence: match.score,
              reasons: match.reasons,
            }))
          : near.map((match) => ({
              code: 'POSSIBLE_DUPLICATE',
              severity: 'WARNING',
              message: `Possible near-duplicate found at row ${match.rowNumber}. Review before posting.`,
              scope: match.scope,
              confidence: match.score,
              reasons: match.reasons,
            }));

        await tx.dataImportRow.update({
          where: { id: row.id },
          data: {
            status,
            validationErrors: [...cleanErrors, ...duplicateErrors] as Prisma.InputJsonValue,
            matchResults: {
              duplicateCandidates: matches,
              duplicateStatus: exact.length ? 'DUPLICATE' : near.length ? 'WARNING' : 'NONE',
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }

      const counts = await tx.dataImportRow.groupBy({ by: ['status'], where: { importId }, _count: { _all: true } });
      const count = (status: string) => counts.find((item) => item.status === status)?._count._all ?? 0;
      const errorRows = count('ERROR');
      const validRows = count('VALID') + count('READY');
      const finalDuplicateRows = count('DUPLICATE');
      const finalWarningRows = count('WARNING');

      await tx.dataImport.update({
        where: { id: importId },
        data: {
          duplicateRows: finalDuplicateRows,
          warningRows: finalWarningRows,
          errorRows,
          validRows,
          status: errorRows || finalDuplicateRows ? 'VALIDATING' : 'READY',
        },
      });
    });

    return {
      importId,
      totalRows: current.length,
      duplicateRows,
      warningRows,
      readyForPosting: duplicateRows === 0,
    };
  }

  async getDuplicates(importId: string, companyId: string) {
    const imported = await this.prisma.dataImport.findFirst({ where: { id: importId, companyId }, select: { id: true } });
    if (!imported) throw new NotFoundException('Import session not found.');
    const rows = await this.prisma.dataImportRow.findMany({
      where: { importId, status: { in: ['DUPLICATE', 'WARNING'] } },
      select: { id: true, rowNumber: true, status: true, normalizedData: true, matchResults: true, validationErrors: true },
      orderBy: { rowNumber: 'asc' },
    });
    return { importId, rows };
  }

  private compare(a: RowData, b: RowData) {
    const invoiceA = this.invoice(a.invoice_number);
    const invoiceB = this.invoice(b.invoice_number);
    if (!invoiceA || !invoiceB) return { kind: 'NONE' as const, score: 0, reasons: [] as string[] };

    const typeA = this.text(a.transaction_type);
    const typeB = this.text(b.transaction_type);
    if (typeA && typeB && typeA !== typeB) return { kind: 'NONE' as const, score: 0, reasons: [] as string[] };

    const partyA = this.party(a);
    const partyB = this.party(b);
    const sameParty = !!partyA && !!partyB && partyA === partyB;
    const sameInvoice = invoiceA === invoiceB;
    const similarInvoice = this.similarity(invoiceA, invoiceB) >= 0.88;
    const amountA = this.number(a.total_amount);
    const amountB = this.number(b.total_amount);
    const sameAmount = amountA !== null && amountB !== null && Math.abs(amountA - amountB) <= AMOUNT_TOLERANCE;
    const dateA = this.date(a.invoice_date);
    const dateB = this.date(b.invoice_date);
    const days = dateA && dateB ? Math.abs(dateA.getTime() - dateB.getTime()) / 86400000 : null;
    const sameDate = days === 0;
    const nearDate = days !== null && days <= DATE_WINDOW_DAYS;

    if (sameInvoice && sameParty && sameAmount && sameDate) {
      return { kind: 'EXACT' as const, score: 1, reasons: ['invoice number, party, amount and date match'] };
    }

    let score = 0;
    const reasons: string[] = [];
    if (sameInvoice) { score += 0.45; reasons.push('normalized invoice number matches'); }
    else if (similarInvoice) { score += 0.32; reasons.push('invoice numbers are highly similar'); }
    if (sameParty) { score += 0.30; reasons.push('party matches'); }
    if (sameAmount) { score += 0.15; reasons.push('amount is within tolerance'); }
    if (sameDate) { score += 0.10; reasons.push('invoice date matches'); }
    else if (nearDate) { score += 0.05; reasons.push(`invoice dates are within ${DATE_WINDOW_DAYS} days`); }

    if (score >= 0.75 && (sameParty || sameAmount) && (sameDate || nearDate)) {
      return { kind: 'NEAR_MATCH' as const, score: Number(score.toFixed(2)), reasons };
    }
    return { kind: 'NONE' as const, score: 0, reasons: [] };
  }

  private party(data: RowData) {
    const type = this.text(data.transaction_type);
    if (type.includes('purchase') || type.includes('expense') || type.includes('bill')) return this.text(data.vendor_name || data.customer_name);
    if (type.includes('sale') || type.includes('income') || type.includes('invoice')) return this.text(data.customer_name || data.vendor_name);
    return this.text(data.customer_name || data.vendor_name);
  }

  private invoice(value: unknown) {
    return this.text(value).replace(/[^a-z0-9]/g, '').replace(/^0+/, '');
  }

  private text(value: unknown) {
    return value === null || value === undefined ? '' : String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private number(value: unknown) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const parsed = Number(String(value).replace(/[₹$€£,\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private date(value: unknown) {
    if (!value) return null;
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }

  private similarity(a: string, b: string) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const matrix = Array.from({ length: a.length + 1 }, (_, i) => Array<number>(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return 1 - matrix[a.length][b.length] / Math.max(a.length, b.length);
  }

  private add(map: Map<string, Candidate[]>, rowId: string, candidate: Candidate) {
    const list = map.get(rowId) ?? [];
    const existing = list.find((item) => item.rowId === candidate.rowId);
    if (!existing) list.push(candidate);
    else if (candidate.score > existing.score) Object.assign(existing, candidate);
    map.set(rowId, list);
  }

  private record(value: Prisma.JsonValue | null) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as RowData : {};
  }

  private async existingErrors(tx: Prisma.TransactionClient, rowId: string) {
    const row = await tx.dataImportRow.findUnique({ where: { id: rowId }, select: { validationErrors: true } });
    return row?.validationErrors ?? null;
  }

  private parseErrors(value: unknown) { return Array.isArray(value) ? value : []; }

  private isDuplicateError(value: unknown) {
    return typeof value === 'object' && value !== null && 'code' in value && String((value as Record<string, unknown>).code).startsWith('DUPLICATE');
  }
}
