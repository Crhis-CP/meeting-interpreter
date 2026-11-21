import { describe, expect, it } from 'vitest';
import { fileLabel } from '../src/renderer/src/lib/file-label';

describe('meeting files in words', () => {
  it('names what each file is; developer formats say they are the software’s data', () => {
    expect(fileLabel('transcript.md')).toBe('双语记录（可直接阅读）');
    expect(fileLabel('transcript.jsonl')).toBe('双语记录（软件用的数据）');
    expect(fileLabel('audio/mix.m4a')).toBe('会议录音');
    expect(fileLabel('audio/mix-2.m4a')).toBe('会议录音（第 2 段）');
    expect(fileLabel('screen-3.mp4')).toBe('会议录屏（第 3 段）');
    expect(fileLabel('screen.bilingual.srt')).toBe('双语字幕（配合录屏）');
    expect(fileLabel('audio/mic.wav')).toBe('我的原声');
    expect(fileLabel('notes.txt')).toBe('notes.txt');
  });
});
