'use strict';

/**
 * 基于 mineflayer + MCSManager 的低占用 Minecraft 挂机假人。
 *
 * 功能：
 *   - 自动接取 tpa / tpahere（按服务器自定义正则识别不同插件的提示文案）；
 *   - 定时指令（interval / cron）；
 *   - 定时动作（挥臂 / 跳跃 / 走动 / 潜行 / 转身，防 AFK）；
 *   - 断线自动重连；
 *   - 可选 MCSM(MCSManager) 守护：服务器崩溃/停止时自动重启，保证挂机不中断。
 *
 * 低占用策略：
 *   - 全局统一 scheduler 定时器（多服务器、多定时任务共用一个 setInterval）；
 *   - MCSM 守护使用独立但可调大的轮询间隔；
 *   - 命中正则前仅做一条消息的轻量匹配，不引入额外重型插件。
 *
 * 用法：
 *   node src/index.js [config.json 路径]
 *   环境变量 CONFIG_PATH 也可指定配置路径（默认读 config.json，可叠加 config.local.json）
 */

const path = require('path');

// ⚠️ mineflayer-x 补丁必须先加载（注册 MC 26.x 协议/数据/版本门控，见 src/vendor/mineflayer-x）
// 必须早于任何 createBot / mineflayer 使用，否则 26.1 版本连接会失败。
require('./vendor/mineflayer-x');

const logger = require('./logger');
const { loadConfig } = require('./config');
const { BotsManager } = require('./BotsManager');
const { McsmGuard } = require('./mcsmGuard');

async function main() {
  const cfgPath = process.argv[2] || process.env.CONFIG_PATH;
  const config = loadConfig(cfgPath ? { path: path.resolve(process.cwd(), cfgPath) } : {});

  logger.setLevel(config.logLevel || 'info');
  logger.info('========== 挂机假人启动 ==========');

  // 1. 多挂机假人
  const manager = new BotsManager({ config });
  manager.load();
  manager.start();

  // 2. MCSM 守护（服务器保活）
  const guard = new McsmGuard({ config });
  guard.start();

  // 3. 独立 Web 面板 + 健康检查（统一端口 10270，可用 PORT / PANEL_HOST / PANEL_TOKEN 覆盖）
  const panel = require('./panel').startPanel({ manager, port: 10270 });

  // 4. 优雅退出
  const shutdown = async (signal) => {
    logger.info(`\n收到 ${signal}，正在停止...`);
    guard.stop();
    manager.stop();
    try { panel.close(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // 5. 状态定期打印（每 60s，便于观察，也可在 logger 级别静默）
  setInterval(() => {
    if (logger.level === 'debug') {
      logger.debug('状态快照:');
      for (const s of manager.getSnapshots()) {
        logger.debug(`  ${s.name}: ${s.online ? '在线' : '离线'} (${s.online ? `${s.uptime}s` : `重连 ${s.reconnectAttempts}次`})`);
      }
    }
  }, 60000).unref?.();

  // 6. 一次性打印启动摘要
  logger.info(`已加载 ${manager.bots.size} 个挂机假人`);
  for (const s of manager.getSnapshots()) {
    logger.info(`  - ${s.name} → ${s.host}:${s.port} (${s.username})，tpa规则${s.tpaRules}条，定时指令${s.scheduledCommands}条，定时动作${s.scheduledActions}种`);
  }
}

main().catch((err) => {
  logger.error('启动失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
