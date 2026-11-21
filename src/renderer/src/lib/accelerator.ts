/** Electron accelerator for a key press, or '' (only modifiers so far), or null (not allowed alone). */
export function acceleratorOf(e: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return '';
  const code = e.code;
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^F([1-9]|1[0-9]|2[0-4])$/.test(code) ? code : code === 'Space' ? 'Space' : null;
  if (!key) return null;
  const mods = [e.metaKey || e.ctrlKey ? 'CommandOrControl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean);
  // A shortcut holds its key in every app during the meeting: a plain letter or digit is never allowed.
  if (!mods.length && !/^F\d+$/.test(key)) return null;
  return [...mods, key].join('+');
}
