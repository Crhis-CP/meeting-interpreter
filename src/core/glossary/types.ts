/** One term with its fixed translation. `aliases*` are common mis-recognitions of the term. */
export interface GlossaryEntry {
  id: string;
  zh: string;
  es: string;
  aliasesZh: string[];
  aliasesEs: string[];
  note: string;
  enabled: boolean;
}

export interface Glossary {
  id: string;
  name: string;
  enabled: boolean;
  entries: GlossaryEntry[];
}

/** A glossary term found in a sentence to translate. */
export interface GlossaryHit {
  /** The term as it should be written in the source language. */
  source: string;
  /** Its fixed translation in the target language. */
  target: string;
  entry: GlossaryEntry;
}

export function newEntryId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function activeEntries(glossaries: Glossary[]): GlossaryEntry[] {
  return glossaries.filter((g) => g.enabled).flatMap((g) => g.entries.filter((e) => e.enabled && (e.zh || e.es)));
}
