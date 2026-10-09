# dsh-image-count-guard

[English](README.md) | [简体中文](README.zh-CN.md)

A fallback plugin for DSH visual-model sessions that hit an image-count limit.

## The problem it solves

An upstream gateway may enforce a hard cap on the number of images in a single request (measured on OpenCode Go: **20 images**). The `dsh-llm-pi-ai` adapter, however, budgets images **purely by base64 bytes** (`maxRequestImageBytes`, 20 MiB by default), with no budget for image count, so:

1. images accumulate in the session history until there are 36 of them (11.79 MiB raw / roughly 15.72 MiB as base64);
2. after switching to a visual model (`opencode-go/deepseek-v4.1-flash`), 15.72 MiB < 20 MiB, so the adapter considers the request fine and sends all 36 images inline;
3. the gateway replies `400 INVALID_REQUEST`: `a request may include at most 20 images`;
4. the official `dsh-compaction-image-offload` only recognizes `IMAGE_OFFLOAD_REQUIRED`, not this error code → the step fails;
5. from then on **every step of that session fails** (sending "continue" again makes no difference) and the session is completely stuck.

## What it does

It hooks into the `agent/request-error` waterfall:

- when the failure text matches an image-count limit (`at most N images` / `maximum of N images` / `no more than N images` / `up to N images` / `too many images`, and the word "image" must appear);
- it counts the total number of image occurrences on the current surface that are **not yet omitted**, `total`;
- it records an `image/offload` decision, picking the oldest `max(1, total - (limit - safetyMargin))` occurrences in model request order;
- it returns `{ kind: 'retry' }`, and the step is retried (without spending the provider retry budget).

It reuses the same official `image/offload` projection, so placeholder text, replay, token accounting, and KV cache semantics all match official offloading. Every retry omits at least one occurrence, so **recovery always terminates**: either the request fits, or there is nothing left to omit and the original failure stays terminal (no infinite retries).

## Relationship to the official image-offload

| Case | Handled by |
|---|---|
| The adapter rejects on its own byte budget (`IMAGE_OFFLOAD_REQUIRED`) | Official `dsh-compaction-image-offload` |
| The upstream gateway rejects on **image count** (`INVALID_REQUEST`, etc.) | This plugin |

Both write the same kind of `image/offload` event, so they do not conflict. This plugin does not depend on the official handler's registration order, only on the `image/offload` projection being registered; if the projection is not registered (the official plugin is disabled), `append` throws, and the plugin catches that and hands the failure back downstream without side effects.

## Installation

```powershell
# run this from the cloned repository directory
pwsh -File .\install.ps1                 # install into the desktop profile (default)
pwsh -File .\install.ps1 -Profile web    # install into the given profile
```

The script edits three places in the profile by hand (`dependencies` / `dsh.profile.bundles` / `pnpm-lock.yaml`) and copies a duplicate of node_modules (**without running pnpm install**, to avoid incidentally upgrading other `^` dependencies); before editing, it backs everything up to `.backup\<timestamp>\` (keeping only the 5 most recent).

All insertion points use structural anchors (`"dependencies": {`, `"bundles": [`, and the `packages:` / `snapshots:` section headers in the lock file), so they do not depend on whether other plugins are present, nor on any machine-specific path. The DSH home directory comes from `$env:DSH_HOME`, falling back to `~\.dsh`.

**You must restart DSH after installing.**

Uninstall:

```powershell
pwsh -File .\install.ps1 -Uninstall
```

## Configuration (optional)

No configuration is needed by default. When you do need it, override by id in the profile's `cordis.patch.yml`:

```yaml
- id: image-count-guard
  config:
    defaultImageLimit: 20      # assumed limit when the error text gives no number
    safetyMargin: 2            # margin kept after offloading, so adding one more image does not fail again
    maxOffloadPerRetry: 80     # maximum number of images omitted per retry
```

## Verification

1. Static: at the end, `install.ps1` prints four checks: deps / bundles / node_modules / lock.
2. Offline unit tests: `node --test test/guard.test.mjs` (11 cases covering matching, selection, the upper bound on convergence rounds, and the no-side-effect boundary).
3. Assembly check (optional): mount the plugin into a temporary profile and run `--dump-config` to confirm the entry is assembled. Measured output contains `# == dsh-image-count-guard` / `- id: image-count-guard`, exit code 0.
4. Live: after restarting, open the stuck session and send "continue". With the plugin active, that session records an `image/offload` event, and the next request succeeds.

## Diagnostics tool

```powershell
# single session: image count, omitted count, raw bytes, base64 estimate, average image size
node tools\session-image-report.mjs `
     "$env:USERPROFILE\.dsh\sessions\<workspace>\session-<id>\session.v4.jsonl.zstd"

# scan recent sessions, sorted by image count
node tools\session-image-report.mjs "$env:USERPROFILE\.dsh\sessions" --limit 20
```

Measured on two kinds of session:

| Session | Images | base64 payload | Average image | Would a byte-only budget stop it? |
|---|---|---|---|---|
| `session-c312057f` | 36 | 15.72 MiB | 335 KiB | No (below the 20 MiB default budget; not a single image gets offloaded) |
| `session-b15b99cb` | 25 | 1.52 MiB | 47 KiB | No (the bytes are too small, so even a tightened budget is hard to align with image count) |

The second row is why this plugin exists: an image count over the limit has nothing to do with the byte budget, and only count-based handling stops it.

## Known limits

- **Offloading cannot be undone**: an omitted image appears as placeholder text from then on (including a read-only path to the attachment), which is inherent to the official `image/offload` semantics. If you need to see the image again, have the model call `read_image` once more.
- The error text must be in English and contain both `image` and a quantity phrase; when a new gateway wording appears, add an entry to `LIMIT_PATTERNS` in `src/index.js`.
- After changing `src/index.js` you must re-run `install.ps1` to sync the node_modules copy, otherwise DSH keeps loading the old code.
