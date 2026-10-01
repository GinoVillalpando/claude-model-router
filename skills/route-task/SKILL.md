---
name: route-task
description: Before delegating any task to a subagent with the Agent tool, call route_task to pick the cheapest capable model (haiku, sonnet, opus, fable) and pass it as the Agent tool's model parameter.
---

# Route delegated tasks to the cheapest capable model

Whenever you are about to call the Agent tool and you have not been told which model to use:

1. Write the full subagent prompt first.
2. Call the `route_task` tool (from the `model-router` MCP server) with:
   - `task`: the exact prompt you will send to the subagent
   - `subagent_type`: the subagent type you plan to use (optional)
3. Call the Agent tool with `model` set to the returned `model`. If `model` is `null`, omit `model`.

Rules:
- If the user or an agent definition explicitly chose a model, use that and skip routing.
- Do not rewrite or shorten the prompt after routing; the decision is for that prompt.
- `source` in the result is informational: `tev1` (router chose), `fallback` (router unsure or
  unavailable; a safe default was used), `cache` (recent identical prompt).
- The plugin's PreToolUse hook also fills in `model` automatically when you omit it, so calling
  `route_task` is mainly useful when you want to see the decision before delegating.
