/** What a file of a meeting folder is, in words (the file name stays below it). */
export function fileLabel(rel: string): string {
  const name = rel.split('/').pop() ?? rel;
  const part = /-(\d+)\.\w+$/.exec(name)?.[1];
  const nth = part ? `（第 ${part} 段）` : '';
  if (/^transcript\.md$/.test(name)) return '双语记录（可直接阅读）';
  if (/^transcript\.jsonl$/.test(name)) return '双语记录（软件用的数据）';
  if (/\.bilingual\.srt$/.test(name)) return '双语字幕（配合录屏）';
  if (/\.srt$/.test(name)) return '字幕';
  if (/^summary.*\.md$/.test(name)) return '会议纪要';
  if (/^summary.*\.json$/.test(name)) return '会议纪要（软件用的数据）';
  if (/^meeting\.json$/.test(name)) return '会议信息（软件用的数据）';
  if (/^review\.json$/.test(name)) return '会后学习记录（软件用的数据）';
  if (/^mix(-\d+)?\.(m4a|webm)$/.test(name)) return `会议录音${nth}`;
  if (/^screen(-\d+)?\.(mp4|webm)$/.test(name)) return `会议录屏${nth}`;
  if (/^mic\.wav$/.test(name)) return '我的原声';
  if (/^meeting\.wav$/.test(name)) return '对方的原声';
  return name;
}
