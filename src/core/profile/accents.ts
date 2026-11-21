/**
 * Chinese accent features: the sound mergers of regional Mandarin (docs/accents.md), each as a
 * rule that turns a syllable as said into the syllable a recogniser hears when the speaker merges
 * the two sounds — "n→l" (南 nan heard as 兰 lan), "hu→f" (花 hua heard as 发 fa), "r→y"
 * (人 ren heard as 银 yin), "ü→i" (去 qu heard as 气 qi).
 *
 * Every feature is built in and considered for everyone (accents are often mixed: nobody chooses
 * a region); what a person really does is learned from their calibration, their corrections and
 * the after-meeting review, and only features seen in them loosen the sound-alike matching.
 */
import { pinyin } from 'pinyin-pro';

const syllables = (text: string) => pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' }) as string[];

const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];

/** A toneless syllable as [initial, final] ("zhang" → ["zh", "ang"], "an" → ["", "an"]). */
export function split(s: string): [string, string] {
  const i = INITIALS.find((x) => s.startsWith(x) && s.length > x.length) ?? '';
  return [i, s.slice(i.length)];
}

export interface AccentFeature {
  /** Stable id, also the key in the voice profile ("l-n"). */
  id: string;
  /** The two directions, each "said→heard" with its rule. */
  dirs: [Direction, Direction] | [Direction];
  /** For people: the sounds and two example characters. */
  name: string;
}

interface Direction {
  key: string;
  /** The syllable heard when this merge happens, or null when the syllable has no such sound. */
  apply(s: string): string | null;
}

function initialSwap(a: string, b: string): [Direction, Direction] {
  const one = (x: string, y: string): Direction => ({
    key: `${x}→${y}`,
    apply: (s) => {
      const [i, f] = split(s);
      return i === x && f ? y + f : null;
    },
  });
  return [one(a, b), one(b, a)];
}

function finalSwap(a: string, b: string, initials?: string): [Direction, Direction] {
  const one = (x: string, y: string): Direction => ({
    key: `${x}→${y}`,
    apply: (s) => {
      const [i, f] = split(s);
      return f === x && i && (!initials || initials.split(' ').includes(i)) ? i + y : null;
    },
  });
  return [one(a, b), one(b, a)];
}

/** f ↔ hu: 发 fa / 花 hua, 飞 fei / 灰 hui, 分 fen / 昏 hun, 福 fu / 胡 hu (闽、客、湘、赣、西南). */
const F_TO_HU: Record<string, string> = { a: 'hua', o: 'huo', ei: 'hui', en: 'hun', u: 'hu', an: 'huan', ang: 'huang', ai: 'huai' };
const HU_TO_F: Record<string, string> = Object.fromEntries(Object.entries(F_TO_HU).map(([f, hu]) => [hu, `f${f}`]));

/** r → y: 人 ren / 银 yin, 肉 rou / 又 you, 让 rang / 样 yang, 软 ruan / 远 yuan (东北、胶辽). */
const R_TO_Y: Record<string, string> = { e: 'ye', en: 'yin', ou: 'you', an: 'yan', ang: 'yang', i: 'yi', ong: 'yong', u: 'yu', uan: 'yuan', un: 'yun', ao: 'yao', eng: 'ying', uo: 'yue' };

/** ü → i: 去 qu / 气 qi, 女 nü / 你 ni, 鱼 yu / 姨 yi, 选 xuan / 显 xian (粤、客、闽、西南部分). */
function uToI(s: string): string | null {
  const [i, f] = split(s);
  if ('j q x'.split(' ').includes(i)) {
    const m: Record<string, string> = { u: 'i', ue: 'ie', uan: 'ian', un: 'in' };
    return m[f] ? i + m[f] : null;
  }
  if (i === 'y') {
    const m: Record<string, string> = { u: 'yi', ue: 'ye', uan: 'yan', un: 'yin' };
    return m[f] ?? null;
  }
  if (i === 'n' || i === 'l') {
    const m: Record<string, string> = { ü: 'i', üe: 'ie' };
    return m[f] ? i + m[f] : null;
  }
  return null;
}

/** j / q / x → z / c / s (尖音，闽、粤、吴部分): 西 xi / 思 si, 小 xiao / 扫 sao, 酒 jiu / 走 zou. */
function palatalToDental(from: string, to: string): Direction {
  return {
    key: `${from}→${to}`,
    apply: (s) => {
      const [i, f] = split(s);
      if (i !== from) return null;
      if (f === 'i') return `${to}i`;
      if (f === 'iu') return `${to}ou`;
      if (f.startsWith('i')) return to + f.slice(1);
      return null;
    },
  };
}

export const FEATURES: readonly AccentFeature[] = [
  { id: 'l-n', dirs: initialSwap('n', 'l'), name: 'n / l（南—兰）' },
  { id: 'f-hu', dirs: [{ key: 'hu→f', apply: (s) => HU_TO_F[s] ?? null }, { key: 'f→hu', apply: (s) => { const [i, f] = split(s); return i === 'f' ? F_TO_HU[f] ?? null : null; } }], name: 'f / hu（发—花）' },
  { id: 'f-h', dirs: initialSwap('f', 'h'), name: 'f / h（飞—黑）' },
  { id: 'z-zh', dirs: initialSwap('zh', 'z'), name: 'zh / z（知—资）' },
  { id: 'c-ch', dirs: initialSwap('ch', 'c'), name: 'ch / c（柴—才）' },
  { id: 's-sh', dirs: initialSwap('sh', 's'), name: 'sh / s（是—四）' },
  { id: 'l-r', dirs: initialSwap('r', 'l'), name: 'r / l（日—力）' },
  { id: 'r-y', dirs: [{ key: 'r→y', apply: (s) => { const [i, f] = split(s); return i === 'r' ? R_TO_Y[f] ?? null : null; } }], name: 'r 读成 y（人—银）' },
  { id: 'in-ing', dirs: finalSwap('ing', 'in'), name: 'in / ing（新—星）' },
  { id: 'en-eng', dirs: finalSwap('eng', 'en'), name: 'en / eng（分—风）' },
  { id: 'an-ang', dirs: finalSwap('ang', 'an'), name: 'an / ang（班—帮）' },
  { id: 'ian-iang', dirs: finalSwap('iang', 'ian'), name: 'ian / iang（建—讲）' },
  { id: 'uan-uang', dirs: finalSwap('uang', 'uan'), name: 'uan / uang（关—光）' },
  { id: 'eng-ong', dirs: finalSwap('eng', 'ong'), name: 'eng / ong（风—轰）' },
  { id: 'en-un', dirs: finalSwap('un', 'en'), name: 'un / en（存—岑）' },
  { id: 'e-uo', dirs: finalSwap('e', 'uo', 'g k h'), name: 'e / uo（哥—锅）' },
  { id: 'i-ü', dirs: [{ key: 'ü→i', apply: uToI }], name: 'ü 读成 i（去—气）' },
  { id: 'j-z', dirs: [palatalToDental('j', 'z'), palatalToDental('q', 'c')], name: 'j / q 读成 z / c（鸡—资）' },
  { id: 'x-s', dirs: [palatalToDental('x', 's')], name: 'x 读成 s（西—思）' },
];

const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

/** People-facing name of a feature id ("l-n" → "n / l（南—兰）"); unknown ids as they are. */
export function featureName(id: string): string {
  return BY_ID.get(id)?.name ?? id.replace('-', ' / ');
}

/** Which feature (and direction) turns `said` into `heard`, if any. */
export function featureOf(heard: string, said: string): { id: string; key: string } | null {
  if (!heard || !said || heard === said) return null;
  for (const f of FEATURES) for (const d of f.dirs) if (d.apply(said) === heard) return { id: f.id, key: d.key };
  return null;
}

/** Feature ids whose merge relates the two syllables (in either direction). */
export function relatedBy(a: string, b: string): string | null {
  return featureOf(a, b)?.id ?? featureOf(b, a)?.id ?? null;
}

// ------------------------------------------------------------------ text normalisation

const DIGITS = '零一二三四五六七八九';

/** A whole number in Chinese (up to 9999 9999), as it is read: 40 → 四十, 2600 → 两千六百, 105 → 一百零五. */
export function chineseNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e8) return String(n);
  if (n < 10) return DIGITS[n]!;
  const below10k = (x: number, leading: boolean): string => {
    const units: [number, string][] = [[1000, '千'], [100, '百'], [10, '十'], [1, '']];
    let out = '';
    let zero = false;
    for (const [u, name] of units) {
      const d = Math.floor(x / u) % 10;
      if (d === 0) {
        if (out) zero = true;
        continue;
      }
      if (zero) out += '零';
      zero = false;
      // 十二 (not 一十二) at the start; 两千 / 两百 as they are said.
      const digit = u === 10 && d === 1 && !out && leading ? '' : (u === 1000 || u === 100) && d === 2 ? '两' : DIGITS[d]!;
      out += digit + name;
    }
    return out;
  };
  if (n < 10_000) return below10k(n, true);
  const wan = Math.floor(n / 10_000);
  const rest = n % 10_000;
  return `${below10k(wan, true)}万${rest ? (rest < 1000 ? '零' : '') + below10k(rest, false) : ''}`;
}

/**
 * Text as it is said, for comparing a reading with what the recogniser wrote: digits as Chinese
 * numbers (recognisers write 四十万 as 40万, 百分之五 as 5%), full-width letters and digits as
 * ordinary ones. Phone-number-like digit strings are read digit by digit.
 */
export function asSpoken(text: string): string {
  return text
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/(\d+(?:\.\d+)?)%/g, (_m, n: string) => `百分之${asSpoken(n)}`)
    .replace(/\d+(?:\.\d+)?/g, (m) => {
      if (/^\d{5,}$/.test(m) && m.startsWith('1') && m.length >= 7) return [...m].map((d) => (d === '1' ? '一' : DIGITS[Number(d)])).join('');
      const [int, dec] = m.split('.');
      const head = Number(int) >= 1e8 ? [...int!].map((d) => DIGITS[Number(d)]).join('') : chineseNumber(Number(int));
      return dec ? `${head}点${[...dec].map((d) => DIGITS[Number(d)]).join('')}` : head;
    });
}

/** Toneless syllables of each Chinese character, read in context (行 in 银行 is hang, in 行走 xing). */
export function contextSyllables(chars: string[]): string[] {
  const out: string[] = new Array<string>(chars.length).fill('');
  const HAN = /\p{Script=Han}/u;
  let i = 0;
  while (i < chars.length) {
    if (!HAN.test(chars[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < chars.length && HAN.test(chars[j]!)) j++;
    const py = syllables(chars.slice(i, j).join(''));
    for (let k = i; k < j; k++) out[k] = py[k - i] ?? '';
    i = j;
  }
  return out;
}

export interface FeatureCount {
  /** Times the reading had a syllable this merge would change. */
  tested: number;
  /** Times the recogniser heard it merged. */
  merged: number;
}

/**
 * Per direction ("n→l"), how often a reading had the chance to show it and how often it did:
 * aligned by character, each syllable read is checked against every feature it could show.
 */
export function featureCounts(refChars: string[], ops: { op: string; ri?: number; hi?: number }[], heardChars: string[]): Record<string, FeatureCount> {
  const said = contextSyllables(refChars);
  const heard = contextSyllables(heardChars);
  const out: Record<string, FeatureCount> = {};
  for (const o of ops) {
    if ((o.op !== 'eq' && o.op !== 'sub') || o.ri === undefined || o.hi === undefined) continue;
    const s = said[o.ri];
    const h = heard[o.hi];
    if (!s) continue;
    for (const f of FEATURES)
      for (const d of f.dirs) {
        const merged = d.apply(s);
        if (!merged) continue;
        const c = (out[d.key] ??= { tested: 0, merged: 0 });
        c.tested++;
        if (o.op === 'sub' && h === merged) c.merged++;
      }
  }
  return out;
}

/** The feature id a direction key belongs to ("n→l" → "l-n"). */
export function featureOfKey(key: string): string | null {
  for (const f of FEATURES) if (f.dirs.some((d) => d.key === key)) return f.id;
  return null;
}
