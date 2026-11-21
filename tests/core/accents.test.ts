import { describe, expect, it } from 'vitest';
import { asSpoken, chineseNumber, contextSyllables, FEATURES, featureCounts, featureOf, featureOfKey, relatedBy } from '@core/profile/accents';
import { FIXED, FOLLOW_UP, calibrationScript, followUpScript } from '@core/profile/calibration';
import { accentEvidence, accuracy, alignTokens, learnFromReading, tokens } from '@core/profile/learn';
import { emptyProfile, recordConfusions, weighFeatureEvidence } from '@core/profile/profile';
import { correctText } from '@core/glossary/correct';
import type { GlossaryEntry } from '@core/glossary/types';

const counts = (text: string) => {
  const t = tokens(asSpoken(text), 'zh');
  return featureCounts(t, alignTokens(t, t), t);
};

describe('accent features', () => {
  it('recognises each regional merge, in the direction it happened', () => {
    const cases: [heard: string, said: string, id: string, key: string][] = [
      ['lan', 'nan', 'l-n', 'n→l'],
      ['fa', 'hua', 'f-hu', 'hu→f'],
      ['hui', 'fei', 'f-hu', 'f→hu'],
      ['fen', 'hun', 'f-hu', 'hu→f'],
      ['fang', 'huang', 'f-hu', 'hu→f'],
      ['zi', 'zhi', 'z-zh', 'zh→z'],
      ['ci', 'chi', 'c-ch', 'ch→c'],
      ['si', 'shi', 's-sh', 'sh→s'],
      ['li', 'ri', 'l-r', 'r→l'],
      ['yin', 'ren', 'r-y', 'r→y'],
      ['you', 'rou', 'r-y', 'r→y'],
      ['yuan', 'ruan', 'r-y', 'r→y'],
      ['xin', 'xing', 'in-ing', 'ing→in'],
      ['fen', 'feng', 'en-eng', 'eng→en'],
      ['ban', 'bang', 'an-ang', 'ang→an'],
      ['jian', 'jiang', 'ian-iang', 'iang→ian'],
      ['guan', 'guang', 'uan-uang', 'uang→uan'],
      ['hong', 'heng', 'eng-ong', 'eng→ong'],
      ['cen', 'cun', 'en-un', 'un→en'],
      ['guo', 'ge', 'e-uo', 'e→uo'],
      ['qi', 'qu', 'i-ü', 'ü→i'],
      ['ni', 'nü', 'i-ü', 'ü→i'],
      ['yi', 'yu', 'i-ü', 'ü→i'],
      ['xian', 'xuan', 'i-ü', 'ü→i'],
      ['zi', 'ji', 'j-z', 'j→z'],
      ['ci', 'qi', 'j-z', 'q→c'],
      ['si', 'xi', 'x-s', 'x→s'],
      ['sao', 'xiao', 'x-s', 'x→s'],
    ];
    for (const [heard, said, id, key] of cases) expect(featureOf(heard, said), `${said} heard as ${heard}`).toEqual({ id, key });
  });

  it('is not fooled by unrelated syllables or by identical ones', () => {
    expect(featureOf('ma', 'ma')).toBeNull();
    expect(featureOf('ba', 'ma')).toBeNull();
    expect(featureOf('lian', 'nan')).toBeNull(); // two things differ that are no merge
    expect(relatedBy('zhang', 'chang')).toBeNull();
  });

  it('every direction key belongs to its feature', () => {
    for (const f of FEATURES) for (const d of f.dirs) expect(featureOfKey(d.key)).toBe(f.id);
  });
});

describe('text as it is said', () => {
  it('reads numbers the way they are spoken', () => {
    expect(chineseNumber(40)).toBe('四十');
    expect(chineseNumber(12)).toBe('十二');
    expect(chineseNumber(105)).toBe('一百零五');
    expect(chineseNumber(2600)).toBe('两千六百');
    expect(chineseNumber(400000)).toBe('四十万');
    expect(chineseNumber(30508)).toBe('三万零五百零八');
    expect(asSpoken('超过40万，打5%的折扣')).toBe('超过四十万，打百分之五的折扣');
    expect(asSpoken('电话13912345678')).toBe('电话一三九一二三四五六七八');
    expect(asSpoken('ＡＢＣ１２')).toBe('ABC十二');
  });

  it('a recogniser writing digits is not counted as mistakes', () => {
    expect(accuracy('如果采购数量超过四十万，打百分之五的折扣。', '如果采购数量超过40万，打5%的折扣')).toBe(1);
  });

  it('reads characters in context (多音字)', () => {
    expect(contextSyllables([...'人民银行'])).toEqual(['ren', 'min', 'yin', 'hang']);
    expect(contextSyllables([...'步行'])).toEqual(['bu', 'xing']);
    expect(contextSyllables([...'重庆'])[0]).toBe('chong');
  });
});

describe('learning from a reading', () => {
  it('catches hu / f, which the old rule missed (both parts of the syllable change)', () => {
    const r = learnFromReading('发票和合同发给黄经理。', '花票和合同发给房经理', 'zh');
    expect(r.confusions).toEqual(['f-hu', 'f-hu']);
    expect(r.features['f→hu']).toEqual({ tested: 2, merged: 1 });
    expect(r.features['hu→f']).toEqual({ tested: 1, merged: 1 });
  });

  it('catches r / y, ü / i and j / z', () => {
    expect(learnFromReading('人民银行', '银民银行', 'zh').confusions).toEqual(['r-y']);
    expect(learnFromReading('去年的区域', '气年的区域', 'zh').confusions).toEqual(['i-ü']);
    expect(learnFromReading('小心细节', '扫心细节', 'zh').confusions).toEqual(['x-s']);
  });

  it('a polyphone read right is not a mistake', () => {
    const r = learnFromReading('人民银行明天发布', '人民银行明天发布', 'zh');
    expect(r.confusions).toEqual([]);
    expect(Object.values(r.features).every((c) => c.merged === 0)).toBe(true);
  });

  it('a correction shows the feature too (everyday learning, no calibration needed)', () => {
    expect(accentEvidence('我们在蓝京开会', '我们在南京开会')).toEqual(['l-n']);
    expect(accentEvidence('我们在南京开会', '我们在杭州开会')).toEqual([]); // a rewrite, not a merge
  });
});

describe('calibration sentences', () => {
  it('give every merge direction at least three chances', () => {
    const total: Record<string, number> = {};
    for (const s of FIXED) for (const [k, c] of Object.entries(counts(s))) total[k] = (total[k] ?? 0) + c.tested;
    for (const f of FEATURES) for (const d of f.dirs) expect(total[d.key] ?? 0, d.key).toBeGreaterThanOrEqual(3);
  });

  it('are short enough to read in about two minutes', () => {
    expect(FIXED).toHaveLength(16);
    for (const s of FIXED) expect([...s.replace(/[，。]/g, '')].length).toBeLessThanOrEqual(18);
  });

  it('the second round tests each feature at least three times', () => {
    for (const f of FEATURES) {
      expect(FOLLOW_UP[f.id], f.id).toHaveLength(2);
      let tested = 0;
      for (const s of FOLLOW_UP[f.id]!) for (const [k, c] of Object.entries(counts(s))) if (featureOfKey(k) === f.id) tested += c.tested;
      expect(tested, f.id).toBeGreaterThanOrEqual(3);
    }
    expect(followUpScript(['l-n', 'f-hu', 'l-n'])).toHaveLength(4);
    expect(followUpScript(FEATURES.map((f) => f.id))).toHaveLength(12); // at most six features
    expect(calibrationScript(['星云平台'])).toHaveLength(17);
  });
});

describe('the profile weighs evidence both ways', () => {
  it('a feature tested without a single merge fades', () => {
    let p = recordConfusions(emptyProfile(), ['l-n', 'l-n', 'l-n', 'l-n', 'f-hu']);
    p = weighFeatureEvidence(p, { 'n→l': { tested: 5, merged: 0 }, 'l→n': { tested: 9, merged: 0 }, 'f→hu': { tested: 2, merged: 0 } }, featureOfKey);
    expect(p.confusions).toEqual({ 'l-n': 2, 'f-hu': 1 }); // f-hu tested only twice: kept
    p = weighFeatureEvidence(p, { 'n→l': { tested: 5, merged: 0 } }, featureOfKey);
    p = weighFeatureEvidence(p, { 'n→l': { tested: 5, merged: 0 } }, featureOfKey);
    expect(p.confusions['l-n']).toBeUndefined();
  });

  it('a feature that merged keeps its count', () => {
    const p = recordConfusions(emptyProfile(), ['l-n', 'l-n']);
    expect(weighFeatureEvidence(p, { 'n→l': { tested: 5, merged: 2 } }, featureOfKey).confusions).toEqual({ 'l-n': 2 });
  });
});

/**
 * Standard Mandarin must never be "corrected": with a business glossary and EVERY accent feature
 * loosened (the most permissive a profile can get), these sentences come out exactly as they went in.
 */
describe('no false corrections', () => {
  const terms = ['星云平台', '华南区', '发票', '合同', '人民币', '南京', '交货期', '利润率', '售后服务', '黄经理', '福州', '软件许可', '绿色包装', '新能源', '冷链物流', '季度报告', '销售额', '区域代理'];
  const entries: GlossaryEntry[] = terms.map((zh, i) => ({ id: `t${i}`, zh, es: `t${i}`, aliases: { zh: [], es: [] }, enabled: true }) as unknown as GlossaryEntry);
  const allFeatures = FEATURES.map((f) => f.id);
  const STANDARD = [
    '大家好，欢迎参加今天的会议。',
    '我们先看一下上个月的销售数据。',
    '这个价格我们需要回去和老板商量。',
    '第一批货可以在三周内发出。',
    '质量问题我们负责免费更换。',
    '保修期是两年，从签收那天开始算。',
    '请把最新的报价单发到我的邮箱。',
    '明天上午十点我们再开一次视频会。',
    '你们那边的工厂在什么地方？',
    '运费由我们这边承担。',
    '如果订单超过一千台，可以再优惠一点。',
    '我们的产品已经出口到二十多个国家。',
    '这款新型号的电池更耐用。',
    '付款方式可以是信用证或者电汇。',
    '样品下周就能寄过去。',
    '我们非常重视这次合作。',
    '能不能把交货时间提前一个星期？',
    '这个问题我需要请示一下领导。',
    '包装的颜色可以按你们的要求定制。',
    '我们公司在广州和上海都有仓库。',
    '今年的市场需求比去年好很多。',
    '请问你们需要多少数量？',
    '我们可以先签一个框架协议。',
    '售价里面已经包含了税费。',
    '这批货的生产周期是四十五天。',
    '有任何问题随时联系我。',
    '他们的技术团队明天到。',
    '我们会安排人员上门安装。',
    '新的物流公司速度更快。',
    '谢谢大家，今天就到这里。',
    '黄河流域的客户也很多。',
    '发展得很快，变化很大。',
    '人们都很喜欢这个设计。',
    '南方的天气比较潮湿。',
    '老李明天去北京出差。',
    '利息和手续费都很低。',
    '软件更新以后速度快了。',
    '绿化工程已经完成了。',
    '这个方案还需要修改。',
    '冷静下来再讨论细节。',
  ];
  it('leaves every standard sentence exactly as it is', () => {
    for (const s of STANDARD) {
      const r = correctText(s, 'zh', entries, { pinyinFuzzy: true, extraPairs: allFeatures });
      expect(r.text, s).toBe(s);
    }
  });
  it('still corrects a real accent mis-hearing of a term (so the test above is not vacuous)', () => {
    expect(correctText('我们去兰京开会', 'zh', entries, { pinyinFuzzy: true, extraPairs: ['l-n'] }).text).toBe('我们去南京开会');
    expect(correctText('这是房经理的意见', 'zh', entries, { pinyinFuzzy: true, extraPairs: ['f-hu'] }).text).toBe('这是黄经理的意见');
  });
});
