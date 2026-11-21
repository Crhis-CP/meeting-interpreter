/**
 * How Spanish text is read aloud (before it becomes phonemes): numbers, amounts, percentages,
 * times and dates as words, common abbreviations spelled out — "1.500" is mil quinientos, "5%"
 * cinco por ciento, "US$ 200" doscientos dólares, "15:30" las quince y treinta.
 *
 * Only what is certainly a number, an amount or a date changes; a model number like "X-500" or a
 * code like "A3" is read as written (letter by letter / digit by digit). The subtitles and the
 * transcript keep the text as it was: this is only what the voice says.
 */

const UNITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const TENS = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function below1000(n: number): string {
  if (n === 100) return 'cien';
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest = r < 30 ? (r ? UNITS[r]! : '') : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` y ${UNITS[r % 10]}` : ''}`;
  return [HUNDREDS[h], rest].filter(Boolean).join(' ');
}

/** A whole number in words (up to 999 999 999 999); "uno" stays "uno" (see `beforeNoun`). */
export function numberWords(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n >= 1e12 || !Number.isInteger(n)) return String(n);
  if (n < 1000) return n === 0 ? 'cero' : below1000(n);
  const parts: string[] = [];
  const billions = Math.floor(n / 1e9);
  const millions = Math.floor((n % 1e9) / 1e6);
  const thousands = Math.floor((n % 1e6) / 1000);
  const rest = n % 1000;
  if (billions) parts.push(billions === 1 ? 'mil millones' : `${beforeNoun(below1000(billions))} mil millones`);
  if (millions) parts.push(millions === 1 ? 'un millón' : `${beforeNoun(numberWords(millions))} millones`);
  if (thousands) parts.push(thousands === 1 ? 'mil' : `${beforeNoun(below1000(thousands))} mil`);
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

/** "uno" before a noun is "un" (veintiún, un millón). */
function beforeNoun(words: string): string {
  return words.replace(/veintiuno$/, 'veintiún').replace(/\buno$/, 'un');
}

/**
 * A written number, Spanish style (1.500,75) or English style (1,500.75) — translations write
 * both: one kind of separator in groups of exactly three digits is thousands (1.500, 2,500,000);
 * otherwise the last separator is the decimal point (3,5 · 3.5 · 1.500,75 · 1,500.75).
 */
function parseNumber(s: string): { int: number; dec: string } | null {
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const seps = s.match(/[.,]/g) ?? [];
  if (!seps.length) return { int: Number(s), dec: '' };
  if (new Set(seps).size === 1 && /^\d{1,3}([.,]\d{3})+$/.test(s)) return { int: Number(s.replace(/[.,]/g, '')), dec: '' };
  const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  if (seps.slice(0, -1).includes(s[last]!)) return null;
  return { int: Number(s.slice(0, last).replace(/[.,]/g, '')), dec: s.slice(last + 1) };
}

/** Masculine words ending like feminine ones. */
const MASCULINE_A = /^(d[ií]as?|problemas?|sistemas?|programas?|temas?|idiomas?|mapas?|planetas?|climas?|dramas?|esquemas?|lemas?|poemas?)$/i;

/** The number agrees with a feminine noun after it: doscientas unidades, veintiuna cajas. */
function feminine(next?: string): boolean {
  const w = next?.trim() ?? '';
  return !MASCULINE_A.test(w) && /(?:as?|ión|iones|dad|dades|tud|tudes|umbre|umbres)$/i.test(w);
}

function readNumber(s: string, noun = false, next?: string): string {
  const p = parseNumber(s);
  if (!p) return s;
  let int = noun ? beforeNoun(numberWords(p.int)) : numberWords(p.int);
  if (!p.dec && feminine(next)) int = int.replace(/ientos\b/g, 'ientas').replace(/veintiún$/, 'veintiuna').replace(/\bun$/, 'una');
  if (!p.dec) return int;
  // 3,5 → tres coma cinco; 2,05 → dos coma cero cinco
  const dec = p.dec.length <= 2 && !p.dec.startsWith('0') ? numberWords(Number(p.dec)) : [...p.dec].map((d) => UNITS[Number(d)]).join(' ');
  return `${int} coma ${dec}`;
}

const CURRENCY: [RegExp, string, string][] = [
  [/(?:US\$|USD|U\$S|u\$s)/, 'dólar', 'dólares'],
  [/(?:€|EUR)/, 'euro', 'euros'],
  [/(?:RMB|CNY|¥|元)/, 'yuan', 'yuanes'],
  [/(?:ARS|AR\$)/, 'peso', 'pesos'],
];
const NUM = String.raw`\d[\d.,]*\d|\d`;

/** Abbreviations read out as words (the voices would otherwise spell or skip them). */
const ABBREVIATIONS: [RegExp, string][] = [
  [/\bS\.?\s?A\.(?=\s|$|[,;])/g, 'ese a'],
  [/\bS\.?R\.?L\.?(?=\s|$|[,;])/g, 'ese erre ele'],
  [/\bN\.?º\s?(?=\d)/g, 'número '],
  [/\bnº\s?(?=\d)/gi, 'número '],
  [/\bkm\b/g, 'kilómetros'],
  [/\bkg\b/g, 'kilos'],
  [/\bcm\b/g, 'centímetros'],
  [/\bm²/g, 'metros cuadrados'],
  [/\bIVA\b/g, 'iva'],
  [/\bCEO\b/g, 'ceo'],
  [/\bOK\b/gi, 'okey'],
];

/** Letters of an acronym the voices would read as a word, spelled the Spanish way. */
const LETTER: Record<string, string> = { A: 'a', B: 'be', C: 'ce', D: 'de', E: 'e', F: 'efe', G: 'ge', H: 'hache', I: 'i', J: 'jota', K: 'ka', L: 'ele', M: 'eme', N: 'ene', Ñ: 'eñe', O: 'o', P: 'pe', Q: 'cu', R: 'erre', S: 'ese', T: 'te', U: 'u', V: 've', W: 'doble ve', X: 'equis', Y: 'ye', Z: 'zeta' };

/** The words a Spanish voice should say for this text. */
export function spanishForSpeech(text: string): string {
  let s = ` ${text} `;
  // Times: 15:30, 9:05 h
  s = s.replace(/(\d{1,2}):(\d{2})\s?(?:h|hs)?\b/g, (_m, h: string, mi: string) => `${numberWords(Number(h))}${Number(mi) ? ` y ${Number(mi) < 10 ? `cero ${numberWords(Number(mi))}` : numberWords(Number(mi))}` : ''}`);
  // Dates: 21/11/2026, 21/11
  s = s.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g, (m, d: string, mo: string, y?: string) => {
    const month = MONTHS[Number(mo) - 1];
    if (!month || Number(d) < 1 || Number(d) > 31) return m;
    return `${Number(d) === 1 ? 'primero' : numberWords(Number(d))} de ${month}${y ? ` de ${numberWords(Number(y))}` : ''}`;
  });
  // Amounts: US$ 200 / 200 USD / $200 (dollars where "$" stands alone: what a translation means by it)
  for (const [re, one, many] of CURRENCY) {
    s = s.replace(new RegExp(String.raw`${re.source}\s?(${NUM})`, 'g'), (_m, n: string) => `${readNumber(n, true)} ${parseNumber(n)?.int === 1 && !parseNumber(n)?.dec ? one : many}`);
    s = s.replace(new RegExp(String.raw`(${NUM})\s?${re.source}`, 'g'), (_m, n: string) => `${readNumber(n, true)} ${parseNumber(n)?.int === 1 && !parseNumber(n)?.dec ? one : many}`);
  }
  s = s.replace(new RegExp(String.raw`\$\s?(${NUM})`, 'g'), (_m, n: string) => `${readNumber(n, true)} ${parseNumber(n)?.int === 1 && !parseNumber(n)?.dec ? 'dólar' : 'dólares'}`);
  // Percentages: 5%, 5 %
  s = s.replace(new RegExp(String.raw`(${NUM})\s?%`, 'g'), (_m, n: string) => `${readNumber(n)} por ciento`);
  for (const [re, w] of ABBREVIATIONS) s = s.replace(re, w);
  // Codes and model numbers (letters and digits together: X-500, A3, B2B): as written, digit by digit.
  s = s.replace(/\b([A-ZÑ]+)[-‑]?(\d+)\b/g, (_m, l: string, d: string) => `${[...l].map((c) => LETTER[c] ?? c).join(' ')} ${[...d].map((x) => UNITS[Number(x)]).join(' ')}`);
  // Ordinary numbers; "1" before a noun-like word is "un".
  s = s.replace(new RegExp(String.raw`(?<![\p{L}\d])(${NUM})(?![\p{L}\d])(\s+\p{L}+)?`, 'gu'), (_m, n: string, next?: string) => `${readNumber(n, !!next, next)}${next ?? ''}`);
  // Acronyms of 2–4 capitals that are not words (USD, EE.UU. aside): spelled.
  s = s.replace(/\b([A-ZÑ]{2,4})\b/g, (m) => (/[AEIOU]/.test(m) && m.length > 3 ? m : [...m].map((c) => LETTER[c] ?? c).join(' ')));
  return s.replace(/\s+/g, ' ').trim();
}
