/**
 * How PowerShell is started for the system voices: the script arrives on stdin. No
 * "-ExecutionPolicy Bypass": commands on stdin are not scripts, the policy does not apply to them,
 * and the flag only makes security software suspicious on company computers.
 */
export const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];

/**
 * A value as a single-quoted PowerShell literal of JSON in plain ASCII — characters beyond ASCII
 * (a Chinese user name in a path) as \uXXXX, which ConvertFrom-Json decodes — so it survives a
 * stdin line read in the OEM code page without Base64 (another pattern security software flags).
 */
export function psJson(value: unknown): string {
  const json = JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `'${json.replace(/'/g, "''")}'`;
}
