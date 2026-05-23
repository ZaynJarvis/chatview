# AGENT.md

Operational notes for agents working on ChatView.

## System Shape

ChatView has two halves in one repo:

- `server.js` and `public/`: cloud API and frontend.
- `daemon/`: local sync worker that reads WeChat through `chatlog` CLI and writes cleaned data to the cloud API.

The API is the contract. Keep local daemon changes compatible with:

- `POST /api/messages`
- `POST /api/images`
- `GET/POST /api/channel-state`
- `GET/POST /api/reports`

## Current AI Stages

| Stage | Purpose | Command | Model | Reasoning |
| --- | --- | --- | --- | --- |
| L2 | Per-message keep/delete and `high/low` priority | `codex exec` | `gpt-5.5` | `low` |
| L1 | Hourly channel topic state as short cards | `codex exec` | `gpt-5.5` | `low` |
| L0 | Selective research report with reference links | `codex --search exec` | `gpt-5.5` | `low` |

Cron currently defaults to `RUN_L0=0`. Do not enable all-hour historical L0 generation by default; it is slow and creates too many reports.

## Lessons Learned

- Keep collection CLI-only. The user explicitly wants `chatlog` access through `chatlog http call`, not direct local HTTP from daemon code.
- Validate `chatlog` output before writing state. The CLI can print connection errors while still leaving shell-level behavior ambiguous.
- Preprocess before cloud calls. Animated stickers, placeholder GIF messages, animated GIF/APNG/WebP, and unsupported image payloads should be dropped before upload.
- Use `external_id` for idempotency. Message writes are upserts, so replay and backfill are safe.
- Batch L2 filtering for history. Single-message Codex calls are acceptable for hourly runs, but historical backfill needs `DECISION_BATCH_SIZE`.
- L1 is cheap enough for hourly history; L0 is not. Backfill messages first, then L1-only, then generate L0 only for high-signal cards.
- Keep local logs bounded. The cron wrapper rotates `cron.log` on every run.
- Treat cloud image storage as ephemeral. The current `/api/images` endpoint stores under `/tmp`; message text and state must still be useful when images disappear.
- Avoid secrets in Git. `daemon/cloud.env.example` is committed; real `cloud.env` lives under ignored `daemon/exports/...`.

## Safe Verification

Run these before pushing daemon changes:

```sh
python3 -m py_compile daemon/scripts/*.py
sh -n daemon/scripts/cron_follow_three_groups.sh
npm run check
git diff --check
```

For a non-writing pipeline sanity check:

```sh
python3 daemon/scripts/process_three_groups_api_pipeline.py \
  --skip-collect \
  --dry-run \
  --decision-mode heuristic \
  --skip-l1 --skip-l0
```

## Backfill Policy

Prefer this order:

1. Backfill cleaned messages with L1/L0 disabled.
2. Backfill L1 only in chronological order.
3. Selectively run L0 for a small set of high-value L1 cards.

If a task seems slow, check for concurrent `codex exec` or cron jobs before assuming the model is stuck.
