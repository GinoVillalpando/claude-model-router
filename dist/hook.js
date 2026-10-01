// PreToolUse hook for the Agent tool: fill in `model` via updatedInput when the
// caller did not set one. Must never block the Agent call: on any failure it
// exits 0 with no output.
import { loadConfig, route } from "./router.js";
const config = loadConfig();
// Up to two tev1 attempts (context-overflow retry) plus startup slack.
const WATCHDOG_MS = Number(process.env.ROUTER_HOOK_WATCHDOG_MS) || config.ollama.timeoutMs * 2 + 1500;
async function main() {
    const chunks = [];
    for await (const c of process.stdin)
        chunks.push(c);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (input?.hook_event_name && input.hook_event_name !== "PreToolUse")
        return;
    if (input?.tool_name !== "Agent" && input?.tool_name !== "Task")
        return;
    const toolInput = input.tool_input ?? {};
    if (typeof toolInput.prompt !== "string")
        return;
    const r = await route({
        prompt: toolInput.prompt,
        subagentType: toolInput.subagent_type,
        explicitModel: toolInput.model,
        caller: "hook",
    }, { config });
    if (!r.model)
        return;
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: { ...toolInput, model: r.model },
        },
    }));
}
const watchdog = setTimeout(() => process.exit(0), WATCHDOG_MS);
main()
    .catch(() => { })
    .finally(() => {
    clearTimeout(watchdog);
    process.exit(0);
});
