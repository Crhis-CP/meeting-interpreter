/**
 * The voice profile in the Chrome extension and the phone app: imported from the desktop app's
 * voice-profile.json (accent calibration and corrections are made there), kept on the device.
 */
import { emptyProfile, mergeProfiles, ProfileSchema, userPairs, type VoiceProfile } from '../core/profile/profile';

export async function readProfileFile(file: File, current: VoiceProfile = emptyProfile()): Promise<VoiceProfile> {
  if (file.size > 5_000_000) throw new Error('文件太大，不是口音档案');
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('这个文件不是会议同传的口音档案');
  }
  const r = ProfileSchema.safeParse(data);
  if (!r.success) throw new Error('这个文件不是会议同传的口音档案');
  return mergeProfiles(current, r.data);
}

export function profileSummary(p: VoiceProfile): string {
  if (!p.corrections.length && !Object.keys(p.confusions).length) return '还没有导入';
  const pairs = userPairs(p);
  return `${p.corrections.length} 条纠错${pairs.length ? `，口音特点：${pairs.map((x) => x.replace('-', '/')).join('、')}` : ''}`;
}

export function profileJson(p: VoiceProfile): string {
  return JSON.stringify(p, null, 2);
}
