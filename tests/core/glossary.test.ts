import { describe, expect, it } from 'vitest';
import { glossaryToCsv, parseCsvRows, parseGlossaryCsv } from '@core/glossary/csv';
import { findHits, hotwordsFor, containsLatinTerm } from '@core/glossary/match';
import { correctText } from '@core/glossary/correct';
import type { GlossaryEntry } from '@core/glossary/types';

const e = (zh: string, es: string, extra: Partial<GlossaryEntry> = {}): GlossaryEntry => ({
  id: zh, zh, es, aliasesZh: [], aliasesEs: [], note: '', enabled: true, ...extra,
});

describe('glossary csv', () => {
  it('parses BOM + CRLF + quoted commas with a Chinese header', () => {
    const csv = '﻿中文,Español,中文别名,西语别名,备注\r\n星云平台,Plataforma Nébula,心云平台;新云平台,,"产品名, 不要意译"\r\n合同,contrato,,,\r\n';
    const { entries, errors } = parseGlossaryCsv(csv);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ zh: '星云平台', es: 'Plataforma Nébula', aliasesZh: ['心云平台', '新云平台'], note: '产品名, 不要意译' });
  });

  it('accepts rows without a header and tab-separated pastes', () => {
    const { entries } = parseGlossaryCsv('报价单\tcotización\n交货期\tplazo de entrega');
    expect(entries.map((x) => x.es)).toEqual(['cotización', 'plazo de entrega']);
  });

  it('reports the line of a malformed row', () => {
    const { entries, errors } = parseGlossaryCsv('中文,Español\n星云,Nébula\n,\n');
    expect(entries).toHaveLength(1);
    expect(errors).toEqual([]); // empty rows are skipped silently
    const bad = parseGlossaryCsv('中文,Español\n星云,Nébula\n,,备注只有\n');
    expect(bad.errors[0]!.line).toBe(3);
  });

  it('flags non-UTF-8 input', () => {
    expect(parseGlossaryCsv('��,abc').errors[0]!.message).toMatch(/UTF-8/);
  });

  it('round-trips through CSV', () => {
    const src = [e('星云平台', 'Plataforma Nébula', { aliasesZh: ['心云平台'], note: '含"引号",逗号' })];
    const csv = glossaryToCsv(src);
    expect(csv.startsWith('﻿')).toBe(true);
    const back = parseGlossaryCsv(csv).entries[0]!;
    expect(back).toMatchObject({ zh: '星云平台', es: 'Plataforma Nébula', aliasesZh: ['心云平台'], note: '含"引号",逗号' });
  });
});

describe('glossary matching', () => {
  const entries = [e('星云平台', 'Plataforma Nébula', { aliasesZh: ['心云平台'] }), e('星云', 'Nébula'), e('交货期', 'plazo de entrega')];

  it('finds Chinese terms, preferring the longer one', () => {
    const hits = findHits('我们的产品叫星云平台，交货期是三周', 'zh', entries);
    expect(hits.map((h) => h.source)).toEqual(['星云平台', '交货期']);
    expect(hits[0]!.target).toBe('Plataforma Nébula');
  });

  it('counts aliases as hits', () => {
    expect(findHits('心云平台很好用', 'zh', entries).map((h) => h.source)).toEqual(['星云平台']);
  });

  it('matches Spanish case- and accent-insensitively on word boundaries', () => {
    expect(findHits('La plataforma nebula es rápida', 'es', entries).map((h) => h.target)).toEqual(['星云平台']);
    expect(containsLatinTerm('nebulosa', 'nébula')).toBe(false);
  });

  it('lists hot words per language', () => {
    expect(hotwordsFor('zh', entries)).toEqual(['星云平台', '星云', '交货期']);
    expect(hotwordsFor('es', entries)).toContain('plazo de entrega');
  });
});

describe('glossary correction', () => {
  const entries = [e('星云平台', 'Plataforma Nébula', { aliasesZh: ['心云平台'], aliasesEs: ['plataforma nevula'] }), e('欧阳', 'Ouyang'), e('云', 'nube')];

  it('replaces known aliases', () => {
    const r = correctText('我们用心云平台开会', 'zh', entries, { pinyinFuzzy: false });
    expect(r.text).toBe('我们用星云平台开会');
    expect(r.edits).toEqual([{ from: '心云平台', to: '星云平台' }]);
  });

  it('fuzzy-corrects sound-alike Han runs only when enabled', () => {
    expect(correctText('新云平台上线了', 'zh', entries, { pinyinFuzzy: false }).text).toBe('新云平台上线了');
    expect(correctText('新云平台上线了', 'zh', entries, { pinyinFuzzy: true }).text).toBe('星云平台上线了');
  });

  it('never fuzzy-corrects single-character terms or unrelated words', () => {
    expect(correctText('运动会', 'zh', entries, { pinyinFuzzy: true }).text).toBe('运动会');
    expect(correctText('今天天气不错', 'zh', entries, { pinyinFuzzy: true }).text).toBe('今天天气不错');
  });

  it('Spanish names and brands spelled by ear are corrected by sound (b/v, s/z/c, ll/y, silent h, c/qu/k)', () => {
    const names = [e('萨拉特', 'Zárate'), e('埃尔南德斯', 'Hernández'), e('马黛茶公司', 'Yerba Mate Cía'), e('星云', 'Nébula'), e('奎尔梅斯', 'Quilmes'), e('运费', 'flete'), e('牛', 'vaca')];
    const fix = (t: string) => correctText(t, 'es', names, { pinyinFuzzy: false });
    expect(fix('Hablé con el señor Sárate ayer.').text).toBe('Hablé con el señor Zárate ayer.');
    expect(fix('Lo firma Ernández.').text).toBe('Lo firma Hernández.');
    expect(fix('Somos de Llerba Mate Sía.').text).toBe('Somos de Yerba Mate Cía.');
    expect(fix('Usamos Nevula para todo.')).toEqual({ text: 'Usamos Nébula para todo.', edits: [{ from: 'Nevula', to: 'Nébula' }] });
    expect(fix('La planta de Kilmes.').text).toBe('La planta de Quilmes.');
    // Ordinary lower-case words are never changed by sound ("baca" stays; "flete" is not touched).
    expect(fix('La baca del techo y el flette.').text).toBe('La baca del techo y el flette.');
  });

  it('normal Spanish sentences are not changed at all by the sound matching', () => {
    const names = [e('萨拉特', 'Zárate'), e('埃尔南德斯', 'Hernández'), e('星云', 'Nébula'), e('奎尔梅斯', 'Quilmes'), e('贝拉', 'Vera'), e('卡萨', 'Casa Blanca'), e('席尔瓦', 'Silva'), e('谢', 'Ceja')];
    const plain = [
      'Buenos días, ¿cuándo pueden entregar el primer pedido?',
      'Che, ¿vos sabés si el precio incluye el flete hasta Buenos Aires?',
      'Necesitamos la factura antes de que llegue la mercadería a la aduana.',
      'La verdad es que el precio está un poco alto para nuestro mercado.',
      'Dale, lo charlamos con el equipo y te confirmamos el lunes.',
      'Vamos a la casa de mi socio, que vive cerca de la playa.',
      'Hay que ver si la selva tiene buena señal.',
      'Era verdad: la hice ayer.',
    ];
    for (const t of plain) expect(correctText(t, 'es', names, { pinyinFuzzy: false }).text).toBe(t);
  });

  it('fixes Spanish aliases and accents', () => {
    expect(correctText('usamos la plataforma nevula hoy', 'es', entries, { pinyinFuzzy: false }).text).toBe('usamos la Plataforma Nébula hoy');
    expect(correctText('la plataforma nebula', 'es', entries, { pinyinFuzzy: false }).text).toBe('la Plataforma Nébula');
  });
});

describe('CSV / TSV separators', () => {
  it('a tab file keeps commas inside values; a comma file keeps full-width commas in notes', () => {
    expect(parseCsvRows('中文\tEspañol\t备注\n报价\tprecio, oferta\t含税\n').map((r) => r.row)).toEqual([['中文', 'Español', '备注'], ['报价', 'precio, oferta', '含税']]);
    expect(parseCsvRows('中文,Español,备注\n报价,precio,含税，不含运费\n').map((r) => r.row)).toEqual([['中文', 'Español', '备注'], ['报价', 'precio', '含税，不含运费']]);
  });
});
