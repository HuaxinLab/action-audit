# Patches

This directory stores cross-version maintenance assets for OpenClaw core behavior.

## Files

- `source-rules/<version>.patch`
  - Source-level patch set, strict per-version (for example `source-rules/2026.3.22.patch`).
- `reapply-openclaw-message-sending-bridge.sh`
  - Source patch script (strict version mode, no generic fallback).
- `reapply-openclaw-message-sending-bridge-dist.sh`
  - Dist-only patch script for installed OpenClaw runtime (no source tree).
- `dist-rules/<version>.json`
  - Version-locked replacement rules (with checksum guard).

## Why this exists

Many channel chat reply paths use direct dispatch and do not pass through the shared outbound bus. In those paths, `message_sending` is not triggered by default.

This patch is maintained alongside `action-audit` so behavior can stay consistent after upgrades.

## Current dist strategy (2026.3.13)

- Patch `dispatchReplyFromConfig` only (single point), no channel plugin edits.
- Wrap dispatcher sends (`sendToolResult`/`sendBlockReply`/`sendFinalReply`) with a pre-send `runMessageSending`.
- Pass `sessionKey` from `ctx.SessionKey` as the primary isolation key.
- Also pass `channelId`/`accountId`/`conversationId` in the message hook context when available.
- Hook failures degrade to direct send (no message drop).

## Apply

```bash
./patches/reapply-openclaw-message-sending-bridge.sh /path/to/openclaw-root
./patches/reapply-openclaw-message-sending-bridge.sh /path/to/openclaw-root 2026.3.22
```

Requirements:

- Target path should be an OpenClaw source checkout (`.git` + `src/`).
- Dist-only installs (`dist/` without `src/`) are intentionally rejected to avoid unsafe blind patching.
- Source patch runs in strict mode: if `source-rules/<version>.patch` is missing, script exits directly.

For dist-only runtime installs:

```bash
./patches/reapply-openclaw-message-sending-bridge-dist.sh /path/to/openclaw-root
```

Optional:

```bash
./patches/reapply-openclaw-message-sending-bridge-dist.sh /path/to/openclaw-root 2026.3.13
```

## Verify

1. Restart gateway.
2. Send a normal chat message in target channels.
3. Confirm hooks that depend on `message_sending` are now triggered in direct reply paths.

## Rollback

Scripts save backups under:

- `.action-audit-backups/message-sending-bridge-<timestamp>/`
- `.action-audit-backups/message-sending-bridge-dist-<timestamp>/`

To rollback, copy backed-up files over the patched files and restart gateway.
