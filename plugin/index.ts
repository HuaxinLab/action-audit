// ── action-audit plugin ─────────────────────────────────────────────────────
// Captures tool calls during a conversation and appends an operation summary
// to the reply before sending. Default mode is zero-token code-layer processing.
// Configuration: ~/.openclaw/plugins/action-audit/config.json

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ───────────────────────────────────────────────────────────────────

type RiskLevel = "high" | "medium" | "low";

type AuditEntry = {
  risk: RiskLevel;
  icon: string;
  label: string;
  toolName: string;
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
const DBG_MAX_BYTES = 1024 * 1024;
const DBG_KEEP_BYTES = 256 * 1024;

function rotateDebugLogIfNeeded() {
  try {
    if (!existsSync(DBG_PATH)) return;
    const size = statSync(DBG_PATH).size;
    if (size <= DBG_MAX_BYTES) return;
    const text = readFileSync(DBG_PATH, "utf-8");
    const tail = text.slice(-DBG_KEEP_BYTES);
    writeFileSync(DBG_PATH, `[truncated ${new Date().toISOString()}]\n${tail}`, "utf-8");
  } catch {}
}

function dbg(msg: string) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    rotateDebugLogIfNeeded();
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
      "exec": "执行命令",
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
      separator: normalizeEscapedText(loaded.separator ?? DEFAULT_CONFIG.separator),
      icons: { ...DEFAULT_CONFIG.icons, ...loaded.icons },
      rules: {
        high: {
          ...normalizeRuleMap(DEFAULT_CONFIG.rules.high),
          ...normalizeRuleMap(loaded.rules?.high),
        },
        medium: {
          ...normalizeRuleMap(DEFAULT_CONFIG.rules.medium),
          ...normalizeRuleMap(loaded.rules?.medium),
        },
        low: {
          ...normalizeRuleMap(DEFAULT_CONFIG.rules.low),
          ...normalizeRuleMap(loaded.rules?.low),
        },
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

function normalizeEscapedText(value: string): string {
  return String(value)
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function normalizeRuleMap(input: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const key = String(k).trim().toLowerCase();
    if (!key) continue;
    out[key] = v;
  }
  return out;
}

// ── Session-scoped audit buffer ───────────────────────────────────────────────

const bufferBySession = new Map<string, AuditEntry[]>();
const GLOBAL_FALLBACK_KEY = "__global__";
const FALLBACK_TTL_MS = 60_000;
type TimedAuditEntry = { entry: AuditEntry; ts: number };
const fallbackByRoute = new Map<string, TimedAuditEntry[]>();

function getSessionKey(ctx: any): string {
  return String(ctx?.sessionKey ?? GLOBAL_FALLBACK_KEY).trim().toLowerCase();
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

function getRouteKey(ctx: any): string {
  const channelId = String(ctx?.channelId ?? "").trim().toLowerCase();
  const accountId = String(ctx?.accountId ?? "").trim().toLowerCase();
  const conversationId = String(ctx?.conversationId ?? "").trim().toLowerCase();
  if (!channelId && !accountId && !conversationId) return GLOBAL_FALLBACK_KEY;
  return `${channelId}|${accountId}|${conversationId}`;
}

function pruneTimedBucket(bucket: TimedAuditEntry[], now: number): TimedAuditEntry[] {
  return bucket.filter((x) => now - x.ts <= FALLBACK_TTL_MS);
}

function pushToFallback(entry: AuditEntry, ctx?: any): void {
  const key = getRouteKey(ctx);
  if (key === GLOBAL_FALLBACK_KEY) return;
  const now = Date.now();
  const existing = fallbackByRoute.get(key) ?? [];
  const pruned = pruneTimedBucket(existing, now);
  pruned.push({ entry, ts: now });
  fallbackByRoute.set(key, pruned);
}

function clearFallbackForCtx(ctx?: any): void {
  const key = getRouteKey(ctx);
  if (key === GLOBAL_FALLBACK_KEY) return;
  fallbackByRoute.delete(key);
}

function takeFallbackEntries(routeKey: string): AuditEntry[] {
  const now = Date.now();
  const bucket = fallbackByRoute.get(routeKey) ?? [];
  const pruned = pruneTimedBucket(bucket, now);
  fallbackByRoute.delete(routeKey);
  return pruned.map((x) => x.entry);
}

function resolveBufferForSending(ctx?: any): {
  entries: AuditEntry[];
  source: string;
  routeKey: string;
} {
  const sessionKey = String(ctx?.sessionKey ?? "").trim().toLowerCase();
  if (sessionKey) {
    const sessionEntries = bufferBySession.get(sessionKey) ?? [];
    if (sessionEntries.length > 0) {
      return {
        entries: sessionEntries,
        source: `session:${sessionKey}`,
        routeKey: GLOBAL_FALLBACK_KEY,
      };
    }
  }
  const routeKey = getRouteKey(ctx);
  if (routeKey === GLOBAL_FALLBACK_KEY) {
    return { entries: [], source: "route:none", routeKey };
  }
  const routeEntries = takeFallbackEntries(routeKey);
  if (routeEntries.length > 0) {
    return { entries: routeEntries, source: `route:${routeKey}`, routeKey };
  }
  return { entries: [], source: "route:empty", routeKey };
}

// ── Risk classification ─────────────────────────────────────────────────────

function classifyRisk(toolName: string, params: Record<string, unknown>): ToolRule {
  const rawName = toolName.trim().toLowerCase();
  const candidates = Array.from(new Set([
    rawName,
    rawName.split("/").pop() ?? rawName,
    rawName.split(".").pop() ?? rawName,
    rawName.split(":").pop() ?? rawName,
    rawName.split("_").pop() ?? rawName,
  ]));

  const pickLabel = (rules: Record<string, string>): string | undefined => {
    for (const name of candidates) {
      if (rules[name]) return rules[name];
    }
    return undefined;
  };

  // Check configured rules in priority order
  const highLabel = pickLabel(config.rules.high);
  if (highLabel) {
    return { risk: "high", icon: config.icons.high, label: highLabel };
  }
  const mediumLabel = pickLabel(config.rules.medium);
  if (mediumLabel) {
    return { risk: "medium", icon: config.icons.medium, label: mediumLabel };
  }
  const lowLabel = pickLabel(config.rules.low);
  if (lowLabel) {
    return { risk: "low", icon: config.icons.low, label: lowLabel };
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

function extractCommandText(params: Record<string, unknown>): string {
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (params[key] !== undefined && params[key] !== null) return params[key];
    }
    return undefined;
  };

  const direct = pick("command", "cmd", "input", "script", "shellCommand");
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const argv = pick("argv", "args");
  if (Array.isArray(argv) && argv.length > 0) {
    const joined = argv.map((x) => String(x)).join(" ").trim();
    if (joined) return joined;
  }

  const nestedCommand = pick("payload", "request", "toolInput");
  if (nestedCommand && typeof nestedCommand === "object" && !Array.isArray(nestedCommand)) {
    const nested = nestedCommand as Record<string, unknown>;
    const nestedDirect =
      nested.command ?? nested.cmd ?? nested.input ?? nested.script ?? nested.shellCommand;
    if (typeof nestedDirect === "string" && nestedDirect.trim()) return nestedDirect.trim();
    const nestedArgv = nested.argv ?? nested.args;
    if (Array.isArray(nestedArgv) && nestedArgv.length > 0) {
      const joined = nestedArgv.map((x) => String(x)).join(" ").trim();
      if (joined) return joined;
    }
  }

  return "";
}

function formatDetail(toolName: string, params: Record<string, unknown>): string {
  const name = toolName.toLowerCase();

  // bash/shell commands — show the command
  if (name === "bash" || name === "shell" || name === "execute" || name === "exec" || name === "run_command" || name === "terminal") {
    const cmd = extractCommandText(params);
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
    const renderedLabel = e.label === "执行命令" ? `调用工具 ${e.toolName}` : e.label;
    const detail = e.detail ? `：${e.detail}` : "";
    return `${e.icon} ${renderedLabel}${detail}（${e.status}）`;
  });

  let summary = `🔎 本次操作：\n${lines.join("\n")}`;

  if (remaining > 0) {
    summary += `\n…及其他 ${remaining} 项操作`;
  }

  return summary;
}

function contentHasAuditBlock(content: string): boolean {
  return content.includes("🔎 本次操作：");
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

          const entry: AuditEntry = { risk, icon, label, toolName, detail, status };
          getBuffer(ctx).push(entry);
          // Only use route fallback when sessionKey is truly unavailable.
          if (sessionKey === GLOBAL_FALLBACK_KEY) pushToFallback(entry, ctx);
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
        try {
          const ctxKeys = ctx && typeof ctx === "object" ? Object.keys(ctx).slice(0, 20) : [];
          dbg(`message_sending CTX keys=${ctxKeys.join(",")}`);
        } catch {}
        dbg(
          `message_sending FIRED: session=${ctx?.sessionKey} channel=${ctx?.channelId} account=${ctx?.accountId} conversation=${ctx?.conversationId} content_len=${String(event?.content ?? "").length}`,
        );
        try {
          const { entries: buffer, source, routeKey } = resolveBufferForSending(ctx);

          if (buffer.length === 0) return undefined;

          const content = String(event?.content ?? "");

          // Idempotency guard: some channels may pass through multiple send paths.
          // If an audit block is already present, skip appending again for this send.
          if (contentHasAuditBlock(content)) {
            if (source.startsWith("session:")) {
              const key = source.slice("session:".length);
              bufferBySession.delete(key);
              clearFallbackForCtx(ctx);
            }
            dbg(`message_sending: skip duplicate append from=${source} route=${routeKey} entries=${buffer.length}`);
            return undefined;
          }

          const summary = buildAuditSummary(buffer);

          if (source.startsWith("session:")) {
            const key = source.slice("session:".length);
            bufferBySession.delete(key);
            clearFallbackForCtx(ctx);
          }

          dbg(`message_sending: appending summary from=${source} route=${routeKey} entries=${buffer.length}`);
          return { content: `${content}${config.separator}${summary}` };
        } catch (e: any) {
          dbg(`message_sending ERROR: ${e?.message}`);
          return undefined;
        }
      },
      { priority: -1000 },
    );
  },
};
