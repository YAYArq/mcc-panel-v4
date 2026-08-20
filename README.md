# 挂机假人（mineflayer + MCSManager）

基于 **mineflayer (mf)** + **MCSManager (mcsm)** 的低占用 Minecraft 挂机假人。

功能：

- **自动接取 tpa / tpahere**：监听聊天，按"服务器自定义正则"识别不同插件的传送请求提示文案，自动发送 `/tpaccept`（或按需拒绝）。
- **识别不同服务器的正则**：每个服务器 `tpa.patterns` 可独立配置，内置常见插件（EssentialsX / SimpleTpa / CMI / 汉化插件）规则，开箱即用。
- **定时使用指令**：支持 interval（毫秒间隔）与 cron（5 字段标准表达式）两种调度，如定时 `/afk`、`/home`、`/tpaccept` 等。
- **定时做动作**：挥臂 / 跳跃 / 走动 / 潜行 / 转身，可自定义间隔，用于防 AFK 与挂机心跳。
- **MCSM 面板守护**：通过 MCSManager API 监控服务器实例，崩溃/停止时自动重启，保证挂机不中断。
- **占用要低**：单进程统一一个调度定时器承载全部定时任务；MCSM 守护轮询间隔可调；轻量正则匹配，不引入重型插件。

## 快速开始

```bash
npm install
cp config.json config.local.json   # 或直接编辑 config.json
npm start                            # 或 node src/index.js [config.json 路径]
```

启动后默认从 `config.json` 读取（可用环境变量 `CONFIG_PATH` 或命令行参数指定路径），并可选叠加 `config.local.json`（不提交到 git，适合放真实凭据）。

> 需要任一种正版/离线账号（`auth: "offline" | "microsoft" | "mojang"`）。请使用服务器白名单内、允许挂机的账号。

## 配置文件说明

### servers[]

| 字段 | 说明 |
| --- | --- |
| `name` | 实例唯一名（也是日志前缀与单独控制的索引；**每个账号必须唯一**） |
| `host` / `port` / `username` / `auth` / `version` | mineflayer 连接参数；`auth` 支持 `offline` / `microsoft` 等 |
| `acceptTpa` | 是否自动接取 tpa / tpahere（默认 `true`） |
| `tpa` | 该服务器的传送请求正则配置（见下） |
| `scheduledCommands` | 定时指令列表 |
| `scheduledActions` | 定时动作列表 |
| `botOptions` | 额外透传给 mineflayer（如 `{ "hideErrors": true }`） |

#### 多账号 / 每个账号一个实例

**一个账号 = servers 数组里的一个条目**。想在同一台服务器上挂很多账号，就写多个 `host` 相同、`username` 不同的对象；每个对象都是一个**独立**的 mineflayer 实例，互不影响，也拥有各自独立的 tpa 正则 / 定时指令 / 定时动作配置。

```jsonc
"servers": [
  { "name": "生存服-阿飞", "host": "play.example.com", "username": "AfkBot1", "auth": "offline" },
  { "name": "生存服-小明", "host": "play.example.com", "username": "AfkBot2", "auth": "offline" }, // 同服第二账号
  { "name": "空岛服",     "host": "skyblock.example.com", "username": "AfkBot3", "auth": "microsoft" }
]
```

> 数组里允许放以 `//` 开头的字符串作为示意注释行，配置加载时会自动忽略。

每个实例的登记名（`name`）就是"单独控制"的句柄。启动时全部实例会自动运行；在代码/脚本中可通过 `BotsManager` 对**单个账号**执行独立控制：

```js
const mgr = new BotsManager({ config }).load();   // load 只建实例不连接
mgr.start('生存服-阿飞');      // 单独拉起某账号（stop 后可再次拉起）
mgr.stop('生存服-小明');       // 单独停止某账号（不影响其它实例）
mgr.restart('空岛服');         // 单独重启某账号
mgr.sendCommand('生存服-阿飞', '/home');  // 单独向某账号发指令
mgr.getSnapshots();            // 查看全部实例状态
```

### tpa（按服务器识别正则）

```jsonc
"tpa": {
  "acceptCommand": "/tpaccept",   // 该插件接受请求的命令
  "denyCommand":   "/tpdeny",    // 拒绝请求的命令
  "patternsOverride": false,      // true = 只用下面 patterns，不带内置规则
  "patterns": [
    { "regex": "请求传送(到你的位置|到你的身边)", "type": "tpa" },
    { "regex": "has requested to teleport to you", "type": "tpa" },
    // type 说明：tpa=请求传送过去；tpahere=请求传送过来；ignore=命中但忽略
    // accept=false 时命中自动发 denyCommand（拒绝）
    { "regex": "某些拒绝词", "type": "tpa", "accept": false }
  ]
}
```

> 内置规则已覆盖常见插件的中英文提示。若你的服务器插件文案特殊，在这里追加或覆盖即可。

### scheduledCommands 与 scheduledActions

```jsonc
"scheduledCommands": [
  { "command": "/afk", "every": 600000 },          // 每 10 分钟执行一次
  { "command": "/home spawn", "cron": "0 4 * * *" } // 每天 04:00（5 字段 cron）
],

"scheduledActions": [
  { "type": "swing", "every": 120000 },            // 挥臂
  { "type": "walk",  "every": 300000, "holdMs": 600 },
  { "type": "jump",  "every": 600000 }
]
```

动作类型：`swing`(挥臂)、`jump`(跳)、`walk`(走动，可 `direction:"back"`)、`sneak`(潜行)、`turn`(转身)。

cron 为标准 5 字段：`分 时 日 月 周`（周 0/7 均为周日），五字段 AND 语义。

### mcsm（MCSManager 守护，可选）

```jsonc
"mcsm": {
  "enabled": false,
  "url": "http://127.0.0.1:23333",
  "apikey": "在 MCSM 面板生成的 API Key",
  "pollMs": 30000,
  "cooldownMs": 60000,
  "server": { "daemonId": "default-node", "uuid": "服务器实例 UUID" },
  "startIfStopped": true,
  "restartOnCrashed": true,
  "crashKeywords": ["Encountered an unexpected exception", "crashed"]
}
```

- 挂机假人自身的断线自动重连由 mineflayer 层负责；
- 本守护通过 MCSM 保证**服务器实例**在线：停止时 `start`，日志命中崩溃关键词时 `restart`。
- 调大 `pollMs` 可进一步降低对 MCSM 的请求压力（低占用）。

## 低占用说明

- 全局 `Scheduler` 用**单个** `setInterval` 节拍驱动全部定时指令/动作，避免逐任务建定时器。
- MCSM 守护独立定时器，默认 30s 轮询，可按需调大。
- `logLevel: "debug"` 时才打印精细日志，默认 `info` 只输出关键事件。
- 消息处理仅做一条 ChatMessage 的轻量正则匹配，不启用寻路等重型插件。

## 项目结构

```
├── src/
│   ├── index.js          # 入口
│   ├── logger.js         # 彩色日志（按服务器 scope 前缀）
│   ├── config.js         # 配置加载 / 校验（config.json + config.local.json）
│   ├── regexes.js        # 按服务器的 tpa/tpahere 正则库（内置 + 可覆盖）
│   ├── scheduler.js      # 轻量统一调度器（interval + cron）
│   ├── AfkBot.js         # 单挂机假人：连接 / 自动接取 tpa / 定时指令动作 / 重连
│   ├── BotsManager.js    # 多假人管理器
│   ├── mcsm.js           # MCSManager API 客户端（零依赖）
│   └── mcsmGuard.js      # MCSM 服务器保活守护
├── config.json           # 配置示例（含全部功能字段）
└── package.json
```

## 参考

- [YAYArq/minecraft-storage-bot](https://github.com/YAYArq/minecraft-storage-bot) — mineflayer 多 bot 实例架构、tpa 正则、断线重连
- [YAYArq/mcc-panel-v3](https://github.com/YAYArq/mcc-panel-v3) — MCSManager API 客户端、cron 定时、掉线检测/防 AFK

## License

MIT
