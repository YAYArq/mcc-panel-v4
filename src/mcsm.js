'use strict';

const http = require('http');
const https = require('https');
const logger = require('./logger');

/**
 * MCSManager(MCSM) Panel API 客户端（零第三方依赖）。
 * 参考 mcc-panel 的 mcsm-client 实现：
 *   - 自动附加 apikey 到 query 与请求头；
 *   - 解析 MCSM 统一响应协议 { status, data, time }。
 *
 * 用于挂机场景：监控服务器状态、读取服务器日志做掉线检测、向服务器实例发命令/控制启停。
 */
class McsmClient {
  /**
   * @param {object} opts { url, apikey, timeoutMs }
   */
  constructor(opts = {}) {
    this.baseUrl = String(opts.url || '').trim().replace(/\/+$/, '');
    this.apikey = String(opts.apikey || '').trim();
    this.timeoutMs = opts.timeoutMs || 15000;
    this.log = logger.scope('mcsm');
    if (!this.baseUrl) throw new Error('MCSM url 未配置');
  }

  /**
   * 发送请求。
   * @param {string} method
   * @param {string} path 相对路径
   * @param {object} [query]
   * @param {object} [body]
   * @returns {Promise<{httpStatus:number,status:number,data:any,error:string|null,raw:any}>}
   */
  request(method, path, query = {}, body = null) {
    const parsed = new URL(this.baseUrl + '/' + String(path).replace(/^\/+/, ''));
    parsed.searchParams.set('apikey', this.apikey);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null) continue;
      parsed.searchParams.set(k, String(v));
    }

    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      method: method.toUpperCase(),
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' }
    };
    if (payload) options.headers['Content-Length'] = payload.length;

    return new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(this._normalize(res.statusCode, Buffer.concat(chunks).toString('utf8'))));
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('MCSM 请求超时')));
      req.on('error', (e) => reject(new Error(`无法连接 MCSM (${this.baseUrl}): ${e.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  _normalize(httpStatus, raw) {
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
    if (parsed && typeof parsed === 'object' && 'status' in parsed) {
      const isOk = parsed.status === 200;
      return {
        httpStatus, status: parsed.status,
        data: parsed.data !== undefined ? parsed.data : null,
        error: isOk ? null : (typeof parsed.data === 'string' ? parsed.data : `MCSM 返回状态 ${parsed.status}`),
        raw: parsed
      };
    }
    return {
      httpStatus,
      status: httpStatus >= 200 && httpStatus < 300 ? 200 : httpStatus,
      data: parsed !== null ? parsed : (raw || null),
      error: httpStatus >= 200 && httpStatus < 300 ? null : (raw || `HTTP ${httpStatus}`),
      raw
    };
  }

  // ================= 基础查询 =================

  /** 获取 daemon 节点列表 */
  async listDaemons() {
    const r = await this.request('GET', '/api/service/remote_services_list');
    return r.status === 200 && Array.isArray(r.data) ? r.data : [];
  }

  /** 获取某节点的实例列表 */
  async listInstances(daemonId) {
    const r = await this.request('GET', '/api/service/remote_service_instances', {
      daemonId, page: 1, page_size: 100
    });
    if (r.status !== 200) return [];
    const data = (r.data && r.data.data) || [];
    return Array.isArray(data) ? data : [];
  }

  /** 获取实例详细信息 */
  async getInstance(daemonId, uuid) {
    const r = await this.request('GET', '/api/instance', { daemonId, uuid });
    return r.status === 200 && r.data && typeof r.data === 'object' ? r.data : null;
  }

  /** 实例状态：running / stop / ... */
  async getInstanceStatus(daemonId, uuid) {
    const inst = await this.getInstance(daemonId, uuid);
    return inst ? String(inst.status == null ? '' : inst.status) : '';
  }

  // ================= 控制与命令 =================

  /** 向服务器实例发送一条命令（写入服务器控制台） */
  async sendCommand(daemonId, uuid, command) {
    const r = await this.request('POST', '/api/protected_instance/command', { daemonId, uuid, command });
    return r.status === 200;
  }

  /** 实例控制：start / stop / restart / kill */
  async instanceAction(daemonId, uuid, action) {
    const r = await this.request('POST', `/api/protected_instance/${action}`, { daemonId, uuid });
    return r.status === 200;
  }

  /** 读取实例日志（size 字节） */
  async readLog(daemonId, uuid, size = 65536) {
    const r = await this.request('GET', '/api/protected_instance/outputlog', { daemonId, uuid, size });
    let text = r.data;
    if (text && typeof text === 'object' && typeof text.data === 'string') text = text.data;
    return typeof text === 'string' ? String(text).replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '') : '';
  }
}

module.exports = { McsmClient };
