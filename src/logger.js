'use strict';

// 极简彩色日志，IS_PROD/CONFIG 控制级别，尽量低开销。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const NAMES = { debug: 'DEBG', info: 'INFO', warn: 'WARN', error: 'EROR' };

// ANSI 颜色（检测到支持才启用）
const COLORS = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m'
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

class Logger {
  constructor() {
    this.level = 'info'; // debug|info|warn|error
    this.prefix = '';
  }

  /** 每个 bot 建立自己的 logger，带上 [server] 前缀，方便区分多服务器。 */
  scope(prefix) {
    const l = new Logger();
    l.level = this.level;
    l.prefix = prefix || '';
    return l;
  }

  setLevel(name) {
    if (LEVELS[name] !== undefined) this.level = name;
  }

  _write(level, args) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const prefix = this.prefix ? `[${this.prefix}] ` : '';
    const head = `${ts} [${NAMES[level]}] ${prefix}`;
    // 容错：展开参数，避免 Error 对象 toString 丢失 stack
    const parts = args.map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    });
    const line = parts.join(' ');
    let out = head + line;
    if (useColor) out = COLORS[level] + head + line + COLORS.reset;
    const target = level === 'error' ? console.error : console.log;
    target(out);
  }

  debug(...a) { this._write('debug', a); }
  info(...a) { this._write('info', a); }
  warn(...a) { this._write('warn', a); }
  error(...a) { this._write('error', a); }
}

module.exports = new Logger();
