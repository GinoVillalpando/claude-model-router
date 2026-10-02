// Copies the version from package.json (single source of truth) into .claude-plugin/plugin.json.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const pluginPath = new URL("../.claude-plugin/plugin.json", import.meta.url);
const plugin = readFileSync(pluginPath, "utf8");

const updated = plugin.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${pkg.version}"`);
if (updated !== plugin) writeFileSync(pluginPath, updated);
console.log(`plugin.json version = ${pkg.version}`);
