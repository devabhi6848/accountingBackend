import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

const EPSILON = 0.02;

type AccountingLinePreview = {
  accountRole: string;
  side: 'DEBIT' | 'CREDIT';
  amount: number;
  accountId?: string;
  accountName?: string;
};

type RowPreview = {
  rowId: string;
  rowNumber: number;
  status: 'VALID' | 'WARNING' | 'ERROR' | 'DUPLICATE';
  errors: string[];
  warnings: string[];
  lines: AccountingLinePreview[];
  debitTotal: number;
  creditTotal: number;
  balanced: boolean;
};

@Injectable()
export class AccountingValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async validateImport(importId: string, companyId: string) {
    const imported = await this.prisma.dataImport.findFirst({
      where: { id: importId, companyId },
      select: { id: true, status: true, totalRows: true },
    });
    if (!imported) throw new NotFoundException('Import session not found.');

    const rows = await this.prisma.dataImportRow.findMany({
      where: { importId },
      select: {
        id: true,
        rowNumber: true,
        status: true,
        normalizedData: true,
        calculatedGst: true,
        validationErrors: true,
        matchResults: true,
      },
      orderBy: { rowNumber: 'asc' },
    });

    const previews = rows.map((row) => this.buildPreview(row));
    const errorRows = previews.filter((row) => row.errors.length > 0).length;
    const warningRows = previews.filter((row) => row.errors.length === 0 && row.warnings.length > 0).length;
    const validRows = previews.length - errorRows - warningRows;

    await this.prisma.$transaction(async (tx) => {
      for (const preview of previews) {
        const existingErrors = this.asStringArray(
          rows.find((row) => row.id === preview.rowId)?.validationErrors,
        );
        const mergedErrors = [...new Set([...existingErrors, ...preview.errors])];
        const oldStatus = rows.find((row) => row.id === preview.rowId)?.status;
        const status = oldStatus === 'DUPLICATE'
          ? 'DUPLICATE'
          : preview.errors.length > 0
            ? 'ERROR'
            : preview.warnings.length > 0
              ? 'WARNING'
              : 'READY';

        await tx.dataImportRow.update({
          where: { id: preview.rowId },
          data: {
            status,
            validationErrors: mergedErrors.length
              ? mergedErrors as unknown as Prisma.InputJsonValue
              : null,
            matchResults: {
              ...(this.asObject(rows.find((row) => row.id === preview.rowId)?.matchResults)),
              accountingPreview: preview,
            } as Prisma.InputJsonValue,
          },
        });
      }

      await tx.dataImport.update({
        where: { id: importId },
        data: {
          processedRows: previews.length,
          validRows,
          warningRows,
          errorRows,
          status: errorRows > 0 ? 'VALIDATING' : 'READY',
        },
      });
    });

    return {
      importId,
      totalRows: previews.length,
      validRows,
      warningRows,
      errorRows,
      readyForPreview: errorRows === 0,
      previews,
    };
  }

  async getPreview(importId: string, companyId: string, limit = 100, offset = 0) {
    const imported = await this.prisma.dataImport.findFirst({
      where: { id: importId, companyId },
      select: { id: true, status: true, totalRows: true },
    });
    if (!imported) throw new NotFoundException('Import session not found.');

    const rows = await this.prisma.dataImportRow.findMany({
      where: { importId },
      select: {
        id: true,
        rowNumber: true,
        status: true,
        normalizedData: true,
        calculatedGst: true,
        validationErrors: true,
        matchResults: true,
      },
      orderBy: { rowNumber: 'asc' },
      skip: Math.max(0, offset),
      take: Math.min(Math.max(1, limit), 500),
    });

    return {
      importId,
      status: imported.status,
      totalRows: imported.totalRows,
      offset,
      limit: Math.min(Math.max(1, limit), 500),
      rows: rows.map((row) => this.buildPreview(row)),
    };
  }

  private buildPreview(row: {
    id: string;
    rowNumber: number;
    status: string;
    normalizedData: Prisma.JsonValue | null;
    calculatedGst: Prisma.JsonValue | null;
    validationErrors: Prisma.JsonValue | null;
    matchResults: Prisma.JsonValue | null;
  }): RowPreview {
    const data = this.asObject(row.normalizedData);
    const gst = this.asObject(row.calculatedGst);
    const errors = this.asStringArray(row.validationErrors);
    const warnings: string[] = [];
    const lines: AccountingLinePreview[] = [];

    const transactionType = this.text(data.transaction_type);
    const documentType = this.text(data.document_type);
    const taxable = this.number(gst.taxableAmount ?? data.taxable_amount) ?? 0;
    const cgst = this.number(gst.cgstAmount ?? data.cgst_amount) ?? 0;
    const sgst = this.number(gst.sgstAmount ?? data.sgst_amount) ?? 0;
    const igst = this.number(gst.igstAmount ?? data.igst_amount) ?? 0;
    const total = this.number(data.total_amount) ?? this.number(gst.calculatedTotal) ?? 0;
    const totalTax = this.money(cgst + sgst + igst);

    if (total <= 0) errors.push('Transaction total must be greater than zero.');
    if (taxable < 0) errors.push('Taxable amount cannot be negative.');
    if (Math.abs(this.money(taxable + totalTax) - total) > EPSILON) {
      errors.push(`Accounting base mismatch: taxable + GST (${this.money(taxable + totalTax).toFixed(2)}) does not equal total (${total.toFixed(2)}).`);
    }

    const party = this.resolveParty(data);
    const partyAccount = this.resolveMatchedAccount(row.matchResults);
    const isPurchase = /purchase|bill|expense|payable|inward/.test(transactionType);
    const isCreditNote = /credit|crn/.test(documentType) || /credit/.test(transactionType);
    const isDebitNote = /debit|dbn/.test(documentType) || /debit/.test(transactionType);

    if (!party) {
      warnings.push('Customer/vendor could not be identified from the normalized row.');
    }
    if (!partyAccount?.accountId) {
      warnings.push('No ledger account is currently linked to the matched party; posting requires account mapping.');
    }

    const partySide: 'DEBIT' | 'CREDIT' = isPurchase ? 'CREDIT' : 'DEBIT';
    const oppositeSide: 'DEBIT' | 'CREDIT' = partySide === 'DEBIT' ? 'CREDIT' : 'DEBIT';
    const signMultiplier = isCreditNote || isDebitNote ? -1 : 1;
    const partyAmount = this.money(total * signMultiplier);

    if (partyAmount >= 0) {
      lines.push({
        accountRole: isPurchase ? 'VENDOR_PAYABLE' : 'CUSTOMER_RECEIVABLE',
        side: partySide,
        amount: Math.abs(partyAmount),
        accountId: partyAccount?.accountId,
        accountName: partyAccount?.accountName ?? party,
      });
    } else {
      lines.push({
        accountRole: isPurchase ? 'VENDOR_PAYABLE' : 'CUSTOMER_RECEIVABLE',
        side: oppositeSide,
        amount: Math.abs(partyAmount),
        accountId: partyAccount?.accountId,
        accountName: partyAccount?.accountName ?? party,
      });
    }

    const mainRole = isPurchase ? 'PURCHASE_EXPENSE' : 'SALES_INCOME';
    const mainSide = isPurchase ? 'DEBIT' : 'CREDIT';
    const mainAmount = Math.abs(taxable);
    if (mainAmount > 0) {
      lines.push({ accountRole: mainRole, side: mainSide, amount: mainAmount });
    }
    if (cgst > 0) lines.push({ accountRole: isPurchase ? 'INPUT_CGST' : 'OUTPUT_CGST', side: isPurchase ? 'DEBIT' : 'CREDIT', amount: cgst });
    if (sgst > 0) lines.push({ accountRole: isPurchase ? 'INPUT_SGST' : 'OUTPUT_SGST', side: isPurchase ? 'DEBIT' : 'CREDIT', amount: sgst });
    if (igst > 0) lines.push({ accountRole: isPurchase ? 'INPUT_IGST' : 'OUTPUT_IGST', side: isPurchase ? 'DEBIT' : 'CREDIT', amount: igst });

    const debitTotal = this.money(lines.filter((line) => line.side === 'DEBIT').reduce((sum, line) => sum + line.amount, 0));
    const creditTotal = this.money(lines.filter((line) => line.side === 'CREDIT').reduce((sum, line) => sum + line.amount, 0));
    const balanced = Math.abs(debitTotal - creditTotal) <= EPSILON;
    if (!balanced) errors.push(`Journal is unbalanced: debit ${debitTotal.toFixed(2)}, credit ${creditTotal.toFixed(2)}.`);

    if (row.status === 'DUPLICATE') warnings.push('This row was previously marked as a duplicate and must not be posted automatically.');

    return {
      rowId: row.id,
      rowNumber: row.rowNumber,
      status: row.status === 'DUPLICATE' ? 'DUPLICATE' : errors.length ? 'ERROR' : warnings.length ? 'WARNING' : 'VALID',
      errors: [...new Set(errors)],
      warnings: [...new Set(warnings)],
      lines,
      debitTotal,
      creditTotal,
      balanced,
    };
  }

  private resolveParty(data: Record<string, unknown>): string | null {
    return this.text(data.customer_name) || this.text(data.vendor_name) || null;
  }

  private resolveMatchedAccount(value: Prisma.JsonValue | null): { accountId?: string; accountName?: string } | null {
    const root = this.asObject(value);
    const candidates = [root.account, root.matchedAccount, root.customer, root.vendor];
    for (const candidate of candidates) {
      const object = this.asObject(candidate);
      const accountId = this.text(object.accountId);
      const accountName = this.text(object.accountName);
      if (accountId || accountName) return { accountId: accountId || undefined, accountName: accountName || undefined };
    }
    return null;
  }

  private asObject(value: Prisma.JsonValue | null | undefined): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  }

  private asStringArray(value: Prisma.JsonValue | null | undefined): string[] {
    if (Array.isArray(value)) return value.map(String);
    const object = this.asObject(value);
    if (typeof object.message === 'string') return [object.message];
    return [];
  }

  private text(value: unknown): string {
    return value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  }

  private number(value: unknown): number | null {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const parsed = Number(String(value).replace(/[₹$€£,\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private money(value: number): number {
    return Number(value.toFixed(2));
  }
}
