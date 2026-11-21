import { describe, expect, it } from 'vitest';
import { numberWords, spanishForSpeech } from '@core/speech-text/es-read';

describe('how Spanish text is read aloud', () => {
  it('numbers in words', () => {
    expect(numberWords(0)).toBe('cero');
    expect(numberWords(21)).toBe('veintiuno');
    expect(numberWords(45)).toBe('cuarenta y cinco');
    expect(numberWords(100)).toBe('cien');
    expect(numberWords(101)).toBe('ciento uno');
    expect(numberWords(1500)).toBe('mil quinientos');
    expect(numberWords(21000)).toBe('veintiún mil');
    expect(numberWords(1_000_000)).toBe('un millón');
    expect(numberWords(2_500_000)).toBe('dos millones quinientos mil');
    expect(numberWords(2026)).toBe('dos mil veintiséis');
  });

  it('thousands and decimals written either way', () => {
    expect(spanishForSpeech('Son 1.500 unidades.')).toBe('Son mil quinientas unidades.');
    expect(spanishForSpeech('Son 1,500 contenedores.')).toBe('Son mil quinientos contenedores.');
    expect(spanishForSpeech('Llegan 21 cajas en 3 días.')).toBe('Llegan veintiuna cajas en tres días.');
    expect(spanishForSpeech('Son 1 caja y 1 problema.')).toBe('Son una caja y un problema.');
    expect(spanishForSpeech('Crece 3,5 puntos.')).toBe('Crece tres coma cinco puntos.');
    expect(spanishForSpeech('Total 1.500,75')).toBe('Total mil quinientos coma setenta y cinco');
  });

  it('amounts, percentages, times and dates', () => {
    expect(spanishForSpeech('Cuesta US$ 200 por unidad.')).toBe('Cuesta doscientos dólares por unidad.');
    expect(spanishForSpeech('Son 12 USD cada una.')).toBe('Son doce dólares cada una.');
    expect(spanishForSpeech('Cuesta $1 nada más.')).toBe('Cuesta un dólar nada más.');
    expect(spanishForSpeech('Un descuento del 5%.')).toBe('Un descuento del cinco por ciento.');
    expect(spanishForSpeech('La reunión es a las 15:30.')).toBe('La reunión es a las quince y treinta.');
    expect(spanishForSpeech('A las 9:05 h.')).toBe('A las nueve y cero cinco.');
    expect(spanishForSpeech('Llega el 21/11.')).toBe('Llega el veintiuno de noviembre.');
    expect(spanishForSpeech('Desde el 1/3/2027.')).toBe('Desde el primero de marzo de dos mil veintisiete.');
  });

  it('codes and model numbers as written; acronyms spelled', () => {
    expect(spanishForSpeech('El modelo X-500 y el A3.')).toBe('El modelo equis cinco cero cero y el a tres.');
    expect(spanishForSpeech('Hablé con el CEO, más IVA.')).toBe('Hablé con el ceo, más iva.');
    expect(spanishForSpeech('Lo manda DHL.')).toBe('Lo manda de hache ele.');
  });

  it('a sentence without numbers is unchanged', () => {
    expect(spanishForSpeech('Buenos días, ¿cómo están?')).toBe('Buenos días, ¿cómo están?');
  });
});
