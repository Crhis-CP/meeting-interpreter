import { describe, expect, it } from 'vitest';
import { acceleratorOf } from '../src/renderer/src/lib/accelerator';

const press = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}, key = code) =>
  acceleratorOf({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('recording a shortcut', () => {
  it('turns a key press with modifiers into an Electron accelerator', () => {
    expect(press('KeyM', { metaKey: true, altKey: true, shiftKey: true })).toBe('CommandOrControl+Alt+Shift+M');
    expect(press('Space', { ctrlKey: true, shiftKey: true })).toBe('CommandOrControl+Shift+Space');
    expect(press('F9')).toBe('F9');
  });
  it('never accepts a plain letter or digit (it would be taken from every app)', () => {
    expect(press('KeyC')).toBeNull();
    expect(press('Digit1')).toBeNull();
  });
  it('waits while only modifiers are held', () => {
    expect(press('ShiftLeft', { shiftKey: true }, 'Shift')).toBe('');
  });
});
