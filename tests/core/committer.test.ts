import { describe, expect, it } from 'vitest';
import { Committer } from '@core/pipeline/committer';
import { cleanTranslation, isValidTranslation } from '@core/pipeline/validate';

describe('Committer', () => {
  it('commits a final-only sentence whole', () => {
    const c = new Committer({ base: 'zh' });
    expect(c.onFinal('大家好，我们开始开会吧。', 0)).toEqual(['大家好，我们开始开会吧。']);
  });

  it('commits a stable clause early and only the remainder on final', () => {
    const c = new Committer({ base: 'zh', stableMs: 700 });
    expect(c.onPartial('我们今天主要讨论一下交货期，然后', 0)).toEqual([]);
    expect(c.onPartial('我们今天主要讨论一下交货期，然后再看', 400)).toEqual([]);
    expect(c.onPartial('我们今天主要讨论一下交货期，然后再看价格', 800)).toEqual(['我们今天主要讨论一下交货期，']);
    expect(c.onFinal('我们今天主要讨论一下交货期，然后再看价格。', 1200)).toEqual(['然后再看价格。']);
  });

  it('does not commit a clause that changed before it was stable', () => {
    const c = new Committer({ base: 'zh', stableMs: 700 });
    c.onPartial('我们今天主要讨论交火期，然后', 0);
    expect(c.onPartial('我们今天主要讨论交货期，然后', 500)).toEqual([]);
    expect(c.onPartial('我们今天主要讨论交货期，然后再', 900)).toEqual([]);
    expect(c.onPartial('我们今天主要讨论交货期，然后再说', 1300)).toEqual(['我们今天主要讨论交货期，']);
  });

  it('needs enough content before committing early', () => {
    const c = new Committer({ base: 'zh', stableMs: 100 });
    c.onPartial('好的，那个', 0);
    expect(c.onPartial('好的，那个', 500)).toEqual([]);
  });

  it('commits the remainder after the common prefix when the final diverges', () => {
    const c = new Committer({ base: 'zh', stableMs: 100 });
    c.onPartial('我们今天主要讨论一下交货期，然后', 0);
    expect(c.onPartial('我们今天主要讨论一下交货期，然后', 200)).toHaveLength(1);
    expect(c.onFinal('我们今天主要讨论一下交付周期，然后再看价格。', 900)).toEqual(['交付周期，然后再看价格。']);
  });

  it('commits only on finals when low latency is off', () => {
    const c = new Committer({ base: 'es', lowLatency: false, stableMs: 0 });
    expect(c.onPartial('Buenos días a todos, hoy vamos a', 0)).toEqual([]);
    expect(c.onPartial('Buenos días a todos, hoy vamos a', 1000)).toEqual([]);
    expect(c.onFinal('Buenos días a todos, hoy vamos a hablar del contrato.', 2000)).toEqual(['Buenos días a todos, hoy vamos a hablar del contrato.']);
  });

  it('counts Spanish words for early clauses', () => {
    const c = new Committer({ base: 'es', stableMs: 100 });
    c.onPartial('Muchas gracias por venir hoy, vamos', 0);
    expect(c.onPartial('Muchas gracias por venir hoy, vamos a', 300)).toEqual(['Muchas gracias por venir hoy,']);
    expect(c.onFinal('Muchas gracias por venir hoy, vamos a empezar.', 900)).toEqual(['vamos a empezar.']);
  });

  it('ignores empty or punctuation-only finals', () => {
    const c = new Committer({ base: 'zh' });
    expect(c.onFinal('。', 0)).toEqual([]);
    expect(c.onFinal('  ', 0)).toEqual([]);
  });
});

describe('translation validation', () => {
  it('cleans wrappers', () => {
    expect(cleanTranslation('"Hola a todos."')).toBe('Hola a todos.');
    expect(cleanTranslation('译文：大家好')).toBe('大家好');
    expect(cleanTranslation('Translation: Hola (Note: informal)')).toBe('Hola');
  });

  it('accepts and rejects by script', () => {
    expect(isValidTranslation('Buenos días a todos', 'es-ES', '大家早上好')).toBe(true);
    expect(isValidTranslation('大家早上好', 'es-ES', '大家早上好')).toBe(false);
    expect(isValidTranslation('Hablemos con 张总 mañana', 'es-ES', '明天和张总谈')).toBe(true);
    expect(isValidTranslation('大家早上好', 'zh-CN', 'Buenos días a todos')).toBe(true);
    expect(isValidTranslation('Buenos días a todos', 'zh-CN', 'Buenos días a todos')).toBe(false);
    expect(isValidTranslation('OK', 'zh-CN', 'Vale')).toBe(true);
    expect(isValidTranslation('', 'zh-CN', 'Hola')).toBe(false);
    expect(isValidTranslation('...', 'es-ES', '嗯')).toBe(false);
  });
});
