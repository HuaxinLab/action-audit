#!/usr/bin/env bash
set -euo pipefail

# Re-apply core bridge patch after OpenClaw core upgrade.
# Usage:
#   ./patches/reapply-openclaw-message-sending-bridge.sh /path/to/openclaw-root

ROOT_DIR="${1:-}"
PATCH_FILE="$(cd "$(dirname "$0")" && pwd)/openclaw-message-sending-bridge.patch"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

if [[ -z "$ROOT_DIR" ]]; then
  echo "Usage: $0 /path/to/openclaw-root" >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "Target path does not exist: $ROOT_DIR" >&2
  exit 1
fi

if [[ ! -f "$PATCH_FILE" ]]; then
  echo "Patch file not found: $PATCH_FILE" >&2
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
  echo "This patch is source-level; apply it to OpenClaw source, then rebuild/deploy." >&2
  exit 1
fi

mapfile -t TARGET_FILES < <(awk '/^\+\+\+ b\// {print substr($0, 7)}' "$PATCH_FILE")
if [[ ${#TARGET_FILES[@]} -eq 0 ]]; then
  echo "No target files parsed from patch: $PATCH_FILE" >&2
  exit 1
fi

BACKUP_DIR="$ROOT_DIR/.action-audit-backups/message-sending-bridge-$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

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
  echo "Patch cannot be applied cleanly."
  echo "Please inspect OpenClaw version drift and update patch context."
  exit 2
fi
