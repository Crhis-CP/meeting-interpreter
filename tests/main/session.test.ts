import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPreset } from '@core/config/presets';
import { defaultSettings } from '@core/config/schema';
import { decodeWav } from '@core/audio/wav';
import { concatInt16, silence, tone } from '@core/audio/pcm';
import { createLogger } from '@core/log';
import { MockAsr, MockLlm, MockTranslator, MockTts } from '@core/providers/mock';
import { SessionManager, type ProviderSet } from '../../src/main/session/session-manager';
import { WavFileWriter } from '../../src/main/session/wav-writer';
import { SettingsStore } from '../../src/main/stores/settings-store';
import { SecretStore } from '../../src/main/stores/secret-store';
import { GlossaryStore } from '../../src/main/stores/glossary-store';
import { MeetingsStore } from '../../src/main/stores/meetings-store';
import type { ToAudio } from '../../src/shared/ipc';
import { waitFor } from '../helpers/fakes';

const tmp = () => mkdtempSync(join(tmpdir(), 'mi-test-'));

describe('stores', () => {
  it('persists and validates settings, keeping a backup of corrupt files', () => {
    const dir = tmp();
    const s = new SettingsStore(dir);
    s.set({ languages: { remote: 'es-AR' }, interpretation: { duckLevel: 0.4 } });
    expect(new SettingsStore(dir).get().languages.remote).toBe('es-AR');
    expect(new SettingsStore(dir).get().interpretation.duckLevel).toBe(0.4);
    writeFileSync(join(dir, 'settings.json'), '{not json');
    expect(new SettingsStore(dir).get().languages.remote).toBe('es-MX'); // defaults after a corrupt file
    const p = new SettingsStore(dir).applyPreset('dashscope');
    expect(p.out.asr).toBe('dashscope');
    expect(p.llm.preset).toBe('qwen');
  });

  it('never writes secrets in plain text when encryption is available', () => {
    const dir = tmp();
    const safe = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s.split('').reverse().join('')),
      decryptString: (b: Buffer) => b.toString().split('').reverse().join(''),
    };
    const store = new SecretStore(dir, safe);
    store.set('dashscope', 'sk-supersecret123');
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toContain('supersecret');
    expect(new SecretStore(dir, safe).get('dashscope')).toBe('sk-supersecret123');
    expect(new SecretStore(dir, safe).status().dashscope).toBe(true);
    store.set('dashscope', '');
    expect(new SecretStore(dir, safe).status().dashscope).toBe(false);
  });

  it('seeds glossaries and returns only enabled entries', () => {
    const g = new GlossaryStore(tmp());
    expect(g.list().map((x) => x.id)).toEqual(['default', 'sample-trade']);
    expect(g.active()).toEqual([]); // sample is disabled
    g.addEntries('default', [{ id: '', zh: '星云', es: 'Nébula', aliasesZh: [], aliasesEs: [], note: '', enabled: true }]);
    expect(g.active().map((e) => e.zh)).toEqual(['星云']);
  });
});

describe('WavFileWriter', () => {
  it('keeps a valid header after each flush and pads gaps', () => {
    const p = join(tmp(), 'a.wav');
    const w = new WavFileWriter(p, 16000);
    w.write(tone(1.2, 440, 16000));
    // Without close, the header must already describe the data written so far.
    const mid = decodeWav(new Uint8Array(readFileSync(p)));
    expect(mid.samples.length).toBeGreaterThanOrEqual(16000);
    w.padTo(2);
    w.close();
    expect(decodeWav(new Uint8Array(readFileSync(p))).samples.length).toBe(32000);
  });
});

describe('SessionManager', () => {
  it('records a demo meeting end to end', async () => {
    const dir = tmp();
    const settings = applyPreset(defaultSettings(), 'demo');
    settings.devices.meetingSource = 'device';
    settings.summary.autoAtEnd = true;
    const sent: ToAudio[] = [];
    const providers: ProviderSet = {
      asr: (d) => new MockAsr(d === 'out' ? 'self' : 'remote'),
      mt: () => new MockTranslator(),
      tts: () => new MockTts(),
      llm: () => new MockLlm(),
      describe: () => ({ out: 'demo', in: 'demo' }),
    };
    const sm = new SessionManager({
      settings: () => settings,
      glossary: () => [],
      providers: () => providers,
      recordsDir: () => dir,
      toAudio: (m) => sent.push(m),
      broadcast: () => {},
      log: createLogger('test'),
    });
    await sm.start({ title: '测试会议' });
    expect(sent[0]!.type).toBe('start');
    const speech = concatInt16([tone(1, 300, 16000), silence(1, 16000)]);
    for (const dirn of ['out', 'in'] as const) {
      for (let i = 0; i < speech.length; i += 1600) {
        const chunk = speech.slice(i, i + 1600);
        sm.handleAudio({ type: 'pcm', dir: dirn, pcm: chunk.buffer });
      }
    }
    await waitFor(() => sm.segments().filter((s) => s.status === 'done').length === 2, 4000);
    await waitFor(() => sent.some((m) => m.type === 'tts' && m.dir === 'in'), 4000);
    const meta = await sm.stop();
    expect(meta).not.toBeNull();
    const folder = new MeetingsStore(() => dir).folder(meta!.id);
    for (const f of ['meeting.json', 'transcript.jsonl', 'transcript.md', 'transcript.zh.srt', 'transcript.es.srt', 'audio/mic.wav', 'audio/meeting.wav']) {
      expect(existsSync(join(folder, f)), f).toBe(true);
    }
    const md = readFileSync(join(folder, 'transcript.md'), 'utf8');
    expect(md).toContain('大家好，欢迎参加今天的会议。');
    expect(md).toContain('Hola, encantado de conocerlos.');
    expect(decodeWav(new Uint8Array(readFileSync(join(folder, 'audio/mic.wav')))).samples.length).toBeGreaterThan(16000);
    // Auto-summary needs 3+ lines; generate it explicitly for this short meeting.
    expect(existsSync(join(folder, 'summary.zh.md'))).toBe(false);
    const detail0 = new MeetingsStore(() => dir).get(meta!.id)!;
    await sm.writeSummary(folder, detail0.meta, detail0.segments, new MockLlm(), 'general');
    expect(existsSync(join(folder, 'summary.es.md'))).toBe(true);
    const list = new MeetingsStore(() => dir).list();
    expect(list[0]!.segments).toBe(2);
    expect(list[0]!.hasSummary).toBe(true);
    const detail = new MeetingsStore(() => dir).get(meta!.id)!;
    expect(detail.summary!.todos.length).toBe(1);
    expect(() => new MeetingsStore(() => dir).get('../etc')).toThrow();
  });

  it('switches the Chinese voice off when system loopback would capture it', async () => {
    const dir = tmp();
    const settings = applyPreset(defaultSettings(), 'demo');
    settings.devices.meetingSource = 'loopback';
    const sent: ToAudio[] = [];
    const providers: ProviderSet = {
      asr: (d) => new MockAsr(d === 'out' ? 'self' : 'remote'),
      mt: () => new MockTranslator(),
      tts: () => new MockTts(),
      llm: () => null,
      describe: () => ({}),
    };
    const sm = new SessionManager({ settings: () => settings, glossary: () => [], providers: () => providers, recordsDir: () => dir, toAudio: (m) => sent.push(m), broadcast: () => {}, log: createLogger('test') });
    await sm.start({});
    expect(sm.state.in.speak).toBe(true);
    sm.handleAudio({ type: 'started', loopbackExcludesSelf: false, warnings: [] });
    expect(sm.state.in.speak).toBe(false);
    expect(sm.state.warnings.join()).toMatch(/自动关闭/);
    expect(sent.some((m) => m.type === 'flush' && m.dir === 'in')).toBe(true);
    await sm.stop();
  });
});


describe('SessionManager start/stop edge cases', () => {
  const base = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-edge-'));
    const settings = applyPreset(defaultSettings(), 'demo');
    settings.devices.meetingSource = 'device';
    const sent: ToAudio[] = [];
    return { dir, settings, sent };
  };

  it('a missing key fails the start without leaving the meeting active', async () => {
    const { dir, settings, sent } = base();
    let fail = true;
    const providers = (): ProviderSet => ({
      asr: (d) => new MockAsr(d === 'out' ? 'self' : 'remote'),
      mt: () => {
        if (fail) throw new Error('请先在“服务设置”里填写大模型的 Key');
        return new MockTranslator();
      },
      tts: () => new MockTts(),
      llm: () => null,
      describe: () => ({}),
    });
    const sm = new SessionManager({ settings: () => settings, glossary: () => [], providers, recordsDir: () => dir, toAudio: (m) => sent.push(m), broadcast: () => {}, log: createLogger('t') });
    await expect(sm.start({})).rejects.toThrow(/Key/);
    expect(sm.active).toBe(false);
    expect(sent).toHaveLength(0);
    fail = false;
    await sm.start({});
    expect(sm.active).toBe(true);
    expect(sent.some((m) => m.type === 'start')).toBe(true);
    await sm.stop();
  });

  it('stop while recognition is still connecting does not start the audio engine afterwards', async () => {
    const { dir, settings, sent } = base();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowAsr = { id: 'slow', start: async (o: any) => { await gate; return new MockAsr().start(o); } };
    const providers = (): ProviderSet => ({ asr: () => slowAsr, mt: () => new MockTranslator(), tts: () => new MockTts(), llm: () => null, describe: () => ({}) });
    const sm = new SessionManager({ settings: () => settings, glossary: () => [], providers, recordsDir: () => dir, toAudio: (m) => sent.push(m), broadcast: () => {}, log: createLogger('t') });
    const starting = sm.start({});
    await new Promise((r) => setTimeout(r, 10));
    const stopping = sm.stop();
    release();
    await Promise.all([starting, stopping]);
    expect(sent.map((m) => m.type)).not.toContain('start');
    expect(sm.active).toBe(false);
  });

  it('a recorder restarted mid-meeting continues in a new file', async () => {
    const { dir, settings, sent } = base();
    const providers = (): ProviderSet => ({ asr: () => new MockAsr(), mt: () => new MockTranslator(), tts: () => new MockTts(), llm: () => null, describe: () => ({}) });
    const sm = new SessionManager({ settings: () => settings, glossary: () => [], providers, recordsDir: () => dir, toAudio: (m) => sent.push(m), broadcast: () => {}, log: createLogger('t') });
    await sm.start({});
    const chunk = (n: number) => new Uint8Array(n).fill(7).buffer;
    sm.handleAudio({ type: 'recChunk', kind: 'mix', mime: 'audio/webm', data: chunk(1000) });
    sm.handleAudio({ type: 'recStopped', kind: 'mix' });
    sm.handleAudio({ type: 'recChunk', kind: 'mix', mime: 'audio/webm', data: chunk(5000) });
    const folder = sm.currentFolder;
    const meta = await sm.stop();
    expect(readFileSync(join(folder, 'audio/mix.webm')).length).toBe(1000);
    expect(readFileSync(join(folder, 'audio/mix-2.webm')).length).toBe(5000);
    expect(meta!.files.mix2).toBe('audio/mix-2.webm');
  });
});
