# claude-model-router

A Claude Code plugin that sends each **delegated subagent task** to the cheapest Claude model that
can handle it. Your main session's model never changes. A local Ollama decision model, `tev1`,
picks the model.

Candidates, from cheapest to most capable: `haiku` (1) < `sonnet` (2) < `opus` (3) < `fable` (4).

## Requirements

- Node 22 or later (developed on Node 24)
- Ollama serving `tev1` at `http://localhost:11434` (endpoint `/v1/systemone`)

## Install

### Install from the marketplace

1. Add the marketplace:

   ```bash
   claude plugin marketplace add GinoVillalpando/tev1-decision-plugins
   ```

2. Install the plugin:

   ```bash
   claude plugin install claude-model-router@tev1-decision-plugins
   ```

### Try it for one session

1. Clone the repository and open it:

   ```bash
   git clone git@github.com:GinoVillalpando/claude-model-router.git
   cd claude-model-router
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the plugin. The plugin runs from `dist/`.

   ```bash
   npm run build
   ```

4. Start Claude Code with the plugin loaded:

   ```bash
   claude --plugin-dir .
   ```

To check the plugin manifest, run `claude plugin validate .`. To run the tests with tev1 mocked,
run `npm test`. It builds first.

## Use

Routing works without any action from you. When Claude delegates work with the `Agent` tool and
does not set a model, the router picks one.

To route on purpose, use one of these:

- Ask Claude to delegate through the `model-router` agent. It runs on `haiku`, asks the router for
  a model, and hands the task to a subagent on that model.
- Let the `route-task` skill run. It tells Claude to call `route_task` before delegating.

### Allow the MCP tool

The `route_task` MCP tool needs permission like any other MCP tool. Interactive sessions ask you.
In headless runs (`claude -p`), allow it with a flag:

```bash
claude -p "your prompt" \
  --allowedTools "mcp__plugin_claude-model-router_model-router__route_task"
```

The hook needs no permission.

### Test a routing decision from the shell

Pass a task and an optional subagent type:

```bash
node dist/cli.js "Find where parseConfig is defined" Explore
```

### Turn routing off

- For one run: `ROUTER_DISABLE=1 claude ...`
- Until you turn it back on: `claude plugin disable claude-model-router@tev1-decision-plugins`, or
  run `/plugin` in a session.

### Read the logs

The router appends every decision to `~/.claude-model-router/decisions.jsonl`. Each line holds:

| Field | Meaning |
|---|---|
| `ts` | Timestamp |
| `caller` | What called the router |
| `prompt_sha256` | Hash of the prompt. The router never logs raw prompt text. |
| `subagent_type` | The subagent type |
| `probabilities` | tev1's probability for each model |
| `confidence` | tev1's confidence. Logged only. |
| `gap` | Top-1 minus top-2 probability |
| `choice` | tev1's raw pick |
| `model` | The final model |
| `source` | Why the router chose it (see [Decision rules](#decision-rules)) |
| `reason` | Why it fell back. Fallbacks only. |
| `latency_ms` | Time tev1 took |

The cache lives in `~/.claude-model-router/cache.json`.

## Configure

Edit `config/models.json`, or point `ROUTER_CONFIG` at another file. Keys you leave out keep their
built-in defaults.

| Key | Purpose |
|---|---|
| `ollama.url`, `ollama.model`, `ollama.timeoutMs` | Where and how the router calls tev1 |
| `instructions` | The question sent to tev1 |
| `candidates[]` | `alias`, full `id`, `tier`, and `criteria`. tev1 uses the one-line `criteria` to pick, so edit it to tune routing. |
| `defaultModel` | The model used when tev1 is unavailable (`sonnet`) |
| `minGap` | The low-certainty threshold (`0.15`) |
| `cacheTtlMs` | How long a cached decision lasts |
| `numCtx`, `promptExcerptTokens`, `stateMaxTokens` | The prompt budget (see [Prompt budget](#prompt-budget)) |
| `skipSubagentTypes` | Subagent types the hook never routes. By default, only the router agent. |

Environment variables:

| Variable | Purpose |
|---|---|
| `ROUTER_DISABLE=1` | Turns routing off. The hook and the tool do nothing. |
| `ROUTER_DATA_DIR` | Where the router keeps the log and cache. Default: `~/.claude-model-router`. |
| `ROUTER_CONFIG` | Path to an alternative config file |

## How it works

The plugin has four parts:

- **PreToolUse hook** (`hooks/hooks.json` runs `dist/hook.js`). When Claude calls the `Agent` tool
  without a `model`, the hook asks tev1 for one. It returns the answer as
  `hookSpecificOutput.updatedInput.model`. If the call already sets a model, the hook does
  nothing. Any failure exits 0 with no output, so the Agent call always goes ahead.
- **MCP tool** `route_task(task, subagent_type?)` (`.mcp.json` runs `dist/mcp-server.js`). It
  returns `{model, probabilities, confidence, gap, source}`.
- **Skill** `route-task`. It tells Claude to call `route_task` before delegating and to pass the
  result on.
- **Agent** `model-router` (runs on `haiku`). It calls `route_task`, then delegates with the
  returned model. The hook skips this agent so it always stays cheap.

### Decision rules

| Situation | Result | `source` |
|---|---|---|
| tev1 answers and top-1 minus top-2 probability is at least `minGap` (0.15) | tev1's choice | `tev1` |
| Top-1 minus top-2 is below `minGap` | The higher-tier model of the top two | `fallback` |
| tev1 returns an error, a non-200, or a malformed body, or takes longer than `timeoutMs` (3000) | `defaultModel` (`sonnet`) | `fallback` |
| Same `subagent_type` and prompt within 10 minutes | The cached decision | `cache` |
| The Agent call already sets `model` | No change | `explicit` |
| `ROUTER_DISABLE=1` | No change | `disabled` |

The router logs `confidence` but never uses it as a threshold, because its scale is uncalibrated.

### Prompt budget

tev1's context is 2050 tokens. It rejects longer input instead of truncating it. The router
estimates tokens as characters divided by 4 and keeps the head and tail of long prompts. If tev1
still rejects the input as too long, the router retries once with half the budget.

### tev1 cold start

Ollama unloads idle models, by default after 5 minutes. Reloading tev1 on CPU takes about 20 s.
That is well past the 3 s timeout, so the first routing call after an idle period falls back to
`sonnet`. To keep tev1 loaded, set `OLLAMA_KEEP_ALIVE` on the Ollama server, for example to `-1`
or `1h`.
