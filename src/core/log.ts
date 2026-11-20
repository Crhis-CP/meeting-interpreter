export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  child(scope: string): Logger;
}

export type LogSink = (level: LogLevel, scope: string, line: string) => void;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_\-]{6,}/g, // OpenAI / DashScope / DeepSeek style keys
  /\b(Bearer|bearer)\s+[A-Za-z0-9._\-~+/=]{6,}/g,
  /((?:api[_-]?key|apikey|key|token|subscription-key|Ocp-Apim-Subscription-Key|access_token|auth)["']?\s*[=:]\s*["']?)[A-Za-z0-9._\-~+/=]{6,}/gi,
  /\b[0-9a-f]{32}\b/gi, // Azure speech keys (32 hex)
];

/** Masks anything that looks like a credential so logs and error messages are safe to show. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix?: string) => {
      if (typeof prefix === 'string' && m.startsWith(prefix) && prefix.length < m.length) return `${prefix}***`;
      if (/^(Bearer|bearer)\s/.test(m)) return m.split(/\s+/)[0] + ' ***';
      return '***';
    });
  }
  return out;
}

function format(msg: string, args: unknown[]): string {
  const parts = [msg];
  for (const a of args) {
    if (a instanceof Error) parts.push(`${a.name}: ${a.message}`);
    else if (typeof a === 'string') parts.push(a);
    else {
      try {
        parts.push(JSON.stringify(a));
      } catch {
        parts.push(String(a));
      }
    }
  }
  return redact(parts.join(' '));
}

let globalSink: LogSink = (level, scope, line) => {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${scope}] ${line}`);
};
let minLevel: LogLevel = 'info';
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function setLogSink(sink: LogSink): void {
  globalSink = sink;
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, msg: string, args: unknown[]) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    globalSink(level, scope, format(msg, args));
  };
  return {
    debug: (m, ...a) => write('debug', m, a),
    info: (m, ...a) => write('info', m, a),
    warn: (m, ...a) => write('warn', m, a),
    error: (m, ...a) => write('error', m, a),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}
