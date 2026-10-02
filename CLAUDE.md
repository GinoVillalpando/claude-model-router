# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Claude Code plugin (not standalone app). Routes delegated `Agent` tool calls to cheapest capable Claude model (`haiku` < `sonnet` < `opus` < `fable`) using local Ollama decision model, `tev1` (`http://localhost:11434`, `/v1/systemone`). See `README.md` for user docs, config keys, decision-rules table.

## Commands

- `npm run build`: runs `scripts/sync-version.js` then `tsc`. Plugin runs from `dist/`, not `src/`.
- `npm test`: runs `vitest run`; `pretest` builds first. tev1 mocked, so Ollama not needed.
- Single test: `npx vitest run test/router.test.ts -t "name"` (run `npm run build` first if `dist/` stale).
- `npm run route -- "task text" [subagent_type]`: runs `dist/cli.js` to see routing decision from shell.
- `claude --plugin-dir .` loads plugin for one session; `claude plugin validate .` checks manifest.

## Architecture

All four entry points share `src/router.ts` (config loading, tev1 call, decision rules, cache, logging):

- `src/hook.ts`: PreToolUse hook (`hooks/hooks.json`). Fills `updatedInput.model` when `Agent` call omits it. Must never block call: any failure exits 0 with no output, watchdog timer bounds runtime. Skips calls whose subagent definition (`.md` frontmatter in `.claude/agents`, `~/.claude/agents`, or plugin cache) already sets `model:`, and skips types in `skipSubagentTypes` (router agent).
- `src/mcp-server.ts`: `route_task` MCP tool (`.mcp.json`).
- `src/cli.ts`: shell wrapper around `route`.
- `skills/route-task/SKILL.md` and `agents/model-router.md`: prompt-only components steering Claude to call `route_task`. Agent runs on `haiku`, must never do task itself.

Behavior worth knowing before editing `router.ts`:
- tev1 rejects input over 2050-token context. Router estimates tokens as chars/4, keeps head and tail of long prompts (budget keys in `config/models.json`). Retries once on context overflow.
- Low certainty (top-1 minus top-2 probability below `minGap`) picks higher tier of top two. Errors and timeouts fall back to `defaultModel`. `confidence` logged but deliberately never used as threshold.
- Decisions log to `~/.claude-model-router/decisions.jsonl` (prompt hash only, never raw text), with 10-minute cache in `cache.json`. `ROUTER_DATA_DIR`, `ROUTER_CONFIG`, `ROUTER_DISABLE=1` override behavior.
- Config is `config/models.json`; omitted keys keep built-in defaults.

## Repo conventions

- **`dist/` is committed.** Marketplace installs run MCP server and hook straight from it, so rebuild and commit `dist/` with any `src/` change.
- **Versioning is automatic.** `package.json` is source of truth; `scripts/sync-version.js` copies it to `.claude-plugin/plugin.json`. `bump-version` GitHub workflow bumps patch version on every push to `main`, commits with `[skip ci]`, so don't bump by hand.
- ESM TypeScript, Node >= 22.