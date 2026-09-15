import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export type EntityKind = 'customer' | 'vendor' | 'product';

type Candidate = {
  id: string;
  name: string;
  gstin?: string | null;
  sku?: string | null;
  hsnSac?: string | null;
  score: number;
  reasons: string[];
};

@Injectable()
export class EntityMatchingService {
  constructor(private readonly prisma: PrismaService) {}

  async matchImport(importId: string, companyId: string) {
    const imported = await this.prisma.dataImport.findFirst({
      where: { id: importId, companyId },
      select: {
        id: true,
        status: true,
        rows: {
          orderBy: { rowNumber: 'asc' },
          select: { id: true, rowNumber: true, normalizedData: true, rawData: true },
        },
      },
    });
    if (!imported) throw new NotFoundException('Import session not found.');
    if (!['VALIDATING', 'READY', 'MAPPING'].includes(imported.status)) {
      throw new BadRequestException(`Entity matching is not allowed while import status is ${imported.status}.`);
    }

    const [customers, vendors, products] = await Promise.all([
      this.prisma.customer.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true, gstin: true, stateCode: true } }),
      this.prisma.vendor.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true, gstin: true, stateCode: true } }),
      this.prisma.product.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true, sku: true, hsnSac: true } }),
    ]);

    const results = imported.rows.map((row) => {
      const data = {
        ...((row.rawData ?? {}) as Record<string, unknown>),
        ...((row.normalizedData ?? {}) as Record<string, unknown>),
      };
      const customer = this.findBest(data.customer_name, customers.map((x) => ({ ...x })), 'customer', data);
      const vendor = this.findBest(data.vendor_name, vendors.map((x) => ({ ...x })), 'vendor', data);
      const product = this.findBest(data.item_name, products.map((x) => ({ ...x })), 'product', data);
      return {
        rowId: row.id,
        rowNumber: row.rowNumber,
        customer,
        vendor,
        product,
      };
    });

    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < imported.rows.length; i += 500) {
        const batch = imported.rows.slice(i, i + 500);
        await Promise.all(batch.map((row, index) =>
          tx.dataImportRow.update({
            where: { id: row.id },
            data: { matchResults: results[i + index] as unknown as Prisma.InputJsonValue },
          }),
        ));
      }
    });

    return {
      importId,
      rows: results,
      summary: this.summarize(results),
    };
  }

  async getMatches(importId: string, companyId: string) {
    const imported = await this.prisma.dataImport.findFirst({
      where: { id: importId, companyId },
      select: {
        id: true,
        status: true,
        rows: {
          orderBy: { rowNumber: 'asc' },
          select: { id: true, rowNumber: true, matchResults: true },
        },
      },
    });
    if (!imported) throw new NotFoundException('Import session not found.');
    return {
      importId: imported.id,
      status: imported.status,
      rows: imported.rows.map((row) => ({ rowId: row.id, rowNumber: row.rowNumber, ...(row.matchResults as object ?? {}) })),
    };
  }

  private findBest(
    value: unknown,
    candidates: Array<Record<string, string | null>>,
    kind: EntityKind,
    row: Record<string, unknown>,
  ): Candidate | null {
    const query = this.normalize(value);
    const queryGstin = this.normalizeGstin(
      row.gstin ?? row.customer_gstin ?? row.vendor_gstin ?? row.GSTIN ?? row['Customer GSTIN'] ?? row['Party GSTIN']
    );
    if (!query && !queryGstin) return null;

    const querySku = this.normalize(row.sku);
    const queryHsn = this.normalize(row.hsn_sac);

    const scored = candidates.map((candidate) => {
      const name = this.normalize(candidate.name);
      const candidateGstin = this.normalizeGstin(candidate.gstin);
      const candidateSku = this.normalize(candidate.sku);
      const candidateHsn = this.normalize(candidate.hsnSac);
      const reasons: string[] = [];
      let score = this.nameSimilarity(query, name);

      if (query === name) { score = Math.max(score, 1); reasons.push('exact_name'); }
      else if (name.includes(query) || query.includes(name)) { score = Math.max(score, 0.9); reasons.push('contains_name'); }
      if (queryGstin && candidateGstin && queryGstin === candidateGstin) { score = Math.max(score, 0.99); reasons.push('exact_gstin'); }
      if (kind === 'product' && querySku && candidateSku && querySku === candidateSku) { score = Math.max(score, 0.99); reasons.push('exact_sku'); }
      if (kind === 'product' && queryHsn && candidateHsn && queryHsn === candidateHsn) { score = Math.max(score, Math.min(0.96, score + 0.12)); reasons.push('exact_hsn'); }

      return {
        id: candidate.id!,
        name: candidate.name!,
        gstin: candidate.gstin,
        sku: candidate.sku,
        hsnSac: candidate.hsnSac,
        score: Number(score.toFixed(4)),
        reasons,
      };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 0.72) return null;
    const second = scored[1];
    const margin = second ? best.score - second.score : best.score;
    const confidence = best.score >= 0.99 && margin >= 0.05 ? 'high' : margin >= 0.08 ? 'medium' : 'ambiguous';
    return { ...best, confidence, alternatives: scored.slice(1, 4).map(({ id, name, score, reasons }) => ({ id, name, score, reasons })) } as Candidate & { confidence: string; alternatives: unknown[] };
  }

  private nameSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const aTokens = new Set(a.split(' '));
    const bTokens = new Set(b.split(' '));
    const intersection = [...aTokens].filter((x) => bTokens.has(x)).length;
    const union = new Set([...aTokens, ...bTokens]).size;
    const tokenScore = union ? intersection / union : 0;
    const prefix = a.startsWith(b) || b.startsWith(a) ? 0.1 : 0;
    return Math.min(0.95, tokenScore * 0.85 + prefix);
  }

  private normalize(value: unknown): string {
    return String(value ?? '').normalize('NFKC').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ');
  }

  private normalizeGstin(value: unknown): string {
    return String(value ?? '').toUpperCase().replace(/\s+/g, '').trim();
  }

  private summarize(results: Array<Record<string, unknown>>) {
    const summary = { rows: results.length, customerMatched: 0, vendorMatched: 0, productMatched: 0, ambiguous: 0 };
    for (const result of results) {
      for (const key of ['customer', 'vendor', 'product']) {
        const match = result[key] as { confidence?: string } | null;
        if (match) {
          if (key === 'customer') summary.customerMatched++;
          if (key === 'vendor') summary.vendorMatched++;
          if (key === 'product') summary.productMatched++;
          if (match.confidence === 'ambiguous') summary.ambiguous++;
        }
      }
    }
    return summary;
  }
}
