import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

interface NormalizedRow {
  invoice_number?: unknown;
  invoice_date?: unknown;
  customer_name?: unknown;
  vendor_name?: unknown;
  transaction_type?: unknown;
  total_amount?: unknown;
}

interface DuplicateCandidate {
  rowId: string;
  rowNumber: number;
  reasons: string[];
  score: number;
}

@Injectable()
export class DuplicateService {
  constructor(private readonly prisma: PrismaService) {}

  async detectDuplicates(importId: string, companyId: string) {
    const imported = await this.prisma.dataImport.findFirst({
      where: { id: importId, companyId },
      select: { id: true, status: true, totalRows: true },
    });
    if (!imported) throw new NotFoundException('Import session not found.');

    const rows = await this.prisma.dataImportRow.findMany({
      where: { importId },
      select: { id: true, rowNumber: true, normalizedData: true, rawData: true },
      orderBy: { rowNumber: 'asc' },
    });

    const seen = new Map<string, { id: string; rowNumber: number }[]>();
    const results = new Map<string, DuplicateCandidate[]>();

    for (const row of rows) {
      const data = (row.normalizedData ?? row.rawData ?? {}) as NormalizedRow;
      const key = this.exactKey(data);
      if (!key) continue;
      const existing = seen.get(key) ?? [];
      results.set(row.id, existing.map((candidate) => ({
        rowId: candidate.id,
        rowNumber: candidate.rowNumber,
        reasons: ['exact invoice signature'],
        score: 1,
      })));
      existing.push({ id: row.id, rowNumber: row.rowNumber });
      seen.set(key, existing);
    }

    // A second pass catches likely duplicates where the invoice number is the same
    // but one or more contextual fields differ slightly.
    const indexed = rows.map((row) => ({
      id: row.id,
      rowNumber: row.rowNumber,
      data: (row.normalizedData ?? row.rawData ?? {}) as NormalizedRow,
    }));

    for (let i = 0; i < indexed.length; i++) {
      for (let j = i + 1; j < indexed.length; j++) {
        const score = this.similarityScore(indexed[i].data, indexed[j].data);
        if (score < 0.8) continue;
        const reason = this.similarityReasons(indexed[i].data, indexed[j].data);
        this.addCandidate(results, indexed[i].id, {
          rowId: indexed[j].id,
          rowNumber: indexed[j].rowNumber,
          reasons: reason,
          score,
        });
        this.addCandidate(results, indexed[j].id, {
          rowId: indexed[i].id,
          rowNumber: indexed[i].rowNumber,
          reasons: reason,
          score,
        });
      }
    }

    let duplicateRows = 0;
    let warningRows = 0;
    let errorRows = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const candidates = results.get(row.id) ?? [];
        const exact = candidates.some((candidate) => candidate.score >= 0.999);
        const strong = candidates.some((candidate) => candidate.score >= 0.9);
        const status = exact ? 'DUPLICATE' : strong ? 'WARNING' : 'PENDING';
        if (status === 'DUPLICATE') duplicateRows++;
        if (status === 'WARNING') warningRows++;
        await tx.dataImportRow.update({
          where: { id: row.id },
          data: {
            status,
            validationErrors: status === 'DUPLICATE'
              ? ({ code: 'DUPLICATE', message: 'This row matches another imported transaction.' } as Prisma.InputJsonValue)
              : undefined,
            matchResults: {
              duplicateCandidates: candidates,
              duplicateStatus: status,
            } as Prisma.InputJsonValue,
          },
        });
      }

      await tx.dataImport.update({
        where: { id: importId },
        data: {
          duplicateRows,
          warningRows,
          errorRows,
          status: errorRows > 0 || duplicateRows > 0 ? 'VALIDATING' : 'READY',
        },
      });
    });

    return {
      importId,
      totalRows: rows.length,
      duplicateRows,
      warningRows,
      errorRows,
      readyForPosting: duplicateRows === 0 && errorRows === 0,
    };
  }

  async getDuplicates(importId: string, companyId: string) {
    const imported = await this.prisma.dataImport.findFirst({
      where: { id: importId, companyId },
      select: { id: true },
    });
    if (!imported) throw new NotFoundException('Import session not found.');

    const rows = await this.prisma.dataImportRow.findMany({
      where: { importId, status: { in: ['DUPLICATE', 'WARNING'] } },
      select: {
        id: true,
        rowNumber: true,
        status: true,
        normalizedData: true,
        matchResults: true,
        validationErrors: true,
      },
      orderBy: { rowNumber: 'asc' },
    });
    return { importId, rows };
  }

  private exactKey(data: NormalizedRow): string | null {
    const invoice = this.text(data.invoice_number);
    if (!invoice) return null;
    const party = this.text(data.customer_name) || this.text(data.vendor_name) || '';
    const date = this.text(data.invoice_date) || '';
    const type = this.text(data.transaction_type) || '';
    return [type, invoice, party, date].join('|');
  }

  private similarityScore(a: NormalizedRow, b: NormalizedRow): number {
    const invoiceA = this.text(a.invoice_number);
    const invoiceB = this.text(b.invoice_number);
    if (!invoiceA || !invoiceB || invoiceA !== invoiceB) return 0;

    let score = 0.65;
    const partyA = this.text(a.customer_name) || this.text(a.vendor_name);
    const partyB = this.text(b.customer_name) || this.text(b.vendor_name);
    if (partyA && partyB && partyA === partyB) score += 0.15;
    if (this.text(a.invoice_date) && this.text(a.invoice_date) === this.text(b.invoice_date)) score += 0.1;
    if (this.text(a.transaction_type) && this.text(a.transaction_type) === this.text(b.transaction_type)) score += 0.05;
    if (this.number(a.total_amount) !== null && this.number(a.total_amount) === this.number(b.total_amount)) score += 0.05;
    return Math.min(score, 1);
  }

  private similarityReasons(a: NormalizedRow, b: NormalizedRow): string[] {
    const reasons = ['same invoice number'];
    const partyA = this.text(a.customer_name) || this.text(a.vendor_name);
    const partyB = this.text(b.customer_name) || this.text(b.vendor_name);
    if (partyA && partyA === partyB) reasons.push('same party');
    if (this.text(a.invoice_date) && this.text(a.invoice_date) === this.text(b.invoice_date)) reasons.push('same invoice date');
    if (this.number(a.total_amount) !== null && this.number(a.total_amount) === this.number(b.total_amount)) reasons.push('same total amount');
    return reasons;
  }

  private addCandidate(map: Map<string, DuplicateCandidate[]>, rowId: string, candidate: DuplicateCandidate) {
    const list = map.get(rowId) ?? [];
    const existing = list.find((item) => item.rowId === candidate.rowId);
    if (!existing) list.push(candidate);
    else if (candidate.score > existing.score) {
      existing.score = candidate.score;
      existing.reasons = [...new Set([...existing.reasons, ...candidate.reasons])];
    }
    map.set(rowId, list);
  }

  private text(value: unknown): string {
    return value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  }

  private number(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
}
