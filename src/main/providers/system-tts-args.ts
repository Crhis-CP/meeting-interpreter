/** How PowerShell is started for the system voices: the script arrives on stdin. */
export const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'];
