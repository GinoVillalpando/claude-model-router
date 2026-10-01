import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRequest,
  buildState,
  decide,
  estimateTokens,
  extractSignals,
  loadConfig,
  route,
  type RouterConfig,
} from "../src/router.js";

let dir: string;
let env: NodeJS.ProcessEnv;
let cfg: RouterConfig;

function tev1Response(choice: string, probabilities: Record<string, number>, confidence = 0.1) {
  return new Response(
    JSON.stringify({ model: "tev1", answers: { model: { type: "choice", choice, probabilities, confidence } }, usage: {} }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function logLines(): any[] {
  const p = join(dir, "decisions.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "router-test-"));
  env = { ROUTER_DATA_DIR: dir };
  cfg = loadConfig({});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("request schema", () => {
  it("builds a tev1 systemone request with all candidates as criteria", async () => {
    const fetchImpl = vi.fn(async () => tev1Response("haiku", { haiku: 0.8, sonnet: 0.1, opus: 0.05, fable: 0.05 }));
    await route({ prompt: "find the config file", subagentType: "Explore" }, { config: cfg, env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/systemone");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("tev1");
    expect(typeof body.state).toBe("string");
    expect(body.state).toContain("subagent_type: Explore");
    const q = body.questions.model;
    expect(q.type).toBe("choice");
    expect(q.instructions.length).toBeGreaterThan(0);
    expect(Object.keys(q.criteria)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    for (const v of Object.values(q.criteria)) expect(typeof v).toBe("string");
  });

  it("buildRequest uses config candidates", () => {
    const req = buildRequest("s", cfg);
    expect(req.questions.model.criteria.fable).toMatch(/hardest/i);
  });
});

describe("decision rules", () => {
  it("uses tev1 choice when gap is large", async () => {
    const fetchImpl = vi.fn(async () => tev1Response("haiku", { haiku: 0.7, sonnet: 0.2, opus: 0.1 }));
    const r = await route({ prompt: "list files" }, { config: cfg, env, fetchImpl });
    expect(r).toMatchObject({ model: "haiku", source: "tev1", choice: "haiku" });
    expect(r.gap).toBeCloseTo(0.5);
  });

  it("picks the higher tier of the top two when gap < 0.15", async () => {
    const fetchImpl = vi.fn(async () =>
      tev1Response("haiku", { haiku: 0.4306, sonnet: 0.3955, opus: 0.1739 }, 0.0589),
    );
    const r = await route({ prompt: "x" }, { config: cfg, env, fetchImpl });
    expect(r).toMatchObject({ model: "sonnet", source: "fallback", choice: "haiku" });
    expect(r.gap).toBeCloseTo(0.0351);
  });

  it("higher-tier fallback works regardless of order", () => {
    const d = decide({ choice: "fable", probabilities: { fable: 0.45, opus: 0.4, haiku: 0.15 }, confidence: 0 }, cfg);
    expect(d).toMatchObject({ model: "fable", source: "fallback" });
  });

  it("unknown choice falls back to default", () => {
    const d = decide({ choice: "gpt", probabilities: { gpt: 1 }, confidence: 0 }, cfg);
    expect(d).toMatchObject({ model: "sonnet", source: "fallback" });
  });
});

describe("fallbacks on failure", () => {
  it("non-200 -> default sonnet", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const r = await route({ prompt: "x" }, { config: cfg, env, fetchImpl });
    expect(r).toMatchObject({ model: "sonnet", source: "fallback", reason: "tev1 HTTP 500" });
  });

  it("network error -> default sonnet", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await route({ prompt: "x" }, { config: cfg, env, fetchImpl });
    expect(r).toMatchObject({ model: "sonnet", source: "fallback" });
  });

  it("malformed body -> default sonnet", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await route({ prompt: "x" }, { config: cfg, env, fetchImpl });
    expect(r).toMatchObject({ model: "sonnet", source: "fallback" });
  });

  it("timeout -> default sonnet", async () => {
    const fast = { ...cfg, ollama: { ...cfg.ollama, timeoutMs: 50 } };
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal!.addEventListener("abort", () => rej(init.signal!.reason));
        }),
    ) as unknown as typeof fetch;
    const r = await route({ prompt: "x" }, { config: fast, env, fetchImpl });
    expect(r).toMatchObject({ model: "sonnet", source: "fallback", reason: "timeout" });
  });

  it("context-overflow 400 -> retries once with a smaller state", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string).state);
      return bodies.length === 1
        ? new Response(JSON.stringify({ error: "prompt 0 has 2668 tokens; expected 1–2050 (input is never truncated)" }), { status: 400 })
        : tev1Response("opus", { haiku: 0.1, sonnet: 0.2, opus: 0.7 });
    }) as unknown as typeof fetch;
    const r = await route({ prompt: "y ".repeat(20_000) }, { config: cfg, env, fetchImpl });
    expect(r).toMatchObject({ model: "opus", source: "tev1" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].length).toBeLessThan(bodies[0].length * 0.6);
  });

  it("other 400 -> fallback without retry", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"bad schema"}', { status: 400 }));
    const r = await route({ prompt: "x" }, { config: cfg, env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ model: "sonnet", source: "fallback", reason: "tev1 HTTP 400" });
  });

  it("errors are not cached", async () => {
    const bad = vi.fn(async () => new Response("", { status: 503 }));
    await route({ prompt: "same" }, { config: cfg, env, fetchImpl: bad });
    const good = vi.fn(async () => tev1Response("haiku", { haiku: 0.9, sonnet: 0.1 }));
    const r = await route({ prompt: "same" }, { config: cfg, env, fetchImpl: good });
    expect(r.source).toBe("tev1");
  });
});

describe("explicit / disabled", () => {
  it("explicit model -> no call, model null, source explicit", async () => {
    const fetchImpl = vi.fn();
    const r = await route({ prompt: "x", explicitModel: "opus" }, { config: cfg, env, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toMatchObject({ model: null, source: "explicit" });
  });

  it("ROUTER_DISABLE=1 -> no call, source disabled", async () => {
    const fetchImpl = vi.fn();
    const r = await route({ prompt: "x" }, { config: cfg, env: { ...env, ROUTER_DISABLE: "1" }, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toMatchObject({ model: null, source: "disabled" });
  });

  it("router's own subagent type is skipped", async () => {
    const fetchImpl = vi.fn();
    const r = await route(
      { prompt: "x", subagentType: "claude-model-router:model-router" },
      { config: cfg, env, fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toMatchObject({ model: null, source: "skipped" });
  });
});

describe("state building / truncation", () => {
  it("includes signals", () => {
    const s = buildState("Please debug and refactor src/a.ts and lib/b.py, then plan the design", "general-purpose", cfg);
    expect(s).toContain("keyword_signals: plan, design, debug, refactor");
    expect(s).toContain("file_paths_mentioned: 2");
    expect(s).toMatch(/prompt_length_chars: \d+/);
  });

  it("extractSignals counts distinct paths", () => {
    expect(extractSignals("see src/a.ts and src/a.ts and README.md").filePaths).toBe(2);
  });

  it("signal extraction is fast on pathological input", () => {
    for (const s of ["x".repeat(200_000), "a/".repeat(100_000), "a.".repeat(100_000)]) {
      const t = performance.now();
      extractSignals(s);
      expect(performance.now() - t).toBeLessThan(250);
    }
  });

  it("huge prompt stays under state budget and keeps head + tail", () => {
    const prompt = "HEAD-MARKER " + "lorem ipsum dolor sit amet ".repeat(5000) + " TAIL-MARKER";
    const s = buildState(prompt, "general-purpose", cfg);
    expect(estimateTokens(s)).toBeLessThanOrEqual(cfg.stateMaxTokens);
    expect(s).toContain("HEAD-MARKER");
    expect(s).toContain("TAIL-MARKER");
    expect(s).toContain("[... middle omitted ...]");
  });

  it("whole request (state + instructions + criteria) fits num_ctx with headroom", () => {
    const prompt = "x".repeat(100_000);
    const req = buildRequest(buildState(prompt, "general-purpose", cfg), cfg);
    // chars/4 estimate of everything we send, plus ~150 tokens reserved for tev1's own system prompt
    expect(estimateTokens(JSON.stringify(req)) + 150).toBeLessThan(cfg.numCtx);
  });

  it("short prompt is not truncated", () => {
    const s = buildState("rename foo to bar", undefined, cfg);
    expect(s).toContain("rename foo to bar");
    expect(s).not.toContain("omitted");
  });
});

describe("cache", () => {
  it("second identical call within TTL is served from cache", async () => {
    const fetchImpl = vi.fn(async () => tev1Response("opus", { haiku: 0.1, sonnet: 0.2, opus: 0.7 }));
    let t = 1_000_000;
    const now = () => t;
    const a = await route({ prompt: "hard thing", subagentType: "general-purpose" }, { config: cfg, env, fetchImpl, now });
    t += 60_000;
    const b = await route({ prompt: "hard thing", subagentType: "general-purpose" }, { config: cfg, env, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(a.source).toBe("tev1");
    expect(b).toMatchObject({ model: "opus", source: "cache" });
  });

  it("expires after TTL", async () => {
    const fetchImpl = vi.fn(async () => tev1Response("opus", { haiku: 0.1, sonnet: 0.2, opus: 0.7 }));
    let t = 1_000_000;
    const now = () => t;
    await route({ prompt: "p" }, { config: cfg, env, fetchImpl, now });
    t += cfg.cacheTtlMs + 1;
    const b = await route({ prompt: "p" }, { config: cfg, env, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(b.source).toBe("tev1");
  });

  it("different subagent_type is a different cache key", async () => {
    const fetchImpl = vi.fn(async () => tev1Response("haiku", { haiku: 0.9, sonnet: 0.1 }));
    await route({ prompt: "p", subagentType: "A" }, { config: cfg, env, fetchImpl });
    await route({ prompt: "p", subagentType: "B" }, { config: cfg, env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("decision log", () => {
  it("appends a JSONL line with required fields and no raw prompt", async () => {
    const secret = "SUPER-SECRET-PROMPT-TEXT refactor the auth module";
    const fetchImpl = vi.fn(async () => tev1Response("sonnet", { haiku: 0.1, sonnet: 0.7, opus: 0.2 }, 0.3));
    await route({ prompt: secret, subagentType: "general-purpose", caller: "hook" }, { config: cfg, env, fetchImpl });
    await route({ prompt: secret, explicitModel: "opus" }, { config: cfg, env, fetchImpl });
    const raw = readFileSync(join(dir, "decisions.jsonl"), "utf8");
    expect(raw).not.toContain("SUPER-SECRET");
    const [l1, l2] = logLines();
    for (const k of ["ts", "prompt_sha256", "subagent_type", "probabilities", "confidence", "gap", "choice", "model", "source", "latency_ms"]) {
      expect(l1).toHaveProperty(k);
    }
    expect(l1).toMatchObject({ subagent_type: "general-purpose", choice: "sonnet", model: "sonnet", source: "tev1", confidence: 0.3 });
    expect(l1.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(l2.source).toBe("explicit");
  });
});
