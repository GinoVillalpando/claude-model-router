// Runs the built hook (dist/hook.js; `npm test` builds first) as a subprocess, like Claude Code does.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = resolve(__dirname, "..", "dist", "hook.js");
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  // Point tev1 at a closed port so the router takes the error fallback deterministically.
  const cfg = { ollama: { url: "http://127.0.0.1:9/v1/systemone", model: "tev1", timeoutMs: 500 } };
  writeFileSync(join(dir, "cfg.json"), JSON.stringify(cfg));
  env = { ...process.env, ROUTER_DATA_DIR: dir, ROUTER_CONFIG: join(dir, "cfg.json") };
  delete env.ROUTER_DISABLE;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(stdin: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [HOOK], { input: stdin, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 10_000 });
}

const agentCall = (tool_input: Record<string, unknown>) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input });

describe("hook", () => {
  it("fills model via updatedInput when unset (fallback sonnet when tev1 unreachable)", () => {
    const r = run(agentCall({ description: "d", prompt: "do a thing", subagent_type: "general-purpose" }));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.updatedInput).toEqual({
      description: "d",
      prompt: "do a thing",
      subagent_type: "general-purpose",
      model: "sonnet",
    });
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it("does nothing when model is already set", () => {
    const r = run(agentCall({ prompt: "x", model: "opus" }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("does nothing when ROUTER_DISABLE=1", () => {
    const r = run(agentCall({ prompt: "x" }), { ROUTER_DISABLE: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("ignores other tools", () => {
    const r = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("garbage input -> exit 0, no output", () => {
    const r = run("not json{{");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("null config file -> still routes with defaults (exit 0)", () => {
    writeFileSync(join(dir, "cfg.json"), "null");
    const r = run(agentCall({ prompt: "x" }), { ROUTER_HOOK_WATCHDOG_MS: "8000" });
    expect(r.status).toBe(0);
  });

  describe("agent definition model", () => {
    const defineAgent = (root: string, name: string, fm: string) => {
      mkdirSync(join(root, ".claude", "agents"), { recursive: true });
      writeFileSync(join(root, ".claude", "agents", `${name}.md`), `---\nname: ${name}\n${fm}\n---\nbody\n`);
    };
    const withCwd = (cwd: string, tool_input: Record<string, unknown>) =>
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", cwd, tool_input });

    it("skips routing when project agent definition sets model", () => {
      defineAgent(dir, "pinned", "model: opus");
      const r = run(withCwd(dir, { prompt: "x", subagent_type: "pinned" }), { HOME: join(dir, "home") });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    });

    it("skips routing when user-level agent definition sets model", () => {
      const home = join(dir, "home");
      defineAgent(home, "pinned", 'model: "haiku"');
      const r = run(withCwd(dir, { prompt: "x", subagent_type: "pinned" }), { HOME: home });
      expect(r.stdout).toBe("");
    });

    it("routes when definition has no model or model: inherit", () => {
      defineAgent(dir, "nomodel", "tools: Read");
      defineAgent(dir, "inh", "model: inherit");
      for (const t of ["nomodel", "inh", "missing"]) {
        const r = run(withCwd(dir, { prompt: "x", subagent_type: t }), { HOME: join(dir, "home") });
        expect(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.model).toBe("sonnet");
      }
    });
  });
});
