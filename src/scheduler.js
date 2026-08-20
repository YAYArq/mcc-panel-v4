'use strict';

/**
 * 轻量统一调度器。
 *
 * 为降低占用，整个进程只使用一个 setInterval 节拍（timestamp checker），
 * 所有服务器、所有定时指令/动作共用这一个定时器，而不是每任务各建一个。
 *
 * 支持两种触发方式（可同时配置）：
 *   - every : 最小执行间隔（毫秒）。到点即执行，执行后重置计时。
 *   - cron  : 标准 5 字段 cron（分 时 日 月 周），到分钟边界执行。
 *
 * 注意：cron 任务在同一分钟内只执行一次（lastCronKey 去重）。
 */

// 标准 5 字段 cron 解析/匹配（精简实现，语义：五字段 AND，周 0/7 均为周日）
const NO_FIELD = { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true };

function parseCronField(field, min, max) {
  const values = new Set();
  for (const part of String(field).trim().split(',')) {
    const p = part.trim();
    if (!p) return null;
    let m;
    if (p === '*') { for (let v = min; v <= max; v++) values.add(v); continue; }
    if ((m = /^\*\/(\d+)$/.exec(p))) {
      const s = +m[1]; if (s <= 0) return null;
      for (let v = min; v <= max; v += s) values.add(v); continue;
    }
    if ((m = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(p))) {
      const a = +m[1], b = +m[2], s = m[3] ? +m[3] : 1;
      if (a < min || b > max || a > b || s <= 0) return null;
      for (let v = a; v <= b; v += s) values.add(v); continue;
    }
    if (/^\d+$/.test(p)) {
      let v = +p; if (v < min || v > max) return null;
      if (max === 7 && v === 7) v = 0;
      values.add(v); continue;
    }
    return null;
  }
  if (max === 7 && values.has(7)) { values.delete(7); values.add(0); }
  return values;
}

function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const day = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dow = parseCronField(parts[4], 0, 7);
  if (minute === null || hour === null || day === null || month === null || dow === null) return null;
  return { minute, hour, day, month, dow };
}

function cronMatches(cron, d) {
  return cron.minute.has(d.getMinutes())
    && cron.hour.has(d.getHours())
    && cron.day.has(d.getDate())
    && cron.month.has(d.getMonth() + 1)
    && cron.dow.has(d.getDay());
}

class Scheduler {
  /**
   * @param {object} [options]
   * @param {number} [options.tickMs=1000] 统一节拍
   */
  constructor(options = {}) {
    this.tickMs = options.tickMs || 1000;
    this.tasks = [];
    this._timer = null;
    this._lastTick = 0;
  }

  /**
   * 添加一个任务。
   * @param {object} task { name, every, cron, onFire(ts) }
   */
  add(task) {
    let cron = null;
    if (task.cron) {
      cron = parseCron(task.cron);
      if (!cron) throw new Error(`cron 表达式非法: ${task.cron}`);
    }
    this.tasks.push({
      name: task.name || `task${this.tasks.length + 1}`,
      every: task.every || 0,
      cron,
      cronKey: null,
      lastFire: 0,
      onFire: task.onFire
    });
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this.tickMs);
    if (typeof this._timer.unref === 'function') this._timer.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _tick() {
    const now = Date.now();
    const d = new Date();
    for (const t of this.tasks) {
      try {
        if (t.every && now - t.lastFire >= t.every) {
          t.lastFire = now;
          t.onFire(now);
          continue;
        }
        if (t.cron) {
          const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
          if (key !== t.cronKey && cronMatches(t.cron, d)) {
            t.cronKey = key;
            t.onFire(now);
          }
        }
      } catch (e) {
        // 单任务异常不影响其它任务
        const logger = require('./logger');
        logger.error(`调度任务[${t.name}]执行出错:`, e && e.message ? e.message : e);
      }
    }
  }
}

module.exports = { Scheduler, parseCron, cronMatches };
