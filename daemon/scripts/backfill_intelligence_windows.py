#!/usr/bin/env python3
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

import process_three_groups_api_pipeline as pipeline


def windows_from_messages(messages, window_seconds, start_filter=0, end_filter=0):
    starts = set()
    for msg in messages:
        timestamp = pipeline.normalize_timestamp(msg.get("timestamp"))
        if not timestamp:
            continue
        start = (timestamp // window_seconds) * window_seconds
        if start_filter and start < start_filter:
            continue
        if end_filter and start >= end_filter:
            continue
        starts.add(start)
    return sorted(starts)


def seed_previous_states(states_path, before_window_start):
    previous = {}
    if not states_path.exists() or not before_window_start:
        return previous
    with states_path.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                row = pipeline.json.loads(line)
            except Exception:
                continue
            payload = row.get("payload")
            if not isinstance(payload, dict):
                continue
            channel_id = payload.get("channel_id")
            window_end = pipeline.normalize_timestamp(payload.get("window_end"))
            if not channel_id or window_end > before_window_start:
                continue
            existing = previous.get(channel_id)
            if not existing or window_end > pipeline.normalize_timestamp(existing.get("window_end")):
                previous[channel_id] = payload
    return previous


def main():
    args = pipeline.parse_args()
    args.skip_collect = True
    args.skip_processing = True
    args.dry_run = False
    args.disable_cloud_previous_state = True

    messages = pipeline.read_local_messages(args.out)
    starts = windows_from_messages(messages, args.window_seconds, args.window_start, args.window_end)
    previous_states = seed_previous_states(args.states_out, args.window_start)
    totals = {
        "windows": 0,
        "l1_posted": 0,
        "l1_skipped": 0,
        "l1_failed": 0,
        "l0_posted": 0,
        "l0_skipped": 0,
        "l0_failed": 0,
    }

    for start in starts:
        end = start + args.window_seconds
        l1 = pipeline.run_l1(args, messages, start, end, previous_states=previous_states)
        for state in l1.get("states", []):
            previous_states[state["channel_id"]] = state
        l0 = pipeline.run_l0(args, l1.get("states", []), start, end)

        totals["windows"] += 1
        totals["l1_posted"] += l1["posted"]
        totals["l1_skipped"] += l1["skipped"]
        totals["l1_failed"] += l1["failed"]
        totals["l0_posted"] += l0["posted"]
        totals["l0_skipped"] += l0["skipped"]
        totals["l0_failed"] += l0["failed"]

        print(
            f"{pipeline.now_iso()} window={start}..{end} "
            f"l1_posted={l1['posted']} l1_skipped={l1['skipped']} l1_failed={l1['failed']} "
            f"l0_posted={l0['posted']} l0_skipped={l0['skipped']} l0_failed={l0['failed']}",
            flush=True,
        )

    print(
        f"{pipeline.now_iso()} backfill_intelligence "
        f"windows={totals['windows']} l1_posted={totals['l1_posted']} "
        f"l1_skipped={totals['l1_skipped']} l1_failed={totals['l1_failed']} "
        f"l0_posted={totals['l0_posted']} l0_skipped={totals['l0_skipped']} "
        f"l0_failed={totals['l0_failed']}",
        flush=True,
    )
    return 1 if totals["l1_failed"] or totals["l0_failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
