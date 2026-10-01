// Tiny CLI for trying the router: node dist/cli.js "<task prompt>" [subagent_type]
import { route } from "./router.js";
const [prompt, subagentType] = process.argv.slice(2);
if (!prompt) {
    console.error('usage: node dist/cli.js "<task prompt>" [subagent_type]');
    process.exit(1);
}
console.log(JSON.stringify(await route({ prompt, subagentType, caller: "cli" })));
