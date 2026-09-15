import { CANONICAL_IMPORT_FIELDS, FIELD_ALIASES, CanonicalImportField, normalizeHeader } from './import.constants';

export interface MappingSuggestion {
  sourceColumn: string;
  targetField: CanonicalImportField | null;
  confidence: number;
  method: 'exact' | 'alias' | 'token' | 'none';
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const aTokens = new Set(a.split(' '));
  const bTokens = new Set(b.split(' '));
  const intersection = [...aTokens].filter((t) => bTokens.has(t)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union ? intersection / union : 0;
}

export function suggestMappings(columns: string[]): MappingSuggestion[] {
  return columns.map((sourceColumn) => {
    const normalized = normalizeHeader(sourceColumn);

    if (!normalized) {
      return { sourceColumn, targetField: null, confidence: 0, method: 'none' };
    }

    for (const field of CANONICAL_IMPORT_FIELDS) {
      if (normalized === normalizeHeader(field)) {
        return { sourceColumn, targetField: field, confidence: 1, method: 'exact' };
      }
    }

    let best: { field: CanonicalImportField; score: number } | null = null;
    for (const field of CANONICAL_IMPORT_FIELDS) {
      for (const alias of FIELD_ALIASES[field]) {
        const aliasNorm = normalizeHeader(alias);
        let score = 0;
        if (normalized === aliasNorm) score = 0.98;
        else score = similarity(normalized, aliasNorm) * 0.9;
        if (!best || score > best.score) best = { field, score };
      }
    }

    if (best && best.score >= 0.72) {
      return {
        sourceColumn,
        targetField: best.field,
        confidence: Number(best.score.toFixed(4)),
        method: best.score >= 0.97 ? 'alias' : 'token',
      };
    }

    return { sourceColumn, targetField: null, confidence: 0, method: 'none' };
  });
}
