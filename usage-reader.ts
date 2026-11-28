import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionTotals } from "./rpc";

// Reads a thread's token use from its provider's session logs. bb keeps only
// the latest usage event per thread, counted from the provider process's
// start and without subagents; the logs hold every model call. Files are read
// once, then only the lines appended since.

interface ClaudeUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface FileState {
  offset: number;
  rest: string;
  /** Claude Code: usage per message id; a message spans several lines. */
  claude: Map<string, ClaudeUsage>;
  /** Codex: cumulative totals, with earlier runs added when a counter restarts. */
  codexCarry: SessionTotals;
  codexLast: SessionTotals | null;
}

const MAX_FILES = 64;
const files = new Map<string, FileState>();

function zero(): SessionTotals {
  return { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };
}

function add(a: SessionTotals, b: SessionTotals): SessionTotals {
  return {
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseClaude(line: string, state: FileState) {
  if (!line.includes('"usage"')) return;
  let record: { message?: { id?: unknown; usage?: Record<string, unknown> } };
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const usage = record.message?.usage;
  const id = record.message?.id;
  if (usage === undefined || typeof id !== "string") return;
  state.claude.set(id, {
    input: num(usage.input_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    output: num(usage.output_tokens),
  });
}

function parseCodex(line: string, state: FileState) {
  if (!line.includes('"token_count"')) return;
  let record: { payload?: { type?: unknown; info?: { total_token_usage?: Record<string, unknown> } | null } };
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const total = record.payload?.type === "token_count" ? record.payload.info?.total_token_usage : undefined;
  if (total === undefined) return;
  const cached = num(total.cached_input_tokens);
  const next: SessionTotals = {
    totalTokens: num(total.total_tokens),
    inputTokens: num(total.input_tokens),
    cachedInputTokens: cached,
    cacheReadInputTokens: cached,
    cacheWriteInputTokens: num(total.cache_write_input_tokens),
    outputTokens: num(total.output_tokens),
  };
  // A resumed session can start its counter again; keep what came before.
  if (state.codexLast !== null && next.totalTokens < state.codexLast.totalTokens) {
    state.codexCarry = add(state.codexCarry, state.codexLast);
  }
  state.codexLast = next;
}

// One read per file at a time, so two panes never race over the offset.
const reading = new Map<string, Promise<SessionTotals | null>>();

function readFile(path: string, kind: "claude" | "codex"): Promise<SessionTotals | null> {
  const previous = reading.get(path) ?? Promise.resolve(null);
  const next = previous.catch(() => null).then(() => readAppended(path, kind));
  reading.set(path, next);
  void next.finally(() => {
    if (reading.get(path) === next) reading.delete(path);
  });
  return next;
}

async function readAppended(path: string, kind: "claude" | "codex"): Promise<SessionTotals | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    files.delete(path);
    return null;
  }
  let state = files.get(path);
  if (state === undefined || size < state.offset) {
    state = { offset: 0, rest: "", claude: new Map(), codexCarry: zero(), codexLast: null };
    if (files.size >= MAX_FILES) files.delete(files.keys().next().value as string);
    files.set(path, state);
  }
  if (size > state.offset) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - state.offset);
      await handle.read(buffer, 0, buffer.length, state.offset);
      state.offset = size;
      const lines = (state.rest + buffer.toString("utf8")).split("\n");
      state.rest = lines.pop() ?? "";
      for (const line of lines) {
        if (kind === "claude") parseClaude(line, state);
        else parseCodex(line, state);
      }
    } finally {
      await handle.close();
    }
  }
  if (kind === "codex") return state.codexLast === null ? null : add(state.codexCarry, state.codexLast);
  let totals = zero();
  for (const usage of state.claude.values()) {
    totals = add(totals, {
      totalTokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
      inputTokens: usage.input,
      cachedInputTokens: usage.cacheRead + usage.cacheWrite,
      cacheReadInputTokens: usage.cacheRead,
      cacheWriteInputTokens: usage.cacheWrite,
      outputTokens: usage.output,
    });
  }
  return totals;
}

// Where each session's log lives, found once and remembered.
const locations = new Map<string, string | null>();

async function findClaudeLog(sessionId: string): Promise<string | null> {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return null;
  }
  for (const project of projects) {
    const path = join(root, project, `${sessionId}.jsonl`);
    try {
      await stat(path);
      return path;
    } catch {
      // Not in this project.
    }
  }
  return null;
}

async function findCodexLog(sessionId: string): Promise<string | null> {
  const roots = [join(homedir(), ".bb", "codex-home", "sessions"), join(homedir(), ".codex", "sessions")];
  const suffix = `${sessionId}.jsonl`;
  for (const root of roots) {
    // sessions/YYYY/MM/DD/rollout-…-<id>.jsonl, newest days first.
    const walk = async (dir: string, depth: number): Promise<string | null> => {
      let entries: string[];
      try {
        entries = (await readdir(dir)).sort().reverse();
      } catch {
        return null;
      }
      for (const entry of entries) {
        if (depth === 3) {
          if (entry.endsWith(suffix)) return join(dir, entry);
          continue;
        }
        const found = await walk(join(dir, entry), depth + 1);
        if (found !== null) return found;
      }
      return null;
    };
    const found = await walk(root, 0);
    if (found !== null) return found;
  }
  return null;
}

async function locate(providerId: string, sessionId: string): Promise<string | null> {
  const key = `${providerId}:${sessionId}`;
  const known = locations.get(key);
  if (known !== undefined && known !== null) return known;
  const found = providerId === "claude-code" ? await findClaudeLog(sessionId) : await findCodexLog(sessionId);
  // A log not written yet is looked for again next time.
  if (found !== null) locations.set(key, found);
  return found;
}

async function claudeSubagentLogs(mainLog: string): Promise<string[]> {
  const dir = join(mainLog.slice(0, -".jsonl".length), "subagents");
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export const SUPPORTED_PROVIDERS = new Set(["claude-code", "codex"]);

/** Totals per log for the given provider sessions, or null when none has a log here. */
export async function readSessionTotals(providerId: string, sessionIds: readonly string[]): Promise<SessionTotals[] | null> {
  if (!SUPPORTED_PROVIDERS.has(providerId)) return null;
  const sessions: SessionTotals[] = [];
  for (const sessionId of sessionIds) {
    const log = await locate(providerId, sessionId);
    if (log === null) continue;
    if (providerId === "claude-code") {
      for (const path of [log, ...(await claudeSubagentLogs(log))]) {
        const totals = await readFile(path, "claude");
        if (totals !== null) sessions.push(totals);
      }
    } else {
      const totals = await readFile(log, "codex");
      if (totals !== null) sessions.push(totals);
    }
  }
  return sessions.length === 0 ? null : sessions;
}
