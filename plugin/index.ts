// ── action-audit plugin ─────────────────────────────────────────────────────
// Captures tool calls during a conversation and appends an operation summary
// to the reply before sending. Default mode is zero-token code-layer processing.
// Configuration: ~/.openclaw/plugins/action-audit/config.json

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ───────────────────────────────────────────────────────────────────

type RiskLevel = "high" | "medium" | "low";

type AuditEntry = {
  risk: RiskLevel;
  icon: string;
  label: string;
  detail: string;
  status: string;
};

type ToolRule = {
  risk: RiskLevel;
  icon: string;
  label: string;
};

type AuditConfig = {
  maxDisplay: number;
  separator: string;
  rules: {
    high: Record<string, string>;    // toolName -> display label
    medium: Record<string, string>;
    low: Record<string, string>;
  };
  icons: {
    high: string;
    medium: string;
    low: string;
  };
  sensitivePatterns: string[];
};

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".openclaw", "plugins", "action-audit");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DBG_PATH = join(CONFIG_DIR, "debug.log");

function dbg(msg: string) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(DBG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}


const DEFAULT_CONFIG: AuditConfig = {
  maxDisplay: 10,
  separator: "\n\n——————————\n",
  icons: {
    high: "⚠️",
    medium: "🌐",
    low: "📄",
  },
  rules: {
    high: {
      "bash": "执行命令",
      "shell": "执行命令",
      "execute": "执行命令",
      "run_command": "执行命令",
      "terminal": "执行命令",
      "write": "写入文件",
      "write_file": "写入文件",
      "create_file": "创建文件",
      "edit": "编辑文件",
      "edit_file": "编辑文件",
      "delete": "删除文件",
      "remove": "删除文件",
      "rm": "删除文件",
    },
    medium: {
      "web_fetch": "抓取网页",
      "sessions_spawn": "调用子agent/skill",
    },
    low: {
      "read": "读取文件",
      "read_file": "读取文件",
      "cat": "读取文件",
      "head": "读取文件",
      "tail": "读取文件",
      "search": "搜索文件",
      "grep": "搜索内容",
      "find": "查找文件",
      "glob": "匹配文件",
      "list_files": "列出目录",
      "ls": "列出目录",
      "web_search": "网页搜索",
    },
  },
  sensitivePatterns: [
    "key", "token", "password", "secret", "credential", "apikey", "api_key",
  ],
};

let config: AuditConfig = DEFAULT_CONFIG;

function loadConfig(): AuditConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const loaded = JSON.parse(raw);
    // Merge with defaults to ensure all fields exist
    return {
      maxDisplay: loaded.maxDisplay ?? DEFAULT_CONFIG.maxDisplay,
      separator: loaded.separator ?? DEFAULT_CONFIG.separator,
      icons: { ...DEFAULT_CONFIG.icons, ...loaded.icons },
      rules: {
        high: { ...DEFAULT_CONFIG.rules.high, ...loaded.rules?.high },
        medium: { ...DEFAULT_CONFIG.rules.medium, ...loaded.rules?.medium },
        low: { ...DEFAULT_CONFIG.rules.low, ...loaded.rules?.low },
      },
      sensitivePatterns: loaded.sensitivePatterns ?? DEFAULT_CONFIG.sensitivePatterns,
    };
  } catch {
    // Config doesn't exist or is invalid — write default and use it
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    } catch {
      // Can't write config, use defaults silently
    }
    return DEFAULT_CONFIG;
  }
}

// ── Session-scoped audit buffer ───────────────────────────────────────────────

const bufferBySession = new Map<string, AuditEntry[]>();

function getSessionKey(ctx: any): string {
  return String(ctx?.sessionKey ?? "__global__").trim().toLowerCase();
}

function getBuffer(ctx?: any): AuditEntry[] {
  const key = getSessionKey(ctx);
  const existing = bufferBySession.get(key);
  if (existing) return existing;
  const created: AuditEntry[] = [];
  bufferBySession.set(key, created);
  return created;
}

function clearBuffer(ctx?: any): void {
  const key = getSessionKey(ctx);
  bufferBySession.delete(key);
}

// ── Risk classification ─────────────────────────────────────────────────────

function classifyRisk(toolName: string, params: Record<string, unknown>): ToolRule {
  const name = toolName.toLowerCase();

  // Check configured rules in priority order
  if (config.rules.high[name]) {
    return { risk: "high", icon: config.icons.high, label: config.rules.high[name] };
  }
  if (config.rules.medium[name]) {
    return { risk: "medium", icon: config.icons.medium, label: config.rules.medium[name] };
  }
  if (config.rules.low[name]) {
    return { risk: "low", icon: config.icons.low, label: config.rules.low[name] };
  }

  // Heuristic fallback: check params for write-like indicators
  const paramStr = JSON.stringify(params).toLowerCase();
  if (paramStr.includes("write") || paramStr.includes("delete") || paramStr.includes("remove")) {
    return { risk: "high", icon: config.icons.high, label: `调用工具 ${toolName}` };
  }

  // Unknown tool — default to low risk
  return { risk: "low", icon: config.icons.low, label: `调用工具 ${toolName}` };
}

// ── Detail formatting ───────────────────────────────────────────────────────

function buildSensitiveRegex(): RegExp {
  const keywords = config.sensitivePatterns.join("|");
  return new RegExp(`(?:${keywords})[\\s]*[=:]\\s*\\S+`, "gi");
}

function sanitize(text: string): string {
  const regex = buildSensitiveRegex();
  return text.replace(regex, (match) => {
    const sepIdx = match.search(/[=:]/);
    if (sepIdx === -1) return match;
    return match.slice(0, sepIdx + 1) + " ****";
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function formatDetail(toolName: string, params: Record<string, unknown>): string {
  const name = toolName.toLowerCase();

  // bash/shell commands — show the command
  if (name === "bash" || name === "shell" || name === "execute" || name === "run_command" || name === "terminal") {
    const cmd = String(params?.command ?? params?.cmd ?? params?.input ?? "");
    return sanitize(truncate(cmd, 80));
  }

  // sessions_spawn — show model and task
  if (name === "sessions_spawn") {
    const model = String(params?.model ?? "");
    const task = String(params?.task ?? params?.message ?? "");
    const parts: string[] = [];
    if (model) parts.push(model);
    if (task) parts.push(truncate(task, 50));
    return parts.join(" — ") || "";
  }

  // file operations — show path
  const filePath = String(params?.path ?? params?.file_path ?? params?.filePath ?? "");
  if (filePath) return truncate(filePath, 60);

  // search — show pattern/query
  const query = String(params?.pattern ?? params?.query ?? params?.q ?? params?.url ?? "");
  if (query) return truncate(query, 60);

  // Fallback — show param keys
  const paramKeys = Object.keys(params).slice(0, 3).join(", ");
  return paramKeys ? `参数: ${truncate(paramKeys, 50)}` : "";
}

// ── Build audit summary ─────────────────────────────────────────────────────

function buildAuditSummary(entries: AuditEntry[]): string {
  if (entries.length === 0) return "";

  // Sort: high risk first, then medium, then low
  const riskOrder: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...entries].sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk]);

  const displayed = sorted.slice(0, config.maxDisplay);
  const remaining = sorted.length - displayed.length;

  const lines = displayed.map((e) => {
    const detail = e.detail ? `：${e.detail}` : "";
    return `- ${e.icon} ${e.label}${detail}（${e.status}）`;
  });

  let summary = `📋 本次操作：\n${lines.join("\n")}`;

  if (remaining > 0) {
    summary += `\n- …及其他 ${remaining} 项操作`;
  }

  return summary;
}

// ── Plugin Entry ────────────────────────────────────────────────────────────

export default {
  id: "action-audit",
  name: "Action Audit",
  description: "Appends a tool-call operation summary to every reply, so users can verify what the AI actually did.",

  register(api: any) {
    // Load config at startup
    config = loadConfig();
    dbg("register() called — plugin loaded successfully");

    // ── after_tool_call: capture each tool invocation ──
    api.on(
      "after_tool_call",
      (event: any, ctx: any) => {
        try {
          const toolName = String(event?.toolName ?? "unknown");
          const params: Record<string, unknown> = event?.params ?? {};
          const error = event?.error;
          const status = error ? "失败" : "成功";
          const sessionKey = getSessionKey(ctx);

          dbg(`after_tool_call: tool=${toolName} session=${sessionKey} error=${error ?? "none"}`);

          const { risk, icon, label } = classifyRisk(toolName, params);
          const detail = sanitize(formatDetail(toolName, params));

          const entry: AuditEntry = { risk, icon, label, detail, status };
          getBuffer(ctx).push(entry);
          dbg(`after_tool_call: buffered entry, buffer size=${getBuffer(ctx).length}`);
        } catch (e: any) {
          dbg(`after_tool_call ERROR: ${e?.message}`);
        }
      },
      { priority: 0 },
    );

    // ── message_sending: append audit summary ──
    api.on(
      "message_sending",
      (event: any, ctx: any) => {
        dbg(`message_sending FIRED: session=${ctx?.sessionKey} content_len=${String(event?.content ?? "").length}`);
        try {
          const buffer = getBuffer(ctx);

          if (buffer.length === 0) return undefined;

          const content = String(event?.content ?? "");
          const summary = buildAuditSummary(buffer);

          clearBuffer(ctx);

          dbg(`message_sending: appending summary`);
          return { content: `${content}${config.separator}${summary}` };
        } catch (e: any) {
          dbg(`message_sending ERROR: ${e?.message}`);
          return undefined;
        }
      },
      { priority: -99 },
    );
  },
};
