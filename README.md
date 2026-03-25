# Action Audit

一个 OpenClaw 插件，在每次回复末尾自动追加操作清单，让用户看到 AI 实际执行了什么（工具调用、命令、文件操作等）。

## 解决什么问题

小派在对话中会自主执行命令、修改文件，但回复里可能只说"已完成"。用户无法确认：
- 它是否真的执行了？（AI 有时会虚假声称）
- 具体执行了什么命令？改了哪个文件？
- 有没有做超出预期的操作？

Action Audit 在代码层捕获所有工具调用，强制追加到回复末尾。AI 无法伪造这些记录。

## 效果预览

```
小派的回复内容...

(via ⚙️ glm5)
——————————
📋 本次操作：
- ⚠️ 执行命令：systemctl --user restart openclaw-gateway（成功）
- ⚠️ 写入文件：~/.openclaw/openclaw.json（成功）
- 🌐 抓取网页：https://example.com/api（成功）
- 📄 读取文件：~/.openclaw/openclaw.json（成功）
- 📄 搜索内容：*.json in ~/.openclaw/（成功）
```

纯对话（无工具调用）时不追加任何内容。

## 工作原理

### 使用的 Hook

| Hook | 优先级 | 执行模式 | 作用 |
|------|--------|----------|------|
| `after_tool_call` | 0 | void 并行 | 每次工具执行完成后触发，捕获工具名、参数、结果，存入内存缓存 |
| `message_sending` | -99 | 修改串行 | 回复发送前触发，从缓存取操作列表，格式化后追加到回复末尾 |

### 数据流

```
AI 调用工具（bash/read/write/...）
    ↓
after_tool_call 触发
    ↓
捕获 toolName + params + error → 分级 → 存入会话级缓存
    ↓
AI 生成回复
    ↓
message_sending 触发
    ↓
从缓存取操作列表 → 排序（高风险优先）→ 格式化 → 追加到回复末尾 → 清空缓存
```

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
- **零 token 消耗（默认）**：`deliveryMode=message_sending` 时纯代码层处理，不调用大模型
- **可降级兜底**：`deliveryMode=prompt_fallback` 时通过 prompt 注入审计区块（会消耗 token，依赖模型遵从）

## 配置

首次启动自动生成配置文件：`~/.openclaw/plugins/action-audit/config.json`

```json
{
  "maxDisplay": 10,
  "separator": "\n\n——————————\n",
  "deliveryMode": "message_sending",
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
| `deliveryMode` | 交付模式：`message_sending`（默认，零 token）或 `prompt_fallback`（兜底） |
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

## 已知问题

### message_sending Hook 不触发（2026-03-25 发现）

- **现象**：`after_tool_call` 正常触发并捕获工具调用，但 `message_sending` 不触发，操作清单无法追加到回复
- **影响范围**：全局，smart-model-router 的 `message_sending` 同样不触发（模型标注改由 `before_prompt_build` 注入 prompt 实现）
- **原因**：待排查，疑似 OpenClaw v2026.2.13 的 Hook runner 问题
- **当前可用方案**：将 `deliveryMode` 改为 `prompt_fallback`，重启网关后可继续输出审计区块（会消耗 token，依赖模型遵从）

### 工具名差异

OpenClaw 实际的工具名可能与预期不同（如 `exec` 而非 `bash`）。可通过配置文件的 `rules` 添加新的工具名映射。

### 会话隔离说明

插件已改为“按会话缓存”操作记录：不同聊天/会话的操作不会互相串线。

## 项目结构

```
action-audit/
├── README.md                  # 本文档
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
