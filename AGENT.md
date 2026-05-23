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

Cron currently defaults to `RUN_L0=1`, so L0 is invoked after each hourly L1 run. L0 must stay selective and return `skip` unless the L1 cards are high-signal; do not run broad historical L0 backfills by default.

## Runtime State

The active local cron entry is:

```cron
0 * * * * /Users/lululiang/chat_cloud/chatview/daemon/scripts/cron_follow_three_groups.sh
```

This user-level crontab survives machine reboot. Editing the shell or Python scripts changes the next run without restarting cron. Only schedule changes require updating crontab.

The active local daemon output directory is:

```text
/Users/lululiang/chat_cloud/chatview/daemon/exports/follow_three_groups_jsonl
```

Important files in that directory:

- `new_messages.jsonl`: raw target-group messages collected from `chatlog`.
- `api_messages.jsonl`: cleaned/kept messages assembled for `POST /api/messages`.
- `api_messages.json`: snapshot of the local kept message set.
- `codex_decisions.jsonl`: L2 keep/delete/priority decisions.
- `rejected_messages.jsonl`: messages deleted by preprocessing or L2 filtering.
- `submitted_messages.jsonl`: cloud POST results.
- `l1_states.jsonl`: L1 channel-state payloads/results.
- `l0_reports.jsonl`: L0 report payloads/results.
- `pipeline_errors.jsonl`: recoverable pipeline errors.
- `codex_outputs/`: raw Codex outputs for L2/L1/L0.
- `state.json` and `pipeline_state.json`: collection and pipeline dedupe state.
- `cloud.env`: local secret config. It must stay ignored and uncommitted.

Rotation currently applies only to `cron.log`: default 10 MB per file and 10 retained files. Message JSONL files and `codex_outputs/` are append-only because they are used for audit, replay, and backfill. Add an explicit retention/compaction pass before scaling this to high-volume history.

Cloud storage is Postgres when `DATABASE_URL` is set. Messages, L1 states, L0 reports, and uploaded image bytes are stored there. Without Postgres, `server.js` falls back to process memory plus local `UPLOAD_DIR`/`/tmp` image files, which is only suitable for local development.

PM2 is not currently used for this daemon. Cron is preferred because the worker is an hourly one-shot batch job. Only switch to PM2 if the daemon becomes a long-running listener or needs PM2 dashboard/process management.

## GitHub Visibility

The GitHub repo is public. Before it was opened, history was force-pushed to replace the early real API key value in `.env.example` and README examples with `replace_me`. Continue to verify both the current tree and git history for secrets before adding public-facing examples or changing deployment docs.

## Lessons Learned

- Keep collection CLI-only. The user explicitly wants `chatlog` access through `chatlog http call`, not direct local HTTP from daemon code.
- Validate `chatlog` output before writing state. The CLI can print connection errors while still leaving shell-level behavior ambiguous.
- Preprocess before cloud calls. Animated stickers, placeholder GIF messages, animated GIF/APNG/WebP, and unsupported image payloads should be dropped before upload.
- Use `external_id` for idempotency. Message writes are upserts, so replay and backfill are safe.
- Batch L2 filtering for history. Single-message Codex calls are acceptable for hourly runs, but historical backfill needs `DECISION_BATCH_SIZE`.
- L1 is cheap enough for hourly history; L0 is not. Backfill messages first, then L1-only, then generate L0 only for high-signal cards.
- Keep local logs bounded. The cron wrapper rotates `cron.log` on every run.
- Keep image upload before message upload. Local chatlog image markdown must be resolved through `chatlog http call`, uploaded to `/api/images`, and rewritten to cloud URLs before `POST /api/messages`.
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
