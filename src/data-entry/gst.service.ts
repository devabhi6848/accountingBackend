import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
  supplyType: 'INTRA_STATE' | 'INTER_STATE' | 'UNKNOWN';
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
        companyId: true,
        status: true,
        rows: {
          orderBy: { rowNumber: 'asc' },
          select: { id: true, rowNumber: true, normalizedData: true },
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
        const batch = imported.rows.slice(i, i + 500);
        for (const row of batch) {
          const result = this.calculate((row.normalizedData ?? {}) as Record<string, unknown>, company.stateCode);
          const rowStatus = result.status === 'ERROR' ? 'ERROR' : result.status === 'WARNING' ? 'WARNING' : 'VALID';
          if (rowStatus === 'VALID') validRows++;
          else if (rowStatus === 'WARNING') warningRows++;
          else errorRows++;

          await tx.dataImportRow.update({
            where: { id: row.id },
            data: {
              calculatedGst: result as unknown as Prisma.InputJsonValue,
              validationErrors: result.issues.length
                ? result.issues as unknown as Prisma.InputJsonValue
                : null,
              status: rowStatus,
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
    const taxable = this.number(data.taxable_amount);
    const rate = this.number(data.gst_rate);
    const importedCgstRate = this.number(data.cgst_rate);
    const importedSgstRate = this.number(data.sgst_rate);
    const importedIgstRate = this.number(data.igst_rate);
    const importedCgst = this.number(data.cgst_amount);
    const importedSgst = this.number(data.sgst_amount);
    const importedIgst = this.number(data.igst_amount);
    const importedTotal = this.number(data.total_amount);
    const importedTaxable = taxable;

    const issues: string[] = [];
    const warnings: string[] = [];

    if (taxable === null) {
      issues.push('Taxable amount is missing or invalid.');
    }
    if (rate === null) {
      issues.push('GST rate is missing or invalid.');
    }

    const supplyType = this.resolveSupplyType(companyStateCode, data.place_of_supply);
    let cgstRate = 0;
    let sgstRate = 0;
    let igstRate = 0;

    if (rate !== null) {
      if (supplyType === 'INTRA_STATE') {
        cgstRate = rate / 2;
        sgstRate = rate / 2;
      } else if (supplyType === 'INTER_STATE') {
        igstRate = rate;
      } else {
        warnings.push('Place of supply could not be resolved; CGST/SGST vs IGST cannot be determined automatically.');
      }
    }

    const cgstAmount = this.money((taxable ?? 0) * cgstRate / 100);
    const sgstAmount = this.money((taxable ?? 0) * sgstRate / 100);
    const igstAmount = this.money((taxable ?? 0) * igstRate / 100);
    const totalTax = this.money(cgstAmount + sgstAmount + igstAmount);
    const calculatedTotal = this.money((taxable ?? 0) + totalTax);

    this.compareMoney('CGST amount', importedCgst, cgstAmount, issues, warnings);
    this.compareMoney('SGST amount', importedSgst, sgstAmount, issues, warnings);
    this.compareMoney('IGST amount', importedIgst, igstAmount, issues, warnings);
    this.compareRate('CGST rate', importedCgstRate, cgstRate, issues, warnings);
    this.compareRate('SGST rate', importedSgstRate, sgstRate, issues, warnings);
    this.compareRate('IGST rate', importedIgstRate, igstRate, issues, warnings);

    if (importedTotal !== null && Math.abs(importedTotal - calculatedTotal) > MONEY_EPSILON) {
      issues.push(`Total amount mismatch: imported ${importedTotal.toFixed(2)}, calculated ${calculatedTotal.toFixed(2)}.`);
    }

    if (supplyType === 'INTRA_STATE' && importedIgst !== null && Math.abs(importedIgst) > MONEY_EPSILON) {
      issues.push('IGST amount is present for an intra-state transaction.');
    }
    if (supplyType === 'INTER_STATE' && ((importedCgst !== null && Math.abs(importedCgst) > MONEY_EPSILON) || (importedSgst !== null && Math.abs(importedSgst) > MONEY_EPSILON))) {
      issues.push('CGST/SGST amount is present for an inter-state transaction.');
    }

    const status = issues.length ? 'ERROR' : warnings.length ? 'WARNING' : 'VALID';
    return {
      taxableAmount: this.money(taxable ?? 0),
      gstRate: this.money(rate ?? 0),
      cgstRate: this.money(cgstRate),
      sgstRate: this.money(sgstRate),
      igstRate: this.money(igstRate),
      cgstAmount,
      sgstAmount,
      igstAmount,
      totalTax,
      calculatedTotal,
      imported: {
        taxableAmount: importedTaxable,
        gstRate: rate,
        cgstRate: importedCgstRate,
        sgstRate: importedSgstRate,
        igstRate: importedIgstRate,
        cgstAmount: importedCgst,
        sgstAmount: importedSgst,
        igstAmount: importedIgst,
        totalAmount: importedTotal,
      },
      supplyType,
      status,
      issues,
      warnings,
    };
  }

  private resolveSupplyType(companyStateCode?: string | null, placeOfSupply: unknown): GstResult['supplyType'] {
    if (!companyStateCode || placeOfSupply === null || placeOfSupply === undefined) return 'UNKNOWN';
    const supplier = this.stateCode(companyStateCode);
    const recipient = this.stateCode(placeOfSupply);
    if (!supplier || !recipient) return 'UNKNOWN';
    return supplier === recipient ? 'INTRA_STATE' : 'INTER_STATE';
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
    if (Math.abs(imported - calculated) > MONEY_EPSILON) {
      issues.push(`${label} mismatch: imported ${imported.toFixed(2)}, calculated ${calculated.toFixed(2)}.`);
    } else if (Math.abs(imported - calculated) > 0.005) {
      warnings.push(`${label} differs slightly because of rounding.`);
    }
  }

  private compareRate(label: string, imported: number | null, calculated: number, issues: string[], warnings: string[]) {
    if (imported === null) return;
    if (Math.abs(imported - calculated) > RATE_EPSILON) {
      issues.push(`${label} mismatch: imported ${imported}, calculated ${calculated}.`);
    }
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
