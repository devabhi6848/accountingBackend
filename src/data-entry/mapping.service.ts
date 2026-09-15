import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CANONICAL_IMPORT_FIELDS, CanonicalImportField } from '../config/import.constants';
import { PrismaService } from '../database/prisma.service';
import { ImportColumnMappingDto, SaveImportMappingDto } from './dto/mapping.dto';

const RATE_FIELDS = new Set<CanonicalImportField>(['gst_rate', 'cgst_rate', 'sgst_rate', 'igst_rate']);
const NUMERIC_FIELDS = new Set<CanonicalImportField>([
  'quantity', 'rate', 'discount', 'taxable_amount', 'gst_rate', 'cgst_rate', 'sgst_rate',
  'igst_rate', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
]);
const DATE_FIELDS = new Set<CanonicalImportField>(['invoice_date']);

@Injectable()
export class MappingService {
  constructor(private readonly prisma: PrismaService) {}

  async getMapping(importId: string, companyId: string) {
    const imported = await this.getImport(importId, companyId);
    const mappings = imported.mappings.map((mapping) => ({
      id: mapping.id,
      sourceColumn: mapping.sourceColumn,
      targetField: mapping.targetField,
      confidence: mapping.confidence === null ? null : Number(mapping.confidence),
      isConfirmed: mapping.isConfirmed,
    }));

    return {
      importId: imported.id,
      status: imported.status,
      columns: Array.isArray(imported.detectedHeaders) ? imported.detectedHeaders : [],
      mappings,
      canonicalFields: [...CANONICAL_IMPORT_FIELDS],
    };
  }

  async saveMapping(importId: string, companyId: string, dto: SaveImportMappingDto) {
    const imported = await this.getImport(importId, companyId);
    const headers = new Set(
      Array.isArray(imported.detectedHeaders) ? imported.detectedHeaders.map(String) : [],
    );
    this.validateMappings(dto.mappings, headers);

    await this.prisma.$transaction(async (tx) => {
      for (const mapping of dto.mappings) {
        const targetField = mapping.targetField ?? null;
        const existing = imported.mappings.find((m) => m.sourceColumn === mapping.sourceColumn);
        const suggestionConfidence = existing?.confidence === null || existing?.confidence === undefined
          ? null
          : Number(existing.confidence);

        await tx.columnMapping.upsert({
          where: {
            importId_sourceColumn: {
              importId,
              sourceColumn: mapping.sourceColumn,
            },
          },
          create: {
            importId,
            sourceColumn: mapping.sourceColumn,
            targetField,
            confidence: suggestionConfidence,
            isConfirmed: mapping.confirmed ?? false,
          },
          update: {
            targetField,
            isConfirmed: mapping.confirmed ?? false,
          },
        });
      }

      await tx.dataImport.update({
        where: { id: importId },
        data: { status: 'MAPPING' },
      });
    });

    return this.getMapping(importId, companyId);
  }

  async confirmMapping(importId: string, companyId: string) {
    const imported = await this.getImport(importId, companyId);
    const mappings = imported.mappings.filter((m) => m.targetField);
    if (!mappings.length) {
      throw new BadRequestException('At least one column must be mapped before confirmation.');
    }

    const targets = new Set<string>();
    for (const mapping of mappings) {
      if (targets.has(mapping.targetField!)) {
        throw new BadRequestException(`Target field "${mapping.targetField}" is mapped more than once.`);
      }
      targets.add(mapping.targetField!);
    }

    const confirmedMappings = imported.mappings.map((mapping) => ({
      sourceColumn: mapping.sourceColumn,
      targetField: mapping.targetField as CanonicalImportField | null,
    }));

    const rows = await this.prisma.dataImportRow.findMany({
      where: { importId },
      select: { id: true, rawData: true },
      orderBy: { rowNumber: 'asc' },
    });

    await this.prisma.$transaction(async (tx) => {
      await Promise.all(imported.mappings.map((mapping) =>
        tx.columnMapping.update({
          where: { id: mapping.id },
          data: { isConfirmed: true },
        }),
      ));

      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        await Promise.all(batch.map((row) => {
          const normalizedData = this.normalizeRow(
            (row.rawData ?? {}) as Record<string, unknown>,
            confirmedMappings,
          );
          return tx.dataImportRow.update({
            where: { id: row.id },
            data: {
              normalizedData: normalizedData as Prisma.InputJsonValue,
              status: 'PENDING',
            },
          });
        }));
      }

      await tx.dataImport.update({
        where: { id: importId },
        data: { status: 'VALIDATING', processedRows: 0 },
      });
    });

    return this.getMapping(importId, companyId);
  }

  private validateMappings(mappings: ImportColumnMappingDto[], headers: Set<string>) {
    const seenSources = new Set<string>();
    const seenTargets = new Set<string>();

    for (const mapping of mappings) {
      if (!headers.has(mapping.sourceColumn)) {
        throw new BadRequestException(`Unknown source column: "${mapping.sourceColumn}".`);
      }
      if (seenSources.has(mapping.sourceColumn)) {
        throw new BadRequestException(`Source column "${mapping.sourceColumn}" appears more than once.`);
      }
      seenSources.add(mapping.sourceColumn);

      if (mapping.targetField) {
        if (!CANONICAL_IMPORT_FIELDS.includes(mapping.targetField)) {
          throw new BadRequestException(`Unsupported target field: "${mapping.targetField}".`);
        }
        if (seenTargets.has(mapping.targetField)) {
          throw new BadRequestException(`Target field "${mapping.targetField}" is mapped more than once.`);
        }
        seenTargets.add(mapping.targetField);
      }
    }
  }

  private normalizeRow(
    raw: Record<string, unknown>,
    mappings: { sourceColumn: string; targetField: CanonicalImportField | null }[],
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    for (const mapping of mappings) {
      if (!mapping.targetField) continue;
      const value = raw[mapping.sourceColumn];
      normalized[mapping.targetField] = this.normalizeValue(mapping.targetField, value);
    }
    return normalized;
  }

  private normalizeValue(field: CanonicalImportField, value: unknown): unknown {
    if (value === null || value === undefined || String(value).trim() === '') return null;

    if (DATE_FIELDS.has(field)) return this.normalizeDate(value);
    if (NUMERIC_FIELDS.has(field)) return this.normalizeNumber(value, RATE_FIELDS.has(field));

    if (typeof value === 'string') return value.normalize('NFKC').trim();
    return value;
  }

  private normalizeNumber(value: unknown, isRate: boolean): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return isRate && value > 0 && value <= 1 ? Number((value * 100).toFixed(6)) : value;
    }

    let text = String(value).normalize('NFKC').trim();
    if (!text) return null;
    const isPercent = text.includes('%');
    text = text.replace(/[₹$€£,\s]/g, '').replace(/%/g, '');
    if (/^\(.*\)$/.test(text)) text = `-${text.slice(1, -1)}`;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return null;
    if (isRate && (isPercent || (parsed > 0 && parsed <= 1))) {
      return Number((parsed * 100).toFixed(6));
    }
    return parsed;
  }

  private normalizeDate(value: unknown): string | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    const text = String(value).trim();
    if (!text) return null;
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

    const match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
    if (!match) return text;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return text;
    }
    return date.toISOString().slice(0, 10);
  }

  private async getImport(importId: string, companyId: string) {
    const imported = await this.prisma.dataImport.findFirst({
      where: { id: importId, companyId },
      select: {
        id: true,
        status: true,
        detectedHeaders: true,
        mappings: {
          orderBy: { sourceColumn: 'asc' },
          select: {
            id: true,
            sourceColumn: true,
            targetField: true,
            confidence: true,
            isConfirmed: true,
          },
        },
      },
    });
    if (!imported) throw new NotFoundException('Import session not found.');
    return imported;
  }
}
