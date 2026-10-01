# claude-model-router

A Claude Code plugin that sends each **delegated subagent task** to the cheapest Claude model that
can handle it. The main session's model never changes. The choice is made by a local Ollama
decision model, `tev1`.

Candidates, from cheapest to most capable: `haiku` (1) < `sonnet` (2) < `opus` (3) < `fable` (4).

## How it works

- **PreToolUse hook** (`hooks/hooks.json` -> `dist/hook.js`): when Claude calls the `Agent` tool
  without a `model`, the hook asks tev1 for a model and returns it as
  `hookSpecificOutput.updatedInput.model`. If the call already sets a model, the hook does
  nothing. Any failure exits 0 with no output, so the Agent call always goes ahead.
- **MCP tool** `route_task(task, subagent_type?)` (`.mcp.json` -> `dist/mcp-server.js`) returns
  `{model, probabilities, confidence, gap, source}`.
- **Skill** `route-task`: tells Claude to call `route_task` before delegating and pass the result on.
- **Agent** `model-router` (runs on haiku): calls `route_task`, then delegates with the returned
  model. The hook skips this agent so it always stays cheap.

Decision rules:

| Situation | Result | `source` |
|---|---|---|
| tev1 answers, top-1 minus top-2 probability >= `minGap` (0.15) | tev1's choice | `tev1` |
| top-1 minus top-2 < `minGap` | the higher-tier model of the top two | `fallback` |
| tev1 returns an error, a non-200, a malformed body, or takes longer than `timeoutMs` (3000) | `defaultModel` (sonnet) | `fallback` |
| Same subagent_type and prompt within 10 min | the cached decision | `cache` |
| Agent call already sets `model` | no change | `explicit` |
| `ROUTER_DISABLE=1` | no change | `disabled` |

`confidence` is logged but never used as a threshold, because its scale is uncalibrated.

## Requirements

- Node >= 22 (developed on Node 24)
- Ollama serving `tev1` at `http://localhost:11434` (endpoint `/v1/systemone`)

## Install / try

```bash
cd /home/gino/git-projects/claude-model-router
npm install
npm run build        # creates dist/ (the plugin runs from dist/)
npm test             # builds, then runs vitest with tev1 mocked
claude plugin validate .
```

Try it for one session without installing:

```bash
claude --plugin-dir /home/gino/git-projects/claude-model-router
```

Install it persistently from the local directory. `claude plugin install` needs a marketplace,
so create a one-plugin local marketplace next to the repo (the plugin loads in place):

```bash
claude plugin marketplace add GinoVillalpando/tev1-decision-plugins
claude plugin install claude-model-router@tev1-decision-plugins
```

The `route_task` MCP tool needs permission like any other MCP tool. Interactive sessions ask
for it. In headless runs (`claude -p`), allow it explicitly:
`--allowedTools "mcp__plugin_claude-model-router_model-router__route_task"`. The hook needs no
permission.

Try the router logic from the shell:

```bash
node dist/cli.js "Find where parseConfig is defined" Explore
```

## Configuration

Edit `config/models.json`, or point `ROUTER_CONFIG` at another file. Keys you leave out keep
their built-in defaults.

- `ollama.url`, `ollama.model`, `ollama.timeoutMs`
- `instructions`: the question sent to tev1
- `candidates[]`: `alias`, full `id`, `tier`, and `criteria` (a one-line description tev1 uses
  to pick; edit it to tune routing)
- `defaultModel`: used when tev1 is unavailable
- `minGap`: the low-certainty threshold
- `cacheTtlMs`
- `numCtx`, `promptExcerptTokens`, `stateMaxTokens`: the prompt budget. tev1's context is 2050
  tokens and it rejects longer input rather than truncating it. The router estimates tokens as
  chars/4 and keeps the head and tail of long prompts. If tev1 still rejects the input as too
  long, the router retries once with half the budget.
- `skipSubagentTypes`: subagent types the hook never routes (by default, the router agent itself)

Environment variables:

- `ROUTER_DISABLE=1`: turn routing off (the hook and the tool do nothing)
- `ROUTER_DATA_DIR`: where the log and cache are kept (default `~/.claude-model-router`)
- `ROUTER_CONFIG`: alternative config file

## Disable

- Temporarily: `ROUTER_DISABLE=1 claude ...`
- Persistently: `claude plugin disable claude-model-router@local-plugins` (or `/plugin` in a session)

## Logs

Every decision is appended to `~/.claude-model-router/decisions.jsonl`. Each line holds `ts`,
`caller`, `prompt_sha256`, `subagent_type`, `probabilities`, `confidence`, `gap`, `choice` (tev1's
raw pick), `model` (the final model), `source`, `reason` (fallbacks only) and `latency_ms`. Raw
prompt text is never logged. The cache is kept in `~/.claude-model-router/cache.json`.

## Operational note: tev1 cold start

Ollama unloads idle models (by default after 5 minutes). Reloading tev1 on CPU takes about 20 s,
which is well past the 3 s timeout, so the first routing call after an idle period falls back to
sonnet. To keep tev1 loaded, set `OLLAMA_KEEP_ALIVE` for the Ollama server (for example `-1` or
`1h`).
