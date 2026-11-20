/**
 * The personal voice profile: learned corrections ("how the recogniser hears me" → "what I
 * meant"), accent patterns, and calibration results. Kept only on the user's device, in a file
 * they can see, move, export and delete — no account, no server.
 */
import { z } from 'zod';
import type { LangBase } from '../lang/languages';
import type { LearnedCorrection } from './learn';

const Lang = z.enum(['zh', 'es', 'en']);

export const CorrectionSchema = z.object({
  heard: z.string().min(1).max(60),
  meant: z.string().min(1).max(60),
  lang: Lang,
  count: z.number().int().min(1),
  source: z.enum(['calibration', 'edit', 'review', 'manual']),
  updatedAt: z.number(),
});
export type ProfileCorrection = z.infer<typeof CorrectionSchema>;
export type CorrectionSource = ProfileCorrection['source'];

export const CalibrationResultSchema = z.object({
  at: z.number(),
  lang: Lang,
  /** Accuracy (0…1) and time per recogniser that was tried. */
  results: z.array(z.object({ asr: z.string(), accuracy: z.number(), ms: z.number(), error: z.string().optional() })),
});
export type CalibrationResult = z.infer<typeof CalibrationResultSchema>;

export const ProfileSchema = z.object({
  version: z.literal(1),
  corrections: z.array(CorrectionSchema).max(MAX_CORRECTIONS()),
  /** Accent pattern → times seen ("l-n": 3). */
  confusions: z.record(z.string(), z.number().int().min(0)),
  calibrations: z.array(CalibrationResultSchema).max(20),
  updatedAt: z.number(),
});
export type VoiceProfile = z.infer<typeof ProfileSchema>;

function MAX_CORRECTIONS(): number {
  return 2000;
}

export const emptyProfile = (): VoiceProfile => ({ version: 1, corrections: [], confusions: {}, calibrations: [], updatedAt: 0 });

/** A profile from a file: anything damaged or unknown gives an empty profile instead of an error. */
export function parseProfile(json: string): VoiceProfile {
  try {
    const r = ProfileSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : emptyProfile();
  } catch {
    return emptyProfile();
  }
}

/**
 * Adds learned corrections. A repeat counts up; a different meaning for the same heard text
 * replaces the old one when the user said so (edit / manual) or it has been seen at least as often.
 */
export function addCorrections(p: VoiceProfile, items: LearnedCorrection[], lang: LangBase, source: CorrectionSource, now = Date.now()): VoiceProfile {
  const list = [...p.corrections];
  for (const { heard, meant } of items) {
    const h = heard.trim();
    const m = meant.trim();
    if (!h || !m || h === m || h.length > 60 || m.length > 60) continue;
    const i = list.findIndex((c) => c.lang === lang && c.heard.toLowerCase() === h.toLowerCase());
    if (i < 0) {
      list.push({ heard: h, meant: m, lang, count: 1, source, updatedAt: now });
      continue;
    }
    const old = list[i]!;
    if (old.meant === m) list[i] = { ...old, count: old.count + 1, source, updatedAt: now };
    else if (source === 'edit' || source === 'manual' || old.count <= 1) list[i] = { heard: h, meant: m, lang, count: 1, source, updatedAt: now };
  }
  // Keep the most useful when full: seen most often, then most recent.
  const kept = list.length > MAX_CORRECTIONS() ? [...list].sort((a, b) => b.count - a.count || b.updatedAt - a.updatedAt).slice(0, MAX_CORRECTIONS()) : list;
  return { ...p, corrections: kept, updatedAt: now };
}

export function removeCorrection(p: VoiceProfile, lang: LangBase, heard: string, now = Date.now()): VoiceProfile {
  return { ...p, corrections: p.corrections.filter((c) => !(c.lang === lang && c.heard === heard)), updatedAt: now };
}

export function recordConfusions(p: VoiceProfile, seen: string[], now = Date.now()): VoiceProfile {
  if (!seen.length) return p;
  const confusions = { ...p.confusions };
  for (const c of seen) confusions[c] = (confusions[c] ?? 0) + 1;
  return { ...p, confusions, updatedAt: now };
}

export function addCalibration(p: VoiceProfile, r: CalibrationResult): VoiceProfile {
  return { ...p, calibrations: [...p.calibrations, r].slice(-20), updatedAt: r.at };
}

/** The user's own accent patterns: seen at least twice. */
export function userPairs(p: VoiceProfile, min = 2): string[] {
  return Object.entries(p.confusions)
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

/** Words the recogniser should listen for (what the user meant), most used first. */
export function profileHotwords(p: VoiceProfile, base: LangBase, limit = 100): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...p.corrections].filter((c) => c.lang === base).sort((a, b) => b.count - a.count)) {
    if (seen.has(c.meant)) continue;
    seen.add(c.meant);
    out.push(c.meant);
    if (out.length >= limit) break;
  }
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface CorrectionRule {
  heard: string;
  meant: string;
  lang: LangBase;
}

/** Applies the user's corrections to recognised text (longest first; whole words for Latin scripts). */
export function applyCorrections(text: string, rules: readonly CorrectionRule[], base: LangBase): { text: string; edits: { from: string; to: string }[] } {
  const edits: { from: string; to: string }[] = [];
  let out = text;
  for (const r of rules.filter((r) => r.lang === base).sort((a, b) => b.heard.length - a.heard.length)) {
    if (base === 'zh') {
      if (out.includes(r.heard)) {
        out = out.split(r.heard).join(r.meant);
        edits.push({ from: r.heard, to: r.meant });
      }
    } else {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(r.heard)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
      if (re.test(out)) {
        out = out.replace(re, (_m, pre: string) => `${pre}${r.meant}`);
        edits.push({ from: r.heard, to: r.meant });
      }
    }
  }
  return { text: out, edits };
}

/** What a pipeline needs from the profile for one source language. */
export function personalFor(p: VoiceProfile, base: LangBase): { rules: readonly CorrectionRule[]; pairs: readonly string[]; hotwords: readonly string[] } {
  return { rules: p.corrections, pairs: base === 'zh' ? userPairs(p) : [], hotwords: profileHotwords(p, base) };
}

/** Combines an imported profile with this one: counts and accent patterns add up, newest calibrations kept. */
export function mergeProfiles(mine: VoiceProfile, other: VoiceProfile, now = Date.now()): VoiceProfile {
  const corrections = [...mine.corrections];
  for (const c of other.corrections) {
    const i = corrections.findIndex((x) => x.lang === c.lang && x.heard.toLowerCase() === c.heard.toLowerCase());
    if (i < 0) corrections.push(c);
    else if (corrections[i]!.meant === c.meant) corrections[i] = { ...corrections[i]!, count: corrections[i]!.count + c.count, updatedAt: Math.max(corrections[i]!.updatedAt, c.updatedAt) };
    else if (c.updatedAt > corrections[i]!.updatedAt) corrections[i] = c;
  }
  const confusions = { ...mine.confusions };
  for (const [k, n] of Object.entries(other.confusions)) confusions[k] = (confusions[k] ?? 0) + n;
  const seen = new Set<number>();
  const calibrations = [...mine.calibrations, ...other.calibrations].sort((a, b) => a.at - b.at).filter((c) => !seen.has(c.at) && seen.add(c.at)).slice(-20);
  return { version: 1, corrections: corrections.slice(0, MAX_CORRECTIONS()), confusions, calibrations, updatedAt: now };
}
