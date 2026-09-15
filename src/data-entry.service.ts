import { BadRequestException, Injectable } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { suggestMappings } from './config/field-mapper';

export interface ParsedImport {
  fileName: string;
  fileType: 'xlsx' | 'xls' | 'csv';
  sheetName: string;
  headers: string[];
  rows: Record<string, unknown>[];
  mappingSuggestions: ReturnType<typeof suggestMappings>;
}

@Injectable()
export class DataEntryService {
  parseFile(file: Express.Multer.File): ParsedImport {
    if (!file?.buffer?.length) throw new BadRequestException('Uploaded file is empty.');

    const name = file.originalname.toLowerCase();
    const extension = name.split('.').pop();
    if (!extension || !['xlsx', 'xls', 'csv'].includes(extension)) {
      throw new BadRequestException('Only XLSX, XLS and CSV files are supported.');
    }

    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, {
        type: 'buffer',
        cellDates: true,
        raw: false,
      });
    } catch {
      throw new BadRequestException('The uploaded spreadsheet could not be read. It may be corrupt or unsupported.');
    }

    if (!workbook.SheetNames.length) {
      throw new BadRequestException('The workbook contains no sheets.');
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      blankrows: false,
      raw: false,
    });

    const headerIndex = this.detectHeaderRow(matrix);
    if (headerIndex < 0) throw new BadRequestException('Could not detect a usable header row.');

    const rawHeaders = matrix[headerIndex] ?? [];
    const headers = this.uniqueHeaders(rawHeaders.map((h) => String(h ?? '').trim()));
    if (!headers.some(Boolean)) throw new BadRequestException('The sheet has no usable columns.');

    const rows = matrix.slice(headerIndex + 1)
      .map((values) => this.toObject(headers, values))
      .filter((row) => Object.values(row).some((value) => value !== null && String(value).trim() !== ''));

    return {
      fileName: file.originalname,
      fileType: extension as ParsedImport['fileType'],
      sheetName,
      headers,
      rows,
      mappingSuggestions: suggestMappings(headers),
    };
  }

  private detectHeaderRow(matrix: unknown[][]): number {
    const limit = Math.min(matrix.length, 25);
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < limit; i++) {
      const values = matrix[i] ?? [];
      const nonEmpty = values.filter((v) => v !== null && String(v).trim() !== '').length;
      if (nonEmpty < 2) continue;
      const text = values.map((v) => String(v ?? '').toLowerCase()).join(' ');
      const accountingHints = ['date', 'invoice', 'bill', 'party', 'customer', 'item', 'qty', 'quantity', 'amount', 'gst', 'tax', 'rate'];
      const hintScore = accountingHints.reduce((n, hint) => n + (text.includes(hint) ? 1 : 0), 0);
      const score = nonEmpty + hintScore * 2;
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }
    return bestIndex;
  }

  private uniqueHeaders(headers: string[]): string[] {
    const seen = new Map<string, number>();
    return headers.map((header, index) => {
      const base = header || `Column ${index + 1}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return count === 0 ? base : `${base}__${count + 1}`;
    });
  }

  private toObject(headers: string[], values: unknown[]): Record<string, unknown> {
    return headers.reduce<Record<string, unknown>>((row, header, index) => {
      row[header] = values[index] ?? null;
      return row;
    }, {});
  }
}
