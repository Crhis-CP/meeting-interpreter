import { describe, expect, it } from 'vitest';
import { accuracy, alignTokens, confusionOf, learnFromEdit, learnFromReading, tokens } from '@core/profile/learn';
import { addCorrections, applyCorrections, emptyProfile, parseProfile, profileHotwords, recordConfusions, removeCorrection, userPairs } from '@core/profile/profile';
import { calibrationScript } from '@core/profile/calibration';
import { correctText } from '@core/glossary/correct';

describe('tokens and alignment', () => {
  it('splits Chinese into characters and Latin text into words, ignoring punctuation', () => {
    expect(tokens('您好，我们用 iPhone 15！', 'zh')).toEqual(['您', '好', '我', '们', '用', 'iphone', '15']);
    expect(tokens('¿Cuándo pueden enviar el pedido?', 'es')).toEqual(['cuándo', 'pueden', 'enviar', 'el', 'pedido']);
  });

  it('aligns with substitutions, insertions and deletions', () => {
    const ops = alignTokens(['新', '方', '案', '的'], ['新', '荒', '案', '了', '的']).map((o) => o.op);
    expect(ops).toEqual(['eq', 'sub', 'eq', 'ins', 'eq']);
  });

  it('scores recognition accuracy (1 − character error rate)', () => {
    expect(accuracy('我们今天讨论价格', '我们今天讨论价格')).toBe(1);
    expect(accuracy('我们今天讨论价格', '我们今天讨论加个')).toBeCloseTo(0.75);
    expect(accuracy('el precio final', 'el precio', 'es')).toBeCloseTo(2 / 3);
    expect(accuracy('', 'x')).toBe(0);
  });
});

describe('learning from a reading (calibration)', () => {
  it('learns how the recogniser hears the user’s own terms', () => {
    const r = learnFromReading('接下来介绍一下星云平台和量子计划。', '接下来介绍一下星云平太和量子极化', 'zh', ['星云平台', '量子计划']);
    expect(r.corrections).toEqual([{ heard: '星云平太', meant: '星云平台' }, { heard: '量子极化', meant: '量子计划' }]);
  });

  it('does not turn everyday words into rules (你好 must stay 你好 for everyone)', () => {
    const r = learnFromReading('您好，我们今天主要讨论新方案的价格。', '你好我们今天主要讨论新航案的价格', 'zh', ['星云平台']);
    expect(r.corrections).toEqual([]);
    expect(r.confusions).toEqual(expect.arrayContaining(['f-h']));
  });

  it('notes the accent pattern behind each mis-hearing', () => {
    const r = learnFromReading('南方市场的年轻客户', '蓝方市场的连轻客户', 'zh');
    expect(r.confusions).toEqual(['l-n', 'l-n']);
    expect(confusionOf('fang', 'huang')).toBeNull(); // two components differ: not one simple pattern
    expect(confusionOf('fa', 'ha')).toBe('f-h');
    expect(confusionOf('zhi', 'zi')).toBe('z-zh');
    expect(confusionOf('xin', 'xing')).toBe('in-ing');
    expect(confusionOf('ri', 'li')).toBe('l-r');
    expect(confusionOf('ma', 'ma')).toBeNull();
  });

  it('learns Spanish / English terms word by word', () => {
    const r = learnFromReading('the Nebula platform launches today', 'the nebular platform launches today', 'en', ['Nebula']);
    expect(r.corrections).toEqual([{ heard: 'nebular', meant: 'Nebula' }]);
    expect(learnFromReading('the Nebula platform', 'the nebular platform', 'en').corrections).toEqual([]);
  });
});

describe('learning from a corrected sentence', () => {
  it('learns what the user fixed', () => {
    expect(learnFromEdit('我们下周把河同发给你们', '我们下周把合同发给你们', 'zh')).toEqual([{ heard: '河同', meant: '合同' }]);
  });
  it('does not learn rewrites', () => {
    expect(learnFromEdit('我们下周把合同发给你们', '我们下个月再说吧', 'zh')).toEqual([]);
  });
});

describe('the personal profile', () => {
  it('merges corrections and counts repeats; explicit edits win over earlier guesses', () => {
    let p = emptyProfile();
    p = addCorrections(p, [{ heard: '新荒案', meant: '新方案' }], 'zh', 'calibration', 1);
    p = addCorrections(p, [{ heard: '新荒案', meant: '新方案' }], 'zh', 'review', 2);
    expect(p.corrections).toHaveLength(1);
    expect(p.corrections[0]).toMatchObject({ count: 2, source: 'review' });
    p = addCorrections(p, [{ heard: '新荒案', meant: '新房案' }], 'zh', 'edit', 3);
    expect(p.corrections[0]).toMatchObject({ meant: '新房案', source: 'edit' });
    p = addCorrections(p, [{ heard: 'same', meant: 'same' }], 'en', 'edit', 4);
    expect(p.corrections).toHaveLength(1);
    p = removeCorrection(p, 'zh', '新荒案');
    expect(p.corrections).toHaveLength(0);
  });

  it('applies corrections for the right language only, longest first', () => {
    let p = emptyProfile();
    p = addCorrections(p, [{ heard: '河同', meant: '合同' }, { heard: '签河同', meant: '签合同' }], 'zh', 'edit', 1);
    p = addCorrections(p, [{ heard: 'nebular', meant: 'Nebula' }], 'en', 'edit', 1);
    expect(applyCorrections('明天签河同。', p.corrections, 'zh')).toEqual({ text: '明天签合同。', edits: [{ from: '签河同', to: '签合同' }] });
    expect(applyCorrections('The nebular team', p.corrections, 'en').text).toBe('The Nebula team');
    expect(applyCorrections('The nebularity', p.corrections, 'en').text).toBe('The nebularity');
    expect(applyCorrections('河同', p.corrections, 'es').text).toBe('河同');
  });

  it('gives the words to listen for, and the user’s accent patterns once seen twice', () => {
    let p = addCorrections(emptyProfile(), [{ heard: '河同', meant: '合同' }], 'zh', 'edit', 1);
    expect(profileHotwords(p, 'zh')).toEqual(['合同']);
    p = recordConfusions(p, ['l-r', 'l-r', 'f-h']);
    expect(userPairs(p)).toEqual(['l-r']);
  });

  it('reads damaged or foreign files safely', () => {
    expect(parseProfile('not json')).toEqual(emptyProfile());
    expect(parseProfile(JSON.stringify({ corrections: [{ heard: 'a' }], version: 1 })).corrections).toEqual([]);
    const ok = addCorrections(emptyProfile(), [{ heard: '河同', meant: '合同' }], 'zh', 'edit', 1);
    expect(parseProfile(JSON.stringify(ok))).toEqual(ok);
  });
});

describe('calibration script', () => {
  it('covers common accent confusions and includes the user’s own terms', () => {
    const s = calibrationScript(['星云平台', 'Nébula', '量子计划']);
    expect(s.length).toBeGreaterThanOrEqual(5);
    expect(s.join('')).toContain('星云平台');
    expect(s.join('')).toContain('量子计划');
    expect(s.join('')).not.toContain('Nébula');
    expect(calibrationScript([]).length).toBe(4);
  });
});

describe('accent patterns widen glossary sound-alike matching', () => {
  it('matches a term mis-heard with the user’s r/l pattern only when that pattern is theirs', () => {
    const entries = [{ id: '1', zh: '日期表', es: 'calendario', aliasesZh: [], aliasesEs: [], note: '', enabled: true }];
    expect(correctText('请看力期标', 'zh', entries, { pinyinFuzzy: true }).text).toBe('请看力期标');
    expect(correctText('请看力期标', 'zh', entries, { pinyinFuzzy: true, extraPairs: ['l-r'] }).text).toBe('请看日期表');
  });
});

describe('moving the profile between devices', () => {
  it('merges an imported profile', async () => {
    const { mergeProfiles, personalFor } = await import('@core/profile/profile');
    const a = recordConfusions(addCorrections(emptyProfile(), [{ heard: '河同', meant: '合同' }], 'zh', 'edit', 1), ['l-n']);
    const b = recordConfusions(addCorrections(emptyProfile(), [{ heard: '河同', meant: '合同' }, { heard: '星云平太', meant: '星云平台' }], 'zh', 'calibration', 2), ['l-n']);
    const m = mergeProfiles(a, b, 3);
    expect(m.corrections.map((c) => [c.heard, c.count])).toEqual([['河同', 2], ['星云平太', 1]]);
    expect(personalFor(m, 'zh')).toEqual({ rules: m.corrections, pairs: ['l-n'], hotwords: ['合同', '星云平台'] });
    expect(personalFor(m, 'es').pairs).toEqual([]);
  });
});
