# Action Audit

一个 OpenClaw 插件，在每次回复末尾自动追加操作清单，让用户看到 AI 实际执行了什么（工具调用、命令、文件操作等）。

## 解决什么问题

OpenClaw在对话中会自主执行命令、修改文件，但回复里可能只说"已完成"。用户无法确认：
- 它是否真的执行了？（AI 有时会虚假声称）
- 具体执行了什么命令？改了哪个文件？
- 有没有做超出预期的操作？

Action Audit 在代码层捕获所有工具调用，强制追加到回复末尾。AI 无法伪造这些记录。

## 效果预览

```
OpenClaw的回复内容...

(via ⚙️ glm5)
——————————
🔎 本次操作：
⚠️ 调用工具 exec：systemctl --user restart openclaw-gateway（成功）
⚠️ 写入文件：~/.openclaw/openclaw.json（成功）
🌐 抓取网页：https://example.com/api（成功）
📄 读取文件：~/.openclaw/openclaw.json（成功）
📄 搜索内容：*.json in ~/.openclaw/（成功）
```

纯对话（无工具调用）时不追加任何内容。

## 工作原理

### 使用的 Hook

| Hook | 优先级 | 执行模式 | 作用 |
|------|--------|----------|------|
| `after_tool_call` | 0 | void 并行 | 每次工具执行完成后触发，捕获工具名、参数、结果，存入内存缓存 |
| `message_sending` | -1000 | 修改串行 | 回复发送前触发，从缓存取操作列表，格式化后追加到回复末尾 |

### 数据流（当前稳定方案）

```
AI 调用工具（bash/read/write/...）
    ↓
after_tool_call 触发
    ↓
捕获 toolName + params + error → 分级 → 写入 session 缓存
（仅当 sessionKey 不可用时写入 route fallback）
    ↓
AI 生成回复
    ↓
dispatchReplyFromConfig 包装的发送路径触发 message_sending
    ↓
从缓存取操作列表 → 排序（高风险优先）→ 格式化 → 追加到回复末尾 → 清空缓存
```

### 会话隔离策略（重要）

- 主键：`sessionKey`（来自核心层 `ctx.SessionKey`）
- 正常路径：只读写 session 缓存，不走全局 fallback
- fallback：仅用于确实拿不到 `sessionKey` 的兼容场景
- 清理：成功追加后立刻清空对应 session 缓存，并清理对应 route fallback

这套策略用于避免跨渠道串线和重复追加。

### 风险分级

| 级别 | 图标 | 含义 | 默认工具 |
|------|------|------|----------|
| 高风险 | ⚠️ | 写入、删除、执行命令 | bash, exec, write, edit, delete, rm |
| 中风险 | 🌐 | 网络访问、调用子agent | web_fetch, sessions_spawn |
| 低风险 | 📄 | 读取、搜索 | read, grep, search, glob, web_search |

未识别的工具通过启发式判断：参数中含 write/delete/remove 的归为高风险，其余归为低风险。

### 安全措施

- **敏感信息脱敏**：命令参数中含 key/token/password/secret 等关键词的值自动替换为 `****`
- **错误隔离**：所有 Hook handler 外层 try-catch，插件报错不阻断消息发送
- **零 token 消耗**：纯代码层处理，不调用大模型（仅依赖 `message_sending`）

## 配置

首次启动自动生成配置文件：`~/.openclaw/plugins/action-audit/config.json`

```json
{
  "maxDisplay": 10,
  "separator": "\n\n——————————\n",
  "icons": {
    "high": "⚠️",
    "medium": "🌐",
    "low": "📄"
  },
  "rules": {
    "high": {
      "bash": "执行命令",
      "exec": "执行命令",
      "write": "写入文件",
      "edit": "编辑文件",
      "delete": "删除文件"
    },
    "medium": {
      "web_fetch": "抓取网页",
      "sessions_spawn": "调用子agent/skill"
    },
    "low": {
      "read": "读取文件",
      "grep": "搜索内容",
      "glob": "匹配文件",
      "web_search": "网页搜索"
    }
  },
  "sensitivePatterns": ["key", "token", "password", "secret", "credential", "apikey", "api_key"]
}
```

### 配置说明

| 字段 | 说明 |
|------|------|
| `maxDisplay` | 操作清单最多显示条数，超出部分显示"…及其他 N 项操作" |
| `separator` | 正文与操作清单之间的分隔线 |
| `icons` | 各风险级别的图标 |
| `rules.high/medium/low` | 工具名 → 显示标签的映射，决定风险分级 |
| `sensitivePatterns` | 触发脱敏的关键词列表 |

### 动态增删工具监控

直接编辑 config.json，重启网关生效：

```bash
# 例：把 web_search 从低风险改成中风险
# 1. 编辑 ~/.openclaw/plugins/action-audit/config.json
# 2. 从 rules.low 中删除 "web_search" 行
# 3. 在 rules.medium 中添加 "web_search": "网页搜索"
# 4. 重启网关
systemctl --user restart openclaw-gateway
```

## 安装

```bash
# 1. 复制插件到 extensions 目录
mkdir -p ~/.openclaw/extensions/action-audit
cp plugin/* ~/.openclaw/extensions/action-audit/

# 2. 在 openclaw.json 的 plugins 中添加：
#    - plugins.allow 数组中加入 "action-audit"
#    - plugins.entries 中加入 "action-audit": { "enabled": true }

# 3. 重启网关
systemctl --user restart openclaw-gateway
```

## Core Patch 管理（统一补丁目录）

本项目将 OpenClaw core 的兼容补丁与说明统一放在 `patches/` 目录，和插件一起维护：

- `patches/source-rules/<version>.patch`：core 源码补丁（按版本严格维护）
- `patches/reapply-openclaw-message-sending-bridge.sh`：升级后重放补丁脚本
- `patches/reapply-openclaw-message-sending-bridge-dist.sh`：dist-only 安装版热补丁脚本
- `patches/dist-rules/<version>.json`：dist 版按版本维护的规则文件（含 checksum）
- `patches/README.md`：补丁用途、执行方法、验证步骤与版本策略

源码版执行方式：

```bash
./patches/reapply-openclaw-message-sending-bridge.sh /path/to/openclaw-root
./patches/reapply-openclaw-message-sending-bridge.sh /path/to/openclaw-root 2026.3.22
```

dist-only 安装版执行方式：

```bash
./patches/reapply-openclaw-message-sending-bridge-dist.sh /path/to/openclaw-root
```

说明：
- 补丁修改的是 OpenClaw core 路径，不是插件目录本身。
- 脚本会自动备份被修改文件到 `.action-audit-backups/`，再执行补丁。
- 每次 OpenClaw core 升级后，按需重放补丁并重启网关。
- 源码补丁采用严格版本模式：缺少对应 `source-rules/<version>.patch` 时会直接报错退出（无 generic 兜底）。

## 已知问题

### 工具名差异

OpenClaw 实际的工具名可能与预期不同（如 `exec` 而非 `bash`）。可通过配置文件的 `rules` 添加新的工具名映射。

### 未打补丁时的限制

在部分 OpenClaw 版本/发送路径中，用户对话回复不会稳定经过可用的 `message_sending` 修改链路，或缺少会话上下文。此时可能出现：
- 操作清单不追加
- 只能走全局兜底，无法按会话严格隔离

建议应用本项目提供的 core patch（源码版或 dist 版）。

## 修复方案（已采用）

### 方案一：改 OpenClaw 核心（推荐，当前采用）

**改动点**：`src/auto-reply/reply/dispatch-from-config.ts` 中的 `dispatchReplyFromConfig()`

**原理**：`dispatchReplyFromConfig` 位于主回复发送路径，作用域里已有核心信息：

- `ctx.SessionKey` — 会话标识
- `hookRunner` — Hook 执行器（通过 `getGlobalHookRunner()` 获取）
- `dispatcher` — 有 `sendFinalReply`/`sendBlockReply`/`sendToolResult` 方法

**改动方式**：
- 在 `dispatchReplyFromConfig` 注入 `runMessageSendingForPayload` 与 `sendWithMessageSending`
- 创建 `wrappedDispatcher`，包装 `sendToolResult`/`sendBlockReply`/`sendFinalReply`
- 两处 ACP 调用统一改为 `dispatcher: wrappedDispatcher`

```
dispatchReplyFromConfig({ ctx, dispatcher })
  │
  ├─→ sessionKey = ctx.SessionKey  ✅ 已有
  ├─→ hookRunner = getGlobalHookRunner()  ✅ 已有
  │
  ├─→ 包装 dispatcher.sendFinalReply：
  │     原始 payload
  │       → hookRunner.runMessageSending({ content }, { sessionKey, ... })
  │       → 用返回值替换 content（cancel 则跳过发送）
  │       → 调原始 sendFinalReply(修改后的 payload)
  │
  ├─→ AI 推理（after_tool_call 存 buffer[sessionKey]）
  │
  └─→ 包装后的 sendFinalReply 调用时：
        → message_sending 拿到 sessionKey
        → 取 buffer[sessionKey]，追加操作清单
        → deliver 发送修改后的内容
```

**改动量**：单点改动，避免逐个 channel 插件改造。

**注意事项**：
- 包装层必须 try-catch，Hook 失败时降级为直发，不阻断消息发送
- 建议同时包装 `sendFinalReply`/`sendBlockReply`/`sendToolResult`
- 非主对话发送（系统告警/cron）走标准出站管线，已有 `message_sending` 支持，不受影响

**信息流向**：

```
═══ 改动后（所有 channel 统一，不改 channel 插件）═══

channel 插件收到消息
  │
  ├─→ routing → sessionKey
  │
  ├─→ [飞书/微信] createReplyDispatcherWithTyping({ deliver })  ──┐
  │   [Telegram等] dispatchReplyWithBufferedBlockDispatcher()     ──┤ 不改
  │                                                                │
  └─→ 都调 dispatchReplyFromConfig({                              ←┘
        ctx,         // ctx.SessionKey ✅
        dispatcher,  // 发送方法
      })
        │
        ├─→ 包装 dispatcher 的发送方法 ← 【唯一改动点】
        │
        ├─→ AI 推理
        │     └─→ after_tool_call ctx = { sessionKey } ✅
        │           └─→ 插件存 buffer[sessionKey]
        │
        └─→ 包装后的 sendFinalReply(payload)
              │
              ├─→ runMessageSending({ content }, { sessionKey }) ✅
              │     └─→ 插件取 buffer[sessionKey]，修改 content
              │
              └─→ 原始 sendFinalReply(修改后的 payload)
                    └─→ deliver → channel SDK → 用户收到带操作清单的回复
```

### 方案二：before_prompt_build 降级（不推荐）

通过 prompt 注入让 AI 自己输出操作清单。

- 优点：不改核心代码，纯插件实现
- 缺点：消耗 token、依赖 AI 遵从指令（不稳定）、难以保证当前轮次审计准确性

### 当前版本对应

- dist 版规则：`patches/dist-rules/2026.3.13.json`
- 源码版规则：`patches/source-rules/2026.3.22.patch`
- 两者都对齐到同一套 `wrappedDispatcher` 方案

## 项目结构

```
action-audit/
├── README.md                  # 本文档
├── patches/
│   ├── source-rules/
│   │   └── 2026.3.22.patch
│   ├── reapply-openclaw-message-sending-bridge.sh
│   ├── reapply-openclaw-message-sending-bridge-dist.sh
│   ├── dist-rules/
│   │   └── 2026.3.13.json
│   └── README.md
└── plugin/
    ├── index.ts               # 插件代码
    ├── openclaw.plugin.json   # 插件清单
    └── package.json           # 包信息
```

## 设计文档

### 需求分析

- **目标行为**：每次回复末尾追加操作清单，按风险分级标注。纯对话不追加
- **触发条件**：本轮对话中有工具调用时触发
- **验收标准**：
  1. 执行命令 → 末尾可见命令和状态
  2. 写入文件 → 末尾可见文件路径
  3. 纯对话 → 末尾干净
  4. AI 虚假声称 → 操作清单无记录，可识别
- **约束**：不消耗 token、不影响现有功能、与 smart-model-router 不冲突
