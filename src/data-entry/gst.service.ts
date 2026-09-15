import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

const MONEY_EPSILON = 0.02;
const RATE_EPSILON = 0.01;

export type GstResult = {
  taxableAmount: number;
  gstRate: number;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalTax: number;
  calculatedTotal: number;
  supplyType: 'INTRA_STATE' | 'INTER_STATE' | 'EXPORT' | 'SEZ' | 'UNKNOWN';
  taxability: 'TAXABLE' | 'EXEMPT' | 'NIL_RATED' | 'NON_GST' | 'ZERO_RATED';
  rcm: boolean;
  taxInclusive: boolean;
  imported: {
    taxableAmount: number | null;
    gstRate: number | null;
    cgstRate: number | null;
    sgstRate: number | null;
    igstRate: number | null;
    cgstAmount: number | null;
    sgstAmount: number | null;
    igstAmount: number | null;
    totalAmount: number | null;
  };
  status: 'VALID' | 'WARNING' | 'ERROR';
  issues: string[];
  warnings: string[];
};

@Injectable()
export class GstService {
  constructor(private readonly prisma: PrismaService) {}

  async validateImport(importId: string, companyId: string) {
    const imported = await this.prisma.dataImport.findFirst({
      where: { id: importId, companyId },
      select: {
        id: true,
        rows: {
          orderBy: { rowNumber: 'asc' },
          select: { id: true, normalizedData: true },
        },
      },
    });
    if (!imported) throw new NotFoundException('Import session not found.');

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { stateCode: true },
    });
    if (!company) throw new NotFoundException('Company not found.');

    let validRows = 0;
    let warningRows = 0;
    let errorRows = 0;

    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < imported.rows.length; i += 500) {
        for (const row of imported.rows.slice(i, i + 500)) {
          const result = this.calculate(
            (row.normalizedData ?? {}) as Record<string, unknown>,
            company.stateCode,
          );
          const status = result.status;
          if (status === 'VALID') validRows++;
          else if (status === 'WARNING') warningRows++;
          else errorRows++;

          await tx.dataImportRow.update({
            where: { id: row.id },
            data: {
              calculatedGst: result as unknown as Prisma.InputJsonValue,
              validationErrors: result.issues.length
                ? (result.issues as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
              status,
            },
          });
        }
      }

      await tx.dataImport.update({
        where: { id: importId },
        data: {
          status: errorRows > 0 ? 'VALIDATING' : 'READY',
          processedRows: imported.rows.length,
          validRows,
          warningRows,
          errorRows,
        },
      });
    });

    return {
      importId,
      totalRows: imported.rows.length,
      validRows,
      warningRows,
      errorRows,
      status: errorRows > 0 ? 'VALIDATING' : 'READY',
    };
  }

  calculate(data: Record<string, unknown>, companyStateCode?: string | null): GstResult {
    const issues: string[] = [];
    const warnings: string[] = [];

    const rate = this.number(data.gst_rate) ?? 0;
    const taxInclusive = this.boolean(data.gst_inclusive);
    const rcm = this.boolean(data.rcm);
    const taxability = this.resolveTaxability(data.taxability, data.transaction_type, rate);
    const documentType = this.normalizeCode(data.document_type ?? data.transaction_type);
    const placeOfSupply = data.place_of_supply;
    const supplyType = this.resolveSupplyType(companyStateCode, placeOfSupply, data.transaction_type);

    let taxable = this.number(data.taxable_amount);
    const importedTotal = this.number(data.total_amount);

    if (taxable === null && taxInclusive && importedTotal !== null && rate > 0 && taxability === 'TAXABLE') {
      taxable = this.money(importedTotal / (1 + rate / 100));
      warnings.push('Taxable amount was derived from the tax-inclusive total.');
    }

    if (taxable === null) {
      issues.push('Taxable amount is missing or invalid.');
      taxable = 0;
    }

    if (rate < 0 || rate > 100) {
      issues.push(`GST rate ${rate} is outside the valid 0-100% range.`);
    }

    if (taxability !== 'TAXABLE') {
      if (rate !== 0) warnings.push(`Taxability is ${taxability}; GST rate is forced to 0 for calculation.`);
    }

    const effectiveRate = taxability === 'TAXABLE' ? rate : 0;
    let cgstRate = 0;
    let sgstRate = 0;
    let igstRate = 0;

    if (effectiveRate > 0) {
      if (supplyType === 'INTRA_STATE') {
        cgstRate = effectiveRate / 2;
        sgstRate = effectiveRate / 2;
      } else if (supplyType === 'INTER_STATE' || supplyType === 'EXPORT') {
        igstRate = effectiveRate;
      } else if (supplyType === 'SEZ') {
        // SEZ supplies can be with or without payment; taxability/treatment decides whether tax is charged.
        if (this.isWithoutPayment(data)) {
          warnings.push('SEZ supply without payment is treated as zero-rated for this calculation.');
        } else {
          igstRate = effectiveRate;
        }
      } else {
        warnings.push('Place of supply could not be resolved; CGST/SGST vs IGST cannot be determined automatically.');
      }
    }

    const calculatedCgst = this.money(taxable * cgstRate / 100);
    const calculatedSgst = this.money(taxable * sgstRate / 100);
    const calculatedIgst = this.money(taxable * igstRate / 100);
    const totalTax = this.money(calculatedCgst + calculatedSgst + calculatedIgst);
    const calculatedTotal = this.money(taxable + totalTax);

    const importedCgst = this.number(data.cgst_amount);
    const importedSgst = this.number(data.sgst_amount);
    const importedIgst = this.number(data.igst_amount);
    const importedCgstRate = this.number(data.cgst_rate);
    const importedSgstRate = this.number(data.sgst_rate);
    const importedIgstRate = this.number(data.igst_rate);
    const importedTaxable = this.number(data.taxable_amount);

    // Credit/debit notes are intentionally validated less aggressively at component level.
    // The official e-invoice validation rules do not require the same tax-value check for CRN/DBN.
    const isNote = documentType === 'CRN' || documentType === 'DBN' || /credit|debit/.test(documentType);
    if (!isNote) {
      this.compareMoney('CGST amount', importedCgst, calculatedCgst, issues, warnings);
      this.compareMoney('SGST amount', importedSgst, calculatedSgst, issues, warnings);
      this.compareMoney('IGST amount', importedIgst, calculatedIgst, issues, warnings);
      this.compareRate('CGST rate', importedCgstRate, cgstRate, issues);
      this.compareRate('SGST rate', importedSgstRate, sgstRate, issues);
      this.compareRate('IGST rate', importedIgstRate, igstRate, issues);
    } else {
      warnings.push('Credit/debit note detected; component tax amounts are not hard-failed against the standard invoice formula.');
    }

    if (importedTotal !== null && Math.abs(importedTotal - calculatedTotal) > MONEY_EPSILON) {
      if (isNote || rcm || taxInclusive) {
        warnings.push(`Total amount differs from the standard calculated total: imported ${importedTotal.toFixed(2)}, calculated ${calculatedTotal.toFixed(2)}.`);
      } else {
        issues.push(`Total amount mismatch: imported ${importedTotal.toFixed(2)}, calculated ${calculatedTotal.toFixed(2)}.`);
      }
    }

    if (supplyType === 'INTRA_STATE' && importedIgst !== null && Math.abs(importedIgst) > MONEY_EPSILON) {
      issues.push('IGST amount is present for an intra-state transaction.');
    }
    if ((supplyType === 'INTER_STATE' || supplyType === 'EXPORT') &&
        ((importedCgst !== null && Math.abs(importedCgst) > MONEY_EPSILON) ||
         (importedSgst !== null && Math.abs(importedSgst) > MONEY_EPSILON))) {
      issues.push('CGST/SGST amount is present for an inter-state/export transaction.');
    }

    if (taxability !== 'TAXABLE') {
      const importedTax = (importedCgst ?? 0) + (importedSgst ?? 0) + (importedIgst ?? 0);
      if (Math.abs(importedTax) > MONEY_EPSILON) {
        issues.push(`Tax amount is present even though taxability is ${taxability}.`);
      }
    }

    if (rcm) warnings.push('Reverse charge (RCM) is flagged. Accounting liability should be posted separately by the accounting engine.');
    if (taxInclusive) warnings.push('GST-inclusive pricing was detected; taxable value is treated as the tax-exclusive base for calculation.');

    const status = issues.length ? 'ERROR' : warnings.length ? 'WARNING' : 'VALID';
    return {
      taxableAmount: this.money(taxable),
      gstRate: this.money(effectiveRate),
      cgstRate: this.money(cgstRate),
      sgstRate: this.money(sgstRate),
      igstRate: this.money(igstRate),
      cgstAmount: calculatedCgst,
      sgstAmount: calculatedSgst,
      igstAmount: calculatedIgst,
      totalTax,
      calculatedTotal,
      supplyType,
      taxability,
      rcm,
      taxInclusive,
      imported: {
        taxableAmount: importedTaxable,
        gstRate: this.number(data.gst_rate),
        cgstRate: importedCgstRate,
        sgstRate: importedSgstRate,
        igstRate: importedIgstRate,
        cgstAmount: importedCgst,
        sgstAmount: importedSgst,
        igstAmount: importedIgst,
        totalAmount: importedTotal,
      },
      status,
      issues,
      warnings,
    };
  }

  private resolveTaxability(value: unknown, transactionType: unknown, rate: number): GstResult['taxability'] {
    const text = this.normalizeCode(value ?? '').toLowerCase();
    if (/non.?gst|non gst/.test(text)) return 'NON_GST';
    if (/exempt/.test(text)) return 'EXEMPT';
    if (/nil/.test(text)) return 'NIL_RATED';
    if (/zero.?rated|zero rated/.test(text)) return 'ZERO_RATED';

    const tx = this.normalizeCode(transactionType).toLowerCase();
    if (/expwop|export.*without|sezwop|sez.*without/.test(tx)) return 'ZERO_RATED';
    return rate === 0 ? 'NIL_RATED' : 'TAXABLE';
  }

  private resolveSupplyType(
    companyStateCode: string | null | undefined,
    placeOfSupply: unknown,
    transactionType: unknown,
  ): GstResult['supplyType'] {
    const tx = this.normalizeCode(transactionType).toLowerCase();
    if (/expwp|expwop|export/.test(tx)) return 'EXPORT';
    if (/sezwp|sezwop|sez/.test(tx)) return 'SEZ';

    if (!companyStateCode || placeOfSupply === null || placeOfSupply === undefined) return 'UNKNOWN';
    const supplier = this.stateCode(companyStateCode);
    const recipient = this.stateCode(placeOfSupply);
    if (!supplier || !recipient) return 'UNKNOWN';
    return supplier === recipient ? 'INTRA_STATE' : 'INTER_STATE';
  }

  private isWithoutPayment(data: Record<string, unknown>): boolean {
    const tx = this.normalizeCode(data.transaction_type).toLowerCase();
    return /wop|without.*payment|no.*payment/.test(tx) || /wop|without.*payment/.test(this.normalizeCode(data.taxability).toLowerCase());
  }

  private stateCode(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim().toUpperCase();
    const gstin = text.match(/^(\d{2})[A-Z0-9]{13}$/);
    if (gstin) return gstin[1];
    const numeric = text.match(/^\d{1,2}$/);
    if (numeric) return numeric[1].padStart(2, '0');
    const codePrefix = text.match(/^(\d{2})\b/);
    return codePrefix ? codePrefix[1] : null;
  }

  private compareMoney(label: string, imported: number | null, calculated: number, issues: string[], warnings: string[]) {
    if (imported === null) return;
    const difference = Math.abs(imported - calculated);
    if (difference > MONEY_EPSILON) {
      issues.push(`${label} mismatch: imported ${imported.toFixed(2)}, calculated ${calculated.toFixed(2)}.`);
    } else if (difference > 0.005) {
      warnings.push(`${label} differs slightly because of rounding.`);
    }
  }

  private compareRate(label: string, imported: number | null, calculated: number, issues: string[]) {
    if (imported === null) return;
    if (Math.abs(imported - calculated) > RATE_EPSILON) {
      issues.push(`${label} mismatch: imported ${imported}, calculated ${calculated}.`);
    }
  }

  private boolean(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    const text = this.normalizeCode(value).toLowerCase();
    return ['true', 'yes', 'y', '1', 'on'].includes(text);
  }

  private normalizeCode(value: unknown): string {
    return String(value ?? '')
      .normalize('NFKC')
      .trim()
      .toUpperCase()
      .replace(/[._\-/\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private number(value: unknown): number | null {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const parsed = Number(String(value).replace(/[₹$€£,\s]/g, '').replace(/%/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private money(value: number): number {
    return Number(value.toFixed(2));
  }
}
