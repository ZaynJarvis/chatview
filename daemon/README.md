# ChatView Daemon

Local hourly daemon for syncing selected WeChat group messages into ChatView.

The daemon uses `chatlog` CLI for collection, Codex for message filtering and state generation, and the ChatView HTTP API for storage.

## Pipeline

1. `follow_three_groups_chatlog_cli.py`
   - Reads the three configured groups through `chatlog http call`.
   - Appends new raw rows into `exports/follow_three_groups_jsonl/new_messages.jsonl`.
   - Maintains local dedupe state in `exports/follow_three_groups_jsonl/state.json`.

2. `process_three_groups_api_pipeline.py`
   - Drops animated stickers and animated image payloads before API calls.
   - Uses Codex to decide per message: `keep/delete` and `high/low`.
   - Uploads supported images to `/api/images` and rewrites local chatlog image markdown to cloud URLs.
   - Upserts kept messages to `/api/messages`.
   - Optionally builds L1 state and L0 reports.

3. `backfill_intelligence_windows.py`
   - Replays already-kept local messages by hour.
   - Builds historical L1 states in chronological order without re-running message filtering.
   - L0 is intentionally optional and should be limited to high-signal topics.

## Setup

```sh
cd daemon
mkdir -p exports/follow_three_groups_jsonl
cp cloud.env.example exports/follow_three_groups_jsonl/cloud.env
chmod 600 exports/follow_three_groups_jsonl/cloud.env
```

Edit `exports/follow_three_groups_jsonl/cloud.env` and set `CLOUD_API_KEY`.

The local `chatlog` service must be available:

```sh
chatlog http call --endpoint health --show-status=false
```

Install cron:

```cron
0 * * * * /path/to/chatview/daemon/scripts/cron_follow_three_groups.sh
```

The cron wrapper rotates `exports/follow_three_groups_jsonl/cron.log` before every run. Defaults: 10 MB per file and 10 retained files.

## Models

All daemon Codex stages currently share:

- Model: `gpt-5.5`
- Reasoning effort: `low`

Stage differences:

- L2 message filtering and priority marking uses `codex exec` with `codex_message_decision*.schema.json`.
- L1 topic state uses `codex exec` with `codex_l1_state.schema.json`.
- L0 research uses `codex --search exec` with `codex_l0_reports.schema.json`.

Cron defaults to `RUN_L0=1`, so L0 is invoked after hourly L1 output. The L0 prompt is selective and should return `skip` for thin or stale topics.

## Backfill

Message backfill:

```sh
DECISION_BATCH_SIZE=80 CODEX_TIMEOUT=600 \
python3 scripts/process_three_groups_api_pipeline.py \
  --skip-collect \
  --input /path/to/raw/all_raw_messages.json \
  --skip-l1 --skip-l0
```

L1-only historical state backfill:

```sh
L1_CODEX_TIMEOUT=240 \
python3 scripts/backfill_intelligence_windows.py \
  --window-start <unix_hour_start> \
  --skip-l0 \
  --l1-max-messages 80
```

L0 reports should not be backfilled across every historical hour; run them only for selected high-value L1 topics when doing history.
