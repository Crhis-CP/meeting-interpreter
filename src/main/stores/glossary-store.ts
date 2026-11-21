import { join } from 'node:path';
import { activeEntries, newEntryId, type Glossary, type GlossaryEntry } from '../../core/glossary/types';
import { readJson, writeJson } from './json-file';

const entry = (zh: string, es: string, note = ''): GlossaryEntry => ({ id: newEntryId(), zh, es, aliasesZh: [], aliasesEs: [], note, enabled: true });

/** A starter glossary of common foreign-trade terms (disabled until the user turns it on). */
export function sampleTradeGlossary(): Glossary {
  return {
    id: 'sample-trade',
    name: '外贸常用术语（示例）',
    enabled: false,
    entries: [
      entry('报价单', 'cotización'),
      entry('形式发票', 'factura proforma'),
      entry('交货期', 'plazo de entrega'),
      entry('定金', 'anticipo'),
      entry('尾款', 'saldo pendiente'),
      entry('样品', 'muestra'),
      entry('订单', 'pedido'),
      entry('最小起订量', 'cantidad mínima de pedido', 'MOQ'),
      entry('离岸价', 'precio FOB'),
      entry('到岸价', 'precio CIF'),
      entry('运费', 'flete'),
      entry('关税', 'arancel'),
      entry('清关', 'despacho de aduanas'),
      entry('提单', 'conocimiento de embarque'),
      entry('信用证', 'carta de crédito'),
      entry('电汇', 'transferencia bancaria'),
      entry('质检', 'control de calidad'),
      entry('售后服务', 'servicio posventa'),
      entry('经销商', 'distribuidor'),
      entry('合同', 'contrato'),
    ],
  };
}

export class GlossaryStore {
  private readonly path: string;
  private items: Glossary[];

  constructor(dataDir: string) {
    this.path = join(dataDir, 'glossaries.json');
    this.items = readJson<Glossary[]>(this.path, []);
    if (!this.items.length) {
      this.items = [{ id: 'default', name: '我的术语表', enabled: true, entries: [] }, sampleTradeGlossary()];
      this.persist();
    }
  }

  private persist(): void {
    writeJson(this.path, this.items);
  }

  list(): Glossary[] {
    return this.items;
  }

  /** Enabled entries of enabled glossaries — what the engine uses. */
  active(): GlossaryEntry[] {
    return activeEntries(this.items);
  }

  save(g: Glossary): Glossary[] {
    const clean: Glossary = {
      ...g,
      name: g.name.trim() || '未命名术语表',
      entries: g.entries
        .map((e) => ({ ...e, id: e.id || newEntryId(), zh: e.zh.trim(), es: e.es.trim(), en: (e.en ?? '').trim(), note: (e.note ?? '').trim() }))
        .filter((e) => e.zh || e.es || e.en),
    };
    const i = this.items.findIndex((x) => x.id === g.id);
    if (i >= 0) this.items[i] = clean;
    else this.items.push({ ...clean, id: clean.id || `g${Date.now().toString(36)}` });
    this.persist();
    return this.items;
  }

  remove(id: string): Glossary[] {
    this.items = this.items.filter((g) => g.id !== id);
    if (!this.items.length) this.items = [{ id: 'default', name: '我的术语表', enabled: true, entries: [] }];
    this.persist();
    return this.items;
  }

  /** Adds imported entries to a glossary (new one when `targetId` is null), skipping duplicates. */
  addEntries(targetId: string | null, entries: GlossaryEntry[], name = '导入的术语表'): Glossary[] {
    let g = targetId ? this.items.find((x) => x.id === targetId) : undefined;
    if (!g) {
      g = { id: `g${Date.now().toString(36)}`, name, enabled: true, entries: [] };
      this.items.push(g);
    }
    const seen = new Set(g.entries.map((e) => `${e.zh}|${e.es}|${e.en ?? ''}`));
    for (const e of entries) {
      const key = `${e.zh}|${e.es}|${e.en ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      g.entries.push(e);
    }
    this.persist();
    return this.items;
  }

  /**
   * Terms learned after a meeting go to their own glossary, “自动术语”, where the user sees them and
   * can delete any. Terms the user already has (in any glossary) are skipped. Returns those added.
   */
  addAutoTerms(terms: { zh: string; foreign: string }[], foreign: 'es' | 'en'): { zh: string; foreign: string }[] {
    let g = this.items.find((x) => x.id === AUTO_GLOSSARY_ID);
    if (!g) {
      g = { id: AUTO_GLOSSARY_ID, name: '自动术语（会后学到的）', enabled: true, entries: [] };
      this.items.push(g);
    }
    const have = new Set(this.items.flatMap((x) => x.entries.flatMap((e) => [e.zh, e.es, e.en ?? ''].filter(Boolean).map((v) => v.toLowerCase()))));
    const added: { zh: string; foreign: string }[] = [];
    for (const t of terms) {
      if (have.has(t.zh.toLowerCase()) || have.has(t.foreign.toLowerCase())) continue;
      have.add(t.zh.toLowerCase());
      have.add(t.foreign.toLowerCase());
      g.entries.push({ id: newEntryId(), zh: t.zh, es: foreign === 'es' ? t.foreign : '', en: foreign === 'en' ? t.foreign : '', aliasesZh: [], aliasesEs: [], aliasesEn: [], note: '会后自动学到', enabled: true });
      added.push(t);
    }
    // A bounded list: every term is a chance to "correct" a word that was right, and the oldest
    // ones are the least likely to come up again.
    if (g.entries.length > MAX_AUTO_TERMS) g.entries.splice(0, g.entries.length - MAX_AUTO_TERMS);
    if (added.length) this.persist();
    return added;
  }

  /**
   * The other side's terms the recogniser mis-heard: remembered on the automatic glossary's entry
   * for the term (its "often heard as"), so later meetings correct them right away. Only automatic
   * entries are changed (the user's own glossaries are theirs); at most 5 per term.
   */
  addAutoAliases(fixes: { heard: string; meant: string }[], foreign: 'es' | 'en'): { heard: string; meant: string }[] {
    const g = this.items.find((x) => x.id === AUTO_GLOSSARY_ID);
    if (!g) return [];
    const fold = (v: string) => v.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
    const added: { heard: string; meant: string }[] = [];
    for (const f of fixes) {
      const e = g.entries.find((x) => fold((foreign === 'en' ? x.en : x.es) ?? '') === fold(f.meant));
      if (!e) continue;
      const list = foreign === 'en' ? (e.aliasesEn ??= []) : e.aliasesEs;
      if (list.length >= 5 || list.some((a) => fold(a) === fold(f.heard))) continue;
      list.push(f.heard);
      added.push(f);
    }
    if (added.length) this.persist();
    return added;
  }

  removeAutoTerm(zh: string): Glossary[] {
    const g = this.items.find((x) => x.id === AUTO_GLOSSARY_ID);
    if (g) {
      g.entries = g.entries.filter((e) => e.zh !== zh);
      this.persist();
    }
    return this.items;
  }
}

export const AUTO_GLOSSARY_ID = 'auto-terms';
/** At most this many automatically learned terms; the oldest go first. */
export const MAX_AUTO_TERMS = 300;
