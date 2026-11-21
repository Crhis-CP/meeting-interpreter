/**
 * Spanish text → phonemes (IPA, as espeak-ng's "es-419" writes them: the voices were trained on
 * that), for the natural voices — the speech library no longer ships espeak-ng (GPL), and Spanish
 * spelling is regular enough to do it here: Latin American pronunciation (c/z = s, ll/y = ʝ), the
 * written or default stress, b/d/g softened between vowels, weak vowels as glides (bueno → bwˈeno).
 *
 * Numbers, amounts and abbreviations must already be words (see the reading rules); anything that
 * is not a Spanish letter is dropped, except the punctuation that shapes the intonation.
 */

const STRESSED: Record<string, string> = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u' };
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'á', 'é', 'í', 'ó', 'ú', 'ü']);
/** Words that lean on the next one and carry no stress of their own. */
const UNSTRESSED = new Set(['el', 'la', 'los', 'las', 'lo', 'le', 'les', 'un', 'de', 'del', 'a', 'al', 'y', 'e', 'o', 'u', 'en', 'con', 'por', 'que', 'se', 'me', 'te', 'nos', 'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'sin', 'si', 'ni', 'pero']);

interface Seg {
  /** Phoneme(s) for this letter group. */
  p: string;
  /** A vowel nucleus candidate: 'strong' (a e o, or an accented i/u), 'weak' (i u), or not a vowel. */
  v?: 'strong' | 'weak';
  /** Carries a written accent. */
  accent?: boolean;
}

/** Letters to segments (consonant clusters resolved by context), for one lower-case word. */
function segments(w: string, opts: { affricate: string }): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    const n = w[i + 1] ?? '';
    const prev = w[i - 1] ?? '';
    if (VOWELS.has(c)) {
      if (c === 'ü') out.push({ p: 'u', v: 'weak' });
      else if (STRESSED[c]) out.push({ p: STRESSED[c]!, v: 'strong', accent: true });
      else out.push({ p: c, v: c === 'i' || c === 'u' ? 'weak' : 'strong' });
      continue;
    }
    switch (c) {
      case 'c':
        if (n === 'h') {
          out.push({ p: opts.affricate });
          i++;
        } else out.push({ p: n === 'e' || n === 'i' || n === 'é' || n === 'í' ? 's' : 'k' });
        break;
      case 'q':
        out.push({ p: 'k' });
        if (n === 'u') i++; // the u of que / qui is silent
        break;
      case 'g':
        if (n === 'u' && 'eéií'.includes(w[i + 2] ?? '')) {
          out.push({ p: 'ɡ' });
          i++; // the u of gue / gui is silent (güe is written with ü)
        } else out.push({ p: n === 'e' || n === 'i' || n === 'é' || n === 'í' ? 'x' : 'ɡ' });
        break;
      case 'j':
        out.push({ p: 'x' });
        break;
      case 'h':
        break; // silent
      case 'l':
        if (n === 'l') {
          out.push({ p: 'ʝ' });
          i++;
        } else out.push({ p: 'l' });
        break;
      case 'y':
        // A vowel at the end of a word or alone (hoy, muy, y); a consonant before a vowel.
        if (!n || !VOWELS.has(n)) out.push({ p: 'i', v: 'weak' });
        else out.push({ p: 'ʝ' });
        break;
      case 'ñ':
        out.push({ p: 'ɲ' });
        break;
      case 'r':
        if (n === 'r') {
          out.push({ p: 'r' });
          i++;
        } else out.push({ p: i === 0 || 'lns'.includes(prev) ? 'r' : 'ɾ' });
        break;
      case 'v':
        out.push({ p: 'b' });
        break;
      case 'z':
        out.push({ p: 's' });
        break;
      case 'x':
        out.push({ p: 'ks' });
        break;
      case 'w':
        out.push({ p: 'w' });
        break;
      case 'b':
      case 'd':
      case 'f':
      case 'k':
      case 'm':
      case 'n':
      case 'p':
      case 's':
      case 't':
        out.push({ p: c });
        break;
      default:
        break; // not a Spanish letter: dropped
    }
  }
  return out;
}

/** Marks the nuclei: a weak vowel next to another vowel is a glide (j / w), unless it is accented. */
function nuclei(segs: Seg[]): number[] {
  const idx: number[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (!s.v) continue;
    if (s.v === 'weak' && !s.accent) {
      const before = segs[i - 1]?.v;
      const after = segs[i + 1]?.v;
      // Next to a strong vowel, or before another weak one (ciudad: i glides, u is the nucleus).
      if (after === 'strong' || (after === 'weak' && !segs[i + 1]!.accent) || (before && before !== undefined && idx.at(-1) === i - 1)) {
        s.p = s.p === 'i' ? 'j' : 'w';
        delete s.v;
        continue;
      }
    }
    idx.push(i);
  }
  return idx;
}

/** One word as phonemes with its stress mark (ˈ before the stressed vowel). */
export function wordPhonemes(word: string, opts: { affricate?: string; stress?: boolean } = {}): string {
  const w = word.toLowerCase();
  const segs = segments(w, { affricate: opts.affricate ?? 'tʃ' });
  const nuc = nuclei(segs);
  if (!nuc.length) return segs.map((s) => s.p).join('');
  let stressed = nuc.findIndex((k) => segs[k]!.accent);
  if (stressed < 0) {
    const last = w.replace(/[^a-záéíóúüñ]/g, '').slice(-1);
    // Ending in a vowel, n or s: the second-to-last syllable; otherwise the last.
    stressed = nuc.length === 1 ? 0 : /[aeiouns]/.test(last) ? nuc.length - 2 : nuc.length - 1;
  }
  const noStress = opts.stress === false || (UNSTRESSED.has(w) && nuc.length <= 2 && !segs.some((s) => s.accent));
  return segs.map((s, k) => (!noStress && k === nuc[stressed] ? `ˈ${s.p}` : s.p)).join('');
}

const SOFT: Record<string, string> = { b: 'β', d: 'ð', ɡ: 'ɣ' };

/**
 * A sentence as phonemes: words separated by spaces, punctuation kept (, . ? ! ¿ ¡ become , . ? !),
 * b / d / g softened to β / ð / ɣ except after a pause, a nasal (and l for d), as Spanish speakers do.
 */
export function spanishPhonemes(text: string, opts: { affricate?: string } = {}): string {
  const tokens = text
    .toLowerCase()
    .replace(/[¿¡]/g, ' ')
    .replace(/[;:—–]/g, ',')
    .match(/[a-záéíóúüñ]+|[,.?!]/g) ?? [];
  const words: string[] = [];
  for (const t of tokens) {
    if (/^[,.?!]$/.test(t)) {
      if (words.length) words[words.length - 1] += t;
      continue;
    }
    words.push(wordPhonemes(t, opts));
  }
  // Softening across the phrase (a pause — a comma or full stop — keeps the next one hard).
  let prev = ''; // the phoneme before, '' after a pause
  return words
    .map((w) => {
      let out = '';
      for (const ch of w) {
        if (ch === 'ˈ') {
          out += ch;
          continue;
        }
        if (/[,.?!]/.test(ch)) {
          out += ch;
          prev = '';
          continue;
        }
        if (SOFT[ch] && prev && !'mnɲŋ'.includes(prev) && !(ch === 'd' && prev === 'l')) out += SOFT[ch];
        else out += ch;
        prev = ch;
      }
      // n takes the place of the next consonant: m before b / p / m (enviar → embiar), ŋ before k / g / x.
      out = out.replace(/n(?=ˈ?[bpm])/g, 'm').replace(/n(?=ˈ?[kɡx])/g, 'ŋ');
      return out;
    })
    .join(' ')
    .replace(/n (?=ˈ?[bpm])/g, 'm ')
    .replace(/n (?=ˈ?[kɡx])/g, 'ŋ ');
}
