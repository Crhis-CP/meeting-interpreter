/**
 * The text read aloud for accent calibration (about a minute). The four fixed sentences cover the
 * sound pairs Chinese accents most often merge (n/l, f/h, z/zh, c/ch, s/sh, r/l, an/ang, en/eng,
 * in/ing) in ordinary business wording; the user's own glossary terms are read in extra sentences
 * so the app learns how the recogniser hears them.
 */
const FIXED = [
  '您好，我们今天主要讨论新方案的价格、质量和交货日期。',
  '如果采购数量超过四十万，利润和成本都要重新计算。',
  '发货以后，我们会安排售后服务，并且尽快把合同发给您。',
  '南方市场的年轻客户很喜欢这个品牌，银行付款也很方便。',
];

const HAN = /\p{Script=Han}/u;

/** The sentences to read: the fixed four, then up to four of the user's Chinese terms, two per sentence. */
export function calibrationScript(terms: string[]): string[] {
  const mine = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 12 && HAN.test(t)))].slice(0, 4);
  const extra: string[] = [];
  for (let i = 0; i < mine.length; i += 2) {
    const pair = mine.slice(i, i + 2);
    extra.push(pair.length === 2 ? `接下来介绍一下${pair[0]}和${pair[1]}。` : `接下来介绍一下${pair[0]}。`);
  }
  return [...FIXED, ...extra];
}
