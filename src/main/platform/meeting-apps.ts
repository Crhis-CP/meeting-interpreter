import { execFile } from 'node:child_process';

/** Process names of meeting apps, per platform, mapped to the guide id in the UI. */
const PATTERNS: { id: string; win: RegExp; mac: RegExp; linux: RegExp }[] = [
  { id: 'teams', win: /^(ms-teams|teams)\.exe$/i, mac: /Microsoft Teams/i, linux: /teams/i },
  { id: 'feishu', win: /^(feishu|lark)\.exe$/i, mac: /(Feishu|Lark|飞书)/i, linux: /(feishu|lark|bytedance-feishu)/i },
  { id: 'tencent', win: /^(wemeetapp|wemeet)\.exe$/i, mac: /(TencentMeeting|腾讯会议|WeMeet)/i, linux: /wemeet/i },
  { id: 'zoom', win: /^zoom\.exe$/i, mac: /zoom\.us/i, linux: /zoom/i },
  { id: 'dingtalk', win: /^dingtalk\.exe$/i, mac: /DingTalk|钉钉/i, linux: /dingtalk/i },
  { id: 'wecom', win: /^wxwork\.exe$/i, mac: /企业微信|WeCom|WeWork/i, linux: /wxwork/i },
  { id: 'webex', win: /^(webexmta|ciscocollabhost|webex)\.exe$/i, mac: /Webex/i, linux: /webex/i },
];

function listProcesses(): Promise<string[]> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve([]);
        resolve(out.split(/\r?\n/).map((l) => l.split('","')[0]?.replace(/^"/, '') ?? '').filter(Boolean));
      });
    } else {
      execFile('ps', ['-axco', 'command'], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve([]);
        resolve(out.split('\n').map((l) => l.trim()).filter(Boolean));
      });
    }
  });
}

/** Guide ids of meeting apps that are running now (best effort, never throws). */
export async function detectMeetingApps(): Promise<string[]> {
  const procs = await listProcesses();
  const key = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  return PATTERNS.filter((p) => procs.some((name) => p[key].test(name))).map((p) => p.id);
}
