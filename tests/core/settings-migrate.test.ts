import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUTS, parseSettings } from '../../src/core/config/schema';

describe('settings saved by older versions', () => {
  it('replaces the old default shortcuts that collided with other apps', () => {
    const s = parseSettings({ shortcuts: { toggleOut: 'CommandOrControl+Shift+M', pushToTalk: 'CommandOrControl+Shift+Space', toggleOverlay: 'CommandOrControl+Shift+S' } });
    expect(s.shortcuts).toEqual(DEFAULT_SHORTCUTS);
  });

  it('keeps shortcuts the user chose', () => {
    const s = parseSettings({ shortcuts: { toggleOut: 'F8', pushToTalk: 'CommandOrControl+Shift+Space', toggleOverlay: 'Alt+F9' } });
    expect(s.shortcuts).toEqual({ toggleOut: 'F8', pushToTalk: DEFAULT_SHORTCUTS.pushToTalk, toggleOverlay: 'Alt+F9' });
  });

  it('drops the removed meeting-app setting without losing the rest', () => {
    const s = parseSettings({ platform: 'teams', onboarded: true });
    expect(s.onboarded).toBe(true);
    expect('platform' in s).toBe(false);
  });

  it('moves Spanish / English recognition from Whisper to Parakeet (more accurate and faster); keeps the rest', () => {
    for (const old of ['whisper-small', 'whisper-base']) {
      const s = parseSettings({ local: { esModel: old, aiModel: 'hy-mt2-7b' } });
      expect(s.local).toEqual({ esModel: 'parakeet-v3', aiModel: 'hy-mt2-7b' });
    }
    expect(parseSettings({}).local.esModel).toBe('parakeet-v3');
  });
});
