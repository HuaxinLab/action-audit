# Patches

This directory stores cross-version maintenance assets for OpenClaw core behavior.

## Files

- `openclaw-message-sending-bridge.patch`
  - Source-level patch for OpenClaw core to bridge `message_sending` into direct channel reply dispatch.
- `reapply-openclaw-message-sending-bridge.sh`
  - Parameterized script to back up targets and re-apply the patch after core upgrades.

## Why this exists

Many channel chat reply paths use direct dispatch and do not pass through the shared outbound bus. In those paths, `message_sending` is not triggered by default.

This patch is maintained alongside `action-audit` so behavior can stay consistent after upgrades.

## Apply

```bash
./patches/reapply-openclaw-message-sending-bridge.sh /path/to/openclaw-root
```

Requirements:

- Target path should be an OpenClaw source checkout (`.git` + `src/`).
- Dist-only installs (`dist/` without `src/`) are intentionally rejected to avoid unsafe blind patching.

## Verify

1. Restart gateway.
2. Send a normal chat message in target channels.
3. Confirm hooks that depend on `message_sending` are now triggered in direct reply paths.

## Rollback

The script saves backups under:

- `.action-audit-backups/message-sending-bridge-<timestamp>/`

To rollback, copy backed-up files over the patched files and restart gateway.
