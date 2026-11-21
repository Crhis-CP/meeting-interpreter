/**
 * The text read aloud for accent calibration (about two minutes). Sixteen short sentences in
 * ordinary business wording, written so that every sound merge of regional Mandarin
 * (docs/accents.md) can show at least three times in each direction — checked by a test — with
 * names and numbers in them. The user's own glossary terms are read in extra sentences so the app
 * learns how the recogniser hears them. A short second round re-tests only what did not pass.
 */
export const FIXED = [
  '南方的农民今年收入涨了四成。',
  '老李让我把发票和合同发给黄经理。',
  '飞机下午三点到上海，司机姓张。',
  '采购部这次参加展会，仓库没出错。',
  '请把四十四份材料送到市场部。',
  '人民银行明天发布新的利率。',
  '国外客户说绿色的款式卖得最好。',
  '去年冬天，我们在重庆开了分公司。',
  '王先生的电话是一五零三六八九四二七。',
  '软件更新以后，用户可以免费试用。',
  '刘总认为双方的成本还能再降一点。',
  '我们准时交货，损坏的部分全部换新。',
  '生产线上周停了三天，现在恢复正常。',
  '赵经理和孙经理下星期从广州来深圳。',
  '合同里写过的数量是两千六百台。',
  '小徐说这个月的学费已经交了。',
];

/** Sentences dense in one feature, for the second round (each word pair differs only in it). */
export const FOLLOW_UP: Readonly<Record<string, readonly string[]>> = {
  'l-n': ['牛奶和留言不能弄乱。', '男女老年人都能领到奖励。'],
  'f-hu': ['花费和回复都发给胡总。', '黄方案和放款时间换一下。'],
  'f-h': ['飞行费用和黑色封面。', '发货以后恢复服务。'],
  'z-zh': ['资金和支票都在总账里。', '自主制造的产品最早上市。'],
  'c-ch': ['采购成本和仓储超出预算。', '从厂家出发，次日抽查。'],
  's-sh': ['四十四个商品试销三十天。', '损失和市场数据在手册上。'],
  'l-r': ['日程和利润都很热门。', '人力成本让利润变少。'],
  'r-y': ['人员热情，认真负责。', '软件让用户容易上手。'],
  'in-ing': ['新型金属，信用良好。', '品质和平均价格都稳定。'],
  'en-eng': ['分成和风险都要认真评估。', '本月成本增加了一成。'],
  'an-ang': ['帮忙安排，按时上班。', '方案和样品都放在展厅。'],
  'ian-iang': ['先讲价钱，再签合同。', '电线的长度要量一下。'],
  'uan-uang': ['关于光纤的管理办法。', '双方转账要按规定办。'],
  'eng-ong': ['风险控制和公司政策。', '共同承担，等待通知。'],
  'en-un': ['存款和人员都已经准备好。', '损失很轻，顺利完成。'],
  'e-uo': ['哥哥的国外客户很多。', '合作伙伴的火车到了。'],
  'i-ü': ['去年的区域旅游预算。', '绿色的原料下个月运到。'],
  'j-z': ['鸡精和酒精都要检测。', '七月起价格降低。'],
  'x-s': ['小心细节，先写报告。', '西安的销售信息已经更新。'],
};

const HAN = /\p{Script=Han}/u;

/** The sentences to read: the fixed sixteen, then up to four of the user's Chinese terms, two per sentence. */
export function calibrationScript(terms: string[]): string[] {
  const mine = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 12 && HAN.test(t)))].slice(0, 4);
  const extra: string[] = [];
  for (let i = 0; i < mine.length; i += 2) {
    const pair = mine.slice(i, i + 2);
    extra.push(pair.length === 2 ? `接下来介绍一下${pair[0]}和${pair[1]}。` : `接下来介绍一下${pair[0]}。`);
  }
  return [...FIXED, ...extra];
}

/** The second round: two sentences for each feature that showed in the first (at most six features). */
export function followUpScript(features: string[]): string[] {
  return [...new Set(features)].filter((f) => FOLLOW_UP[f]).slice(0, 6).flatMap((f) => FOLLOW_UP[f]!);
}
