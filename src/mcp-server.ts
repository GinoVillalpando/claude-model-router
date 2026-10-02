// MCP server exposing route_task(task, subagent_type?) backed by the local tev1 model.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { route } from "./router.js";

// package.json sits one level above both src/ and dist/, so this resolves from either.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const server = new McpServer({ name: "claude-model-router", version });

server.registerTool(
  "route_task",
  {
    title: "Route task to cheapest capable model",
    description:
      "Given the full prompt you are about to delegate to a subagent, returns the cheapest capable Claude model alias " +
      "(haiku|sonnet|opus|fable) to pass as the Agent tool's `model` parameter. If `model` is null, omit `model`.",
    inputSchema: {
      task: z.string().describe("The exact prompt that will be sent to the subagent"),
      subagent_type: z.string().optional().describe("The subagent_type you plan to use"),
    },
  },
  async ({ task, subagent_type }) => {
    const r = await route({ prompt: task, subagentType: subagent_type, caller: "mcp" });
    const out = {
      model: r.model,
      probabilities: r.probabilities,
      confidence: r.confidence,
      gap: r.gap,
      source: r.source,
    };
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  },
);

await server.connect(new StdioServerTransport());
