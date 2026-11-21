import { describe, expect, it } from 'vitest';
import { spanishPhonemes, wordPhonemes } from '@core/speech-text/es-phonemes';

describe('Spanish phonemes for the natural voices (espeak-ng es-419 style)', () => {
  it('puts the stress where Spanish does: the accent, else the second-to-last or last syllable', () => {
    expect(wordPhonemes('pedido')).toBe('pedˈido');
    expect(wordPhonemes('entregar')).toBe('entɾeɡˈaɾ');
    expect(wordPhonemes('días')).toBe('dˈias');
    expect(wordPhonemes('país')).toBe('paˈis');
    expect(wordPhonemes('jamón')).toBe('xamˈon');
    expect(wordPhonemes('de')).toBe('de'); // a little word leaning on the next
  });

  it('reads Latin American Spanish: c/z as s, ll/y as ʝ, silent h and u, glides', () => {
    expect(wordPhonemes('ciudad')).toBe('sjudˈad');
    expect(wordPhonemes('llave')).toBe('ʝˈabe');
    expect(wordPhonemes('hoy')).toBe('ˈoj');
    expect(wordPhonemes('muy')).toBe('mwˈi');
    expect(wordPhonemes('queso')).toBe('kˈeso');
    expect(wordPhonemes('guerra')).toBe('ɡˈera');
    expect(wordPhonemes('pingüino')).toBe('pinɡwˈino');
    expect(wordPhonemes('gente')).toBe('xˈente');
    expect(wordPhonemes('niño')).toBe('nˈiɲo');
    expect(wordPhonemes('chico', { affricate: 'ʧ' })).toBe('ʧˈiko');
  });

  it('softens b / d / g between sounds, assimilates n, keeps the punctuation', () => {
    expect(spanishPhonemes('Buenos días, ¿cuándo pueden entregar el primer pedido?')).toBe('bwˈenos ðˈias, kwˈando pwˈeðen entɾeɣˈaɾ el pɾimˈeɾ peðˈiðo?');
    expect(spanishPhonemes('Podrá ser enviada en cinco semanas.')).toBe('poðɾˈa sˈeɾ embjˈaða en sˈiŋko semˈanas.');
  });

  it('drops what is not a Spanish letter (numbers must be words by then)', () => {
    expect(spanishPhonemes('Hola #3 @todos')).toBe('ˈola tˈoðos');
  });
});
