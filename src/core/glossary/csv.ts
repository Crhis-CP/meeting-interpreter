import { newEntryId, type GlossaryEntry } from './types';

export interface CsvParseResult {
  entries: GlossaryEntry[];
  errors: { line: number; message: string }[];
}

/** Splits CSV text into rows of fields (RFC 4180: quotes, escaped quotes, embedded newlines). */
export function parseCsvRows(text: string): { row: string[]; line: number }[] {
  const rows: { row: string[]; line: number }[] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') inQuotes = true;
    else if (c === ',' || c === '\t' || c === '，') {
      // Tabs and full-width commas come from pasting out of Excel/WPS or typing on a Chinese IME.
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // handled with \n
    } else if (c === '\n') {
      row.push(field);
      rows.push({ row, line: rowLine });
      row = [];
      field = '';
      line++;
      rowLine = line;
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push({ row, line: rowLine });
  }
  return rows;
}

const HEADER_ALIASES: Record<string, 'zh' | 'es' | 'en' | 'note' | 'aliasesZh' | 'aliasesEs' | 'aliasesEn'> = {
  中文: 'zh',
  zh: 'zh',
  chinese: 'zh',
  术语: 'zh',
  español: 'es',
  espanol: 'es',
  西语: 'es',
  西班牙语: 'es',
  es: 'es',
  spanish: 'es',
  english: 'en',
  en: 'en',
  英语: 'en',
  英文: 'en',
  英语别名: 'aliasesEn',
  英文别名: 'aliasesEn',
  aliases_en: 'aliasesEn',
  中文别名: 'aliasesZh',
  aliases_zh: 'aliasesZh',
  aliaseszh: 'aliasesZh',
  西语别名: 'aliasesEs',
  aliases_es: 'aliasesEs',
  aliases_es_: 'aliasesEs',
  aliases: 'aliasesZh',
  备注: 'note',
  说明: 'note',
  note: 'note',
  notes: 'note',
};

function splitAliases(s: string): string[] {
  return s
    .split(/[;；|、]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Parses a glossary CSV exported from Excel/WPS/Numbers (UTF-8, with or without BOM). */
export function parseGlossaryCsv(text: string): CsvParseResult {
  const errors: { line: number; message: string }[] = [];
  const entries: GlossaryEntry[] = [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('�')) {
    errors.push({ line: 1, message: '文件包含无法识别的字符，可能不是 UTF-8 编码。请在 Excel 中“另存为 CSV UTF-8（逗号分隔）”。' });
    return { entries, errors };
  }
  const rows = parseCsvRows(text).filter((r) => r.row.some((f) => f.trim() !== ''));
  if (!rows.length) return { entries, errors };

  // Map columns from the header if there is one; otherwise assume 中文,Español,中文别名,西语别名,备注.
  let cols: (string | undefined)[] = ['zh', 'es', 'aliasesZh', 'aliasesEs', 'note'];
  const first = rows[0]!.row.map((h) => h.trim().toLowerCase().replace(/\s+/g, ''));
  const mapped = first.map((h) => HEADER_ALIASES[h] ?? HEADER_ALIASES[h.replace(/[()（）]/g, '')]);
  if (mapped.some((m) => m === 'zh') && mapped.some((m) => m === 'es' || m === 'en')) {
    cols = mapped;
    rows.shift();
  }

  for (const { row, line } of rows) {
    const rec: Record<string, string> = {};
    row.forEach((v, i) => {
      const key = cols[i];
      if (key) rec[key] = v.trim();
    });
    const zh = rec.zh ?? '';
    const es = rec.es ?? '';
    const en = rec.en ?? '';
    if (!zh && !es && !en) {
      errors.push({ line, message: '缺少中文和西语术语' });
      continue;
    }
    if (row.length > Math.max(cols.length, 7) + 2) {
      errors.push({ line, message: `列数太多（${row.length} 列），可能有未加引号的逗号` });
      continue;
    }
    entries.push({
      id: newEntryId(),
      zh,
      es,
      aliasesZh: splitAliases(rec.aliasesZh ?? ''),
      aliasesEs: splitAliases(rec.aliasesEs ?? ''),
      en,
      aliasesEn: splitAliases(rec.aliasesEn ?? ''),
      note: rec.note ?? '',
      enabled: true,
    });
  }
  return { entries, errors };
}

function csvField(s: string): string {
  return /[",\r\n\t，]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialises with a UTF-8 BOM and CRLF so Excel opens Chinese text correctly. */
export function glossaryToCsv(entries: GlossaryEntry[]): string {
  const lines = [['中文', 'Español', 'English', '中文别名', '西语别名', '英语别名', '备注'].join(',')];
  for (const e of entries) {
    lines.push([e.zh, e.es, e.en ?? '', e.aliasesZh.join(';'), e.aliasesEs.join(';'), (e.aliasesEn ?? []).join(';'), e.note].map(csvField).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
