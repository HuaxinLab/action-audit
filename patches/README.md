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

## Current strategy

### dist rule: `2026.3.24`

- Patch `dispatchReplyFromConfig` only (single point), no channel plugin edits.
- Inject `runMessageSendingForPayload` + `sendWithMessageSending`.
- Build `wrappedDispatcher` and route send calls through it.
- Replace both ACP dispatch callsites to use `dispatcher: wrappedDispatcher`.
- Pass `sessionKey` from `ctx.SessionKey` as the primary isolation key (with channel/account/conversation context).
- Hook failures degrade to direct send (no message drop).

### source rule: `2026.3.22`

- Same behavior as dist strategy above.
- Includes `src/plugins/types.ts` extension (`PluginHookMessageContext.sessionKey?: string`).

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
./patches/reapply-openclaw-message-sending-bridge-dist.sh /path/to/openclaw-root 2026.3.24
```

## Verify

1. Restart gateway.
2. Send a normal chat message in target channels.
3. Confirm hooks that depend on `message_sending` are triggered in direct reply paths.
4. Cross-channel check: one channel triggers tool call, another channel sends plain text; no stale audit block should appear.

## Rollback

Scripts save backups under:

- `.action-audit-backups/message-sending-bridge-<timestamp>/`
- `.action-audit-backups/message-sending-bridge-dist-<timestamp>/`

To rollback, copy backed-up files over the patched files and restart gateway.
