#!/usr/bin/env bash
set -euo pipefail

# Re-apply source-level bridge patch after OpenClaw core upgrade.
# Strict versioned mode (no generic fallback).
# Usage:
#   ./patches/reapply-openclaw-message-sending-bridge.sh /path/to/openclaw-root [version]

ROOT_DIR="${1:-}"
OVERRIDE_VERSION="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RULES_DIR="$SCRIPT_DIR/source-rules"
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
cd "$ROOT_DIR"

if [[ ! -d ".git" ]]; then
  echo "Target is not a git working tree: $ROOT_DIR" >&2
  echo "Tip: point this script to an OpenClaw source checkout (contains src/ and .git)." >&2
  exit 1
fi

if [[ ! -d "src" && -d "dist" ]]; then
  echo "Detected dist-only installation (no src/)." >&2
  echo "Use: ./patches/reapply-openclaw-message-sending-bridge-dist.sh" >&2
  exit 1
fi

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

PATCH_FILE="$RULES_DIR/$VERSION.patch"
if [[ ! -f "$PATCH_FILE" ]]; then
  echo "No source rule for version: $VERSION" >&2
  echo "Expected: $PATCH_FILE" >&2
  echo "This script runs in strict mode and will not fallback to a generic patch." >&2
  exit 1
fi

mapfile -t TARGET_FILES < <(awk '/^\+\+\+ b\// {print substr($0, 7)}' "$PATCH_FILE")
if [[ ${#TARGET_FILES[@]} -eq 0 ]]; then
  echo "No target files parsed from patch: $PATCH_FILE" >&2
  exit 1
fi

BACKUP_DIR="$ROOT_DIR/.action-audit-backups/message-sending-bridge-$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

echo "Applying source rule: $VERSION"
echo "Creating backup under: $BACKUP_DIR"
for rel in "${TARGET_FILES[@]}"; do
  if [[ ! -f "$ROOT_DIR/$rel" ]]; then
    echo "Target file missing: $rel" >&2
    echo "Patch may not match this OpenClaw version." >&2
    exit 1
  fi
  mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
  cp "$ROOT_DIR/$rel" "$BACKUP_DIR/$rel"
done

echo "Checking patch dry-run..."
if git apply --check "$PATCH_FILE"; then
  echo "Applying patch..."
  git apply "$PATCH_FILE"
  echo "Patch applied successfully."
  echo "Backup saved at: $BACKUP_DIR"
else
  echo "Patch cannot be applied cleanly for version $VERSION." >&2
  echo "Please update source-rules/$VERSION.patch." >&2
  exit 2
fi
