// Shared routing library: build tev1 state, call tev1, apply fallback rules,
// cache decisions, and log them. Uses only Node built-ins so the hook starts fast.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Candidate {
  alias: string;
  id: string;
  tier: number;
  criteria: string;
}

export interface RouterConfig {
  ollama: { url: string; model: string; timeoutMs: number };
  instructions: string;
  candidates: Candidate[];
  defaultModel: string;
  minGap: number;
  cacheTtlMs: number;
  numCtx: number;
  promptExcerptTokens: number;
  stateMaxTokens: number;
  skipSubagentTypes: string[];
}

export type Source = "tev1" | "fallback" | "cache" | "explicit" | "disabled" | "skipped";

export interface RouteResult {
  model: string | null;
  choice: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  gap: number | null;
  source: Source;
  reason?: string;
  latency_ms: number;
}

export interface RouteInput {
  prompt: string;
  subagentType?: string;
  explicitModel?: string | null;
  caller?: "hook" | "mcp" | "cli";
}

export interface RouteDeps {
  config?: RouterConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

const DEFAULTS: RouterConfig = {
  ollama: { url: "http://localhost:11434/v1/systemone", model: "tev1", timeoutMs: 3000 },
  instructions: "Pick the cheapest Claude model that can reliably complete this delegated task.",
  candidates: [
    { alias: "haiku", id: "claude-haiku-4-5-20251001", tier: 1, criteria: "trivial tasks" },
    { alias: "sonnet", id: "claude-sonnet-5-5", tier: 2, criteria: "moderate tasks" },
    { alias: "opus", id: "claude-opus-5-5", tier: 3, criteria: "hard tasks" },
    { alias: "fable", id: "claude-fable-5-1", tier: 4, criteria: "hardest tasks" },
  ],
  defaultModel: "sonnet",
  minGap: 0.15,
  cacheTtlMs: 600_000,
  numCtx: 2050,
  promptExcerptTokens: 1200,
  stateMaxTokens: 1400,
  skipSubagentTypes: [],
};

export function defaultConfigPath(): string {
  // Works from both src/ and dist/ (each one level below the plugin root).
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "config", "models.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const path = env.ROUTER_CONFIG || defaultConfigPath();
  let raw: Partial<RouterConfig> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Partial<RouterConfig>;
  } catch {
    // Missing/invalid config: fall back to built-in defaults.
  }
  return { ...DEFAULTS, ...raw, ollama: { ...DEFAULTS.ollama, ...(raw.ollama && typeof raw.ollama === "object" ? raw.ollama : {}) } };
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROUTER_DATA_DIR || join(homedir(), ".claude-model-router");
}

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Keep head (~2/3) and tail (~1/3) of text so it fits maxTokens (chars/4 estimate). */
export function truncateMiddle(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const marker = "\n[... middle omitted ...]\n";
  const budget = Math.max(0, maxTokens * 4 - marker.length);
  const head = Math.ceil((budget * 2) / 3);
  const tail = budget - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : "");
}

const FILE_EXT = /^[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|c|cc|cpp|h|hpp|cs|md|json|ya?ml|toml|sh|sql|css|html)$/;
const KEYWORDS =["plan", "design", "architect", "debug", "refactor", "search", "find"];

export function extractSignals(prompt: string): { keywords: string[]; filePaths: number } {
  const lower = prompt.toLowerCase();
  const keywords = KEYWORDS.filter((k) => new RegExp(`\\b${k}`, "i").test(lower));
  // Token-based scan (linear time; a single path regex backtracks badly on long unbroken text).
  const paths = new Set<string>();
  for (const raw of prompt.split(/[\s"'`()<>\[\]{},;]+/)) {
    if (raw.length < 3 || raw.length > 300) continue;
    const tok = raw.replace(/[.:!?]+$/, "");
    if (/^[\w.~\/-]+$/.test(tok) && (/\/[\w.-]*\.[A-Za-z0-9]{1,8}$/.test(tok) || FILE_EXT.test(tok))) paths.add(tok);
  }
  return { keywords, filePaths: paths.size };
}

export function buildState(prompt: string, subagentType: string | undefined, cfg: RouterConfig): string {
  const sig = extractSignals(prompt);
  const header =
    `Delegated subagent task\n` +
    `subagent_type: ${subagentType || "general-purpose"}\n` +
    `prompt_length_chars: ${prompt.length} (~${estimateTokens(prompt)} tokens)\n` +
    `keyword_signals: ${sig.keywords.length ? sig.keywords.join(", ") : "none"}\n` +
    `file_paths_mentioned: ${sig.filePaths}\n` +
    `prompt_excerpt:\n`;
  const excerptBudget = Math.max(0, Math.min(cfg.promptExcerptTokens, cfg.stateMaxTokens - estimateTokens(header) - 2));
  return header + truncateMiddle(prompt, excerptBudget);
}

export function buildRequest(state: string, cfg: RouterConfig) {
  const criteria: Record<string, string> = {};
  for (const c of cfg.candidates) criteria[c.alias] = c.criteria;
  return {
    model: cfg.ollama.model,
    state,
    questions: { model: { type: "choice", instructions: cfg.instructions, criteria } },
  };
}

export class ContextOverflowError extends Error {
  constructor(msg: string) {
    super(`tev1 context overflow: ${msg.slice(0, 120)}`);
    this.name = "ContextOverflowError";
  }
}

interface Tev1Answer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | null;
}

export async function callTev1(req: unknown, cfg: RouterConfig, fetchImpl: typeof fetch = fetch): Promise<Tev1Answer> {
  const res = await fetchImpl(cfg.ollama.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(cfg.ollama.timeoutMs),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => "");
    // tev1 never truncates; it rejects over-long input with 400 "... has N tokens; expected 1–2050 ...".
    if (res.status === 400 && /tokens; expected/.test(text)) throw new ContextOverflowError(text);
    throw new Error(`tev1 HTTP ${res.status}`);
  }
  const body: any = await res.json();
  const a = body?.answers?.model;
  if (!a || typeof a.choice !== "string" || typeof a.probabilities !== "object" || !a.probabilities) {
    throw new Error("tev1 malformed response");
  }
  return { choice: a.choice, probabilities: a.probabilities, confidence: typeof a.confidence === "number" ? a.confidence : null };
}

/** Apply the low-certainty rule: if top1-top2 < minGap, take the higher tier of the two. */
export function decide(ans: Tev1Answer, cfg: RouterConfig): { model: string; gap: number | null; source: Source; reason?: string } {
  const tier = new Map(cfg.candidates.map((c) => [c.alias, c.tier]));
  const ranked = Object.entries(ans.probabilities)
    .filter(([k, v]) => tier.has(k) && typeof v === "number")
    .sort((a, b) => b[1] - a[1]);
  if (!tier.has(ans.choice) || ranked.length === 0) {
    return { model: cfg.defaultModel, gap: null, source: "fallback", reason: "unknown choice" };
  }
  if (ranked.length === 1) return { model: ans.choice, gap: null, source: "tev1" };
  const [[a, pa], [b, pb]] = ranked;
  const gap = pa - pb;
  if (gap < cfg.minGap) {
    const higher = (tier.get(a)! >= tier.get(b)! ? a : b);
    return { model: higher, gap, source: "fallback", reason: "low gap" };
  }
  return { model: ans.choice, gap, source: "tev1" };
}

// ---------- cache (file-based; the hook is a fresh process per call) ----------

type CacheEntry = Omit<RouteResult, "latency_ms" | "source"> & { ts: number };

function cachePath(env: NodeJS.ProcessEnv) {
  return join(dataDir(env), "cache.json");
}

function readCache(env: NodeJS.ProcessEnv): Record<string, CacheEntry> {
  try {
    return JSON.parse(readFileSync(cachePath(env), "utf8"));
  } catch {
    return {};
  }
}

export function cacheGet(key: string, cfg: RouterConfig, now: number, env: NodeJS.ProcessEnv): CacheEntry | null {
  const e = readCache(env)[key];
  return e && now - e.ts < cfg.cacheTtlMs ? e : null;
}

export function cacheSet(key: string, entry: CacheEntry, cfg: RouterConfig, now: number, env: NodeJS.ProcessEnv): void {
  try {
    const all = readCache(env);
    for (const [k, v] of Object.entries(all)) if (now - v.ts >= cfg.cacheTtlMs) delete all[k];
    all[key] = entry;
    mkdirSync(dataDir(env), { recursive: true });
    const tmp = `${cachePath(env)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, cachePath(env));
  } catch {
    // cache is best-effort
  }
}

// ---------- log ----------

export function logDecision(line: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  try {
    mkdirSync(dataDir(env), { recursive: true });
    appendFileSync(join(dataDir(env), "decisions.jsonl"), JSON.stringify(line) + "\n");
  } catch {
    // logging is best-effort
  }
}

// ---------- main entry ----------

export async function route(input: RouteInput, deps: RouteDeps = {}): Promise<RouteResult> {
  const env = deps.env ?? process.env;
  const cfg = deps.config ?? loadConfig(env);
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const start = now();
  const prompt = input.prompt ?? "";
  const promptHash = sha256(prompt);

  const finish = (r: Omit<RouteResult, "latency_ms">): RouteResult => {
    const result = { ...r, latency_ms: now() - start };
    logDecision(
      {
        ts: new Date(start).toISOString(),
        caller: input.caller ?? "cli",
        prompt_sha256: promptHash,
        subagent_type: input.subagentType ?? null,
        probabilities: result.probabilities,
        confidence: result.confidence,
        gap: result.gap,
        choice: result.choice,
        model: result.model,
        source: result.source,
        ...(result.reason ? { reason: result.reason } : {}),
        latency_ms: result.latency_ms,
      },
      env,
    );
    return result;
  };
  const empty = { choice: null, probabilities: null, confidence: null, gap: null };

  if (input.explicitModel) return finish({ ...empty, model: null, source: "explicit" });
  if (env.ROUTER_DISABLE === "1") return finish({ ...empty, model: null, source: "disabled" });
  if (input.subagentType && cfg.skipSubagentTypes.includes(input.subagentType)) {
    return finish({ ...empty, model: null, source: "skipped" });
  }

  const key = sha256(`${input.subagentType ?? ""}\n${prompt}`);
  const hit = cacheGet(key, cfg, start, env);
  if (hit) {
    const { ts: _ts, ...rest } = hit;
    return finish({ ...rest, source: "cache" });
  }

  try {
    let ans: Tev1Answer;
    try {
      ans = await callTev1(buildRequest(buildState(prompt, input.subagentType, cfg), cfg), cfg, fetchImpl);
    } catch (err) {
      if (!(err instanceof ContextOverflowError)) throw err;
      // chars/4 underestimated (dense code, short tokens): retry once with half the excerpt budget.
      const smaller = { ...cfg, promptExcerptTokens: Math.floor(cfg.promptExcerptTokens / 2), stateMaxTokens: Math.floor(cfg.stateMaxTokens / 2) };
      ans = await callTev1(buildRequest(buildState(prompt, input.subagentType, smaller), smaller), cfg, fetchImpl);
    }
    const d = decide(ans, cfg);
    const r = { model: d.model, choice: ans.choice, probabilities: ans.probabilities, confidence: ans.confidence, gap: d.gap, source: d.source, ...(d.reason ? { reason: d.reason } : {}) };
    cacheSet(key, { ...r, ts: start }, cfg, start, env);
    return finish(r);
  } catch (err) {
    const reason = err instanceof Error ? err.name === "TimeoutError" ? "timeout" : err.message : "error";
    return finish({ ...empty, model: cfg.defaultModel, source: "fallback", reason });
  }
}
