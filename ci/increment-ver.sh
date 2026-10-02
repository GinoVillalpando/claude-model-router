#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_JSON="$REPO_ROOT/package.json"
PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"

if [[ ! -f "$PLUGIN_JSON" ]]; then
  echo "Error: $PLUGIN_JSON not found"
  exit 1
fi

current_version="$(node -p "require('$PLUGIN_JSON').version")"

if [[ ! "$current_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "Error: version '$current_version' is not valid semantic versioning (major.minor.patch)" >&2
  exit 1
fi

major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"
new_patch=$((patch + 1))
new_version="${major}.${minor}.${new_patch}"

node -e "
  const fs = require('fs');
  const pluginPath = '$PLUGIN_JSON';
  const packagePath = '$PACKAGE_JSON';
  const data = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
  data.version = '$new_version';
  fs.writeFileSync(pluginPath, JSON.stringify(data, null, 2) + '\n');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.version = '$new_version';
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
"

echo "Bumped version: $current_version -> $new_version"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "build=$new_version" >>"$GITHUB_OUTPUT"
fi
