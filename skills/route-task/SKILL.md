---
name: route-task
description: Before delegating any task to a subagent with the Agent tool, call route_task to pick the cheapest capable model (haiku, sonnet, opus, fable) and pass it as the Agent tool's model parameter.
---
# Route delegated tasks to the cheapest capable model

Before calling Agent tool without told model:

1. Write full subagent prompt first.
2. Call `route_task` tool (from `model-router` MCP server) with:
   - `task`: exact prompt sent to subagent
   - `subagent_type`: planned subagent type (optional)
3. Call Agent tool with `model` set to returned `model`. If `model` is `null`, omit `model`.

Rules:
- If user or agent definition explicitly chose model, use it, skip routing.
- Do not rewrite or shorten prompt after routing; decision is for that prompt.
- `source` in result informational: `tev1` (router chose), `fallback` (router unsure or unavailable; safe default used), `cache` (recent identical prompt).
- Plugin's PreToolUse hook also fills `model` automatically when omitted, so `route_task` mainly useful to see decision before delegating.