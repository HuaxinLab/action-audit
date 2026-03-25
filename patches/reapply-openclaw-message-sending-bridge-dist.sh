#!/usr/bin/env bash
set -euo pipefail

# Apply dist-level bridge patch for dist-only OpenClaw installs.
# Usage:
#   ./patches/reapply-openclaw-message-sending-bridge-dist.sh /path/to/openclaw-root [version]

ROOT_DIR="${1:-}"
OVERRIDE_VERSION="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RULES_DIR="$SCRIPT_DIR/dist-rules"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

if [[ -z "$ROOT_DIR" ]]; then
  echo "Usage: $0 /path/to/openclaw-root [version]" >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "Target path does not exist: $ROOT_DIR" >&2
  exit 1
fi

ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"

if [[ -n "$OVERRIDE_VERSION" ]]; then
  VERSION="$OVERRIDE_VERSION"
else
  if [[ ! -f "$ROOT_DIR/package.json" ]]; then
    echo "Cannot detect version: missing package.json under $ROOT_DIR" >&2
    exit 1
  fi
  VERSION="$(node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(String(j.version||""));' "$ROOT_DIR/package.json")"
fi

if [[ -z "$VERSION" ]]; then
  echo "Failed to detect OpenClaw version." >&2
  exit 1
fi

RULE_FILE="$RULES_DIR/$VERSION.json"
if [[ ! -f "$RULE_FILE" ]]; then
  echo "No dist rule for version: $VERSION" >&2
  echo "Expected: $RULE_FILE" >&2
  exit 1
fi

DIST_REL="$(node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(r.distFile);' "$RULE_FILE")"
EXPECTED_SHA="$(node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.sha256||""));' "$RULE_FILE")"
TARGET_FILE="$ROOT_DIR/$DIST_REL"

if [[ ! -f "$TARGET_FILE" ]]; then
  echo "Target dist file missing: $TARGET_FILE" >&2
  exit 1
fi

ACTUAL_SHA="$(shasum -a 256 "$TARGET_FILE" | awk '{print $1}')"
if [[ -n "$EXPECTED_SHA" && "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  echo "Checksum mismatch for $TARGET_FILE" >&2
  echo "Expected: $EXPECTED_SHA" >&2
  echo "Actual:   $ACTUAL_SHA" >&2
  echo "Refusing to patch unknown file content." >&2
  exit 1
fi

BACKUP_DIR="$ROOT_DIR/.action-audit-backups/message-sending-bridge-dist-$TIMESTAMP"
mkdir -p "$BACKUP_DIR/$(dirname "$DIST_REL")"
cp "$TARGET_FILE" "$BACKUP_DIR/$DIST_REL"

echo "Applying dist rule: $VERSION"
echo "Backup saved at: $BACKUP_DIR/$DIST_REL"

node - "$TARGET_FILE" "$RULE_FILE" <<'NODE'
const fs = require("fs");
const [targetFile, ruleFile] = process.argv.slice(2);
const rule = JSON.parse(fs.readFileSync(ruleFile, "utf8"));
let content = fs.readFileSync(targetFile, "utf8");

for (const item of rule.replacements || []) {
  const match = item.match ?? "";
  const replace = item.replace ?? "";
  const count = content.split(match).length - 1;
  if (count === 1) {
    content = content.replace(match, replace);
    continue;
  }
  const already = content.includes(replace);
  if (count === 0 && already) {
    continue;
  }
  throw new Error(
    `Replacement failed (${item.name || "unnamed"}): expected exactly one match, got ${count}`,
  );
}

fs.writeFileSync(targetFile, content);
NODE

echo "Dist patch applied successfully."
echo "Please restart gateway to take effect."
