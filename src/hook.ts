// PreToolUse hook for the Agent tool: fill in `model` via updatedInput when the
// caller did not set one. Must never block the Agent call: on any failure it
// exits 0 with no output.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig, route } from "./router.js";

const config = loadConfig();
// Up to two tev1 attempts (context-overflow retry) plus startup slack.
const WATCHDOG_MS = Number(process.env.ROUTER_HOOK_WATCHDOG_MS) || config.ollama.timeoutMs * 2 + 1500;

/** Best-effort: does the subagent's definition (.md frontmatter) set a concrete `model:`? */
function agentDefinitionSetsModel(subagentType: unknown, cwd: unknown): boolean {
  try {
    if (typeof subagentType !== "string" || !subagentType) {
      return false;
    }

    const [plugin, nameOnly] = subagentType.includes(":") ? subagentType.split(":", 2) : [undefined, subagentType];

    const dirs: string[] = [];

    if (!plugin) {
      if (typeof cwd === "string" && cwd) {
        dirs.push(join(cwd, ".claude", "agents"));
      }

      dirs.push(join(homedir(), ".claude", "agents"));
    } else {
      const cache = join(homedir(), ".claude", "plugins", "cache");

      for (const mkt of readdirSync(cache)) {
        const pdir = join(cache, mkt, plugin);

        try {
          for (const ver of readdirSync(pdir)) {
            dirs.push(join(pdir, ver, "agents"));
          }
        } catch { }
      }
    }
    for (const dir of dirs) {
      let files: string[];

      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }

      for (const f of files) {
        let fm: string;

        try {
          fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, f), "utf8"))?.[1] ?? "";
        } catch {
          continue;
        }

        const get = (k: string) =>
          new RegExp(`^${k}:[ \\t]*(.*?)[ \\t]*\\r?$`, "m").exec(fm)?.[1]?.replace(/^["']|["']$/g, "") ?? "";

        if ((get("name") || basename(f, ".md")) !== nameOnly) continue;

        const model = get("model");

        return model !== "" && model !== "inherit";
      }
    }
  } catch { }
  return false;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];

  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
  }

  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  if (input?.hook_event_name && input.hook_event_name !== "PreToolUse") return;

  if (input?.tool_name !== "Agent" && input?.tool_name !== "Task") return;

  const toolInput = input.tool_input ?? {};

  if (typeof toolInput.prompt !== "string") return;

  if (!toolInput.model && agentDefinitionSetsModel(toolInput.subagent_type, input.cwd)) return;

  const r = await route({
    prompt: toolInput.prompt,
    subagentType: toolInput.subagent_type,
    explicitModel: toolInput.model,
    caller: "hook",
  }, { config });

  if (!r.model) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...toolInput, model: r.model },
      },
    }),
  );
}

const watchdog = setTimeout(() => process.exit(0), WATCHDOG_MS);
main()
  .catch(() => { })
  .finally(() => {
    clearTimeout(watchdog);
    process.exit(0);
  });
