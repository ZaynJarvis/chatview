#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_GROUPS = [
    {
        "display": "芝士美股分享①群",
        "username": "25979223983@chatroom",
    },
    {
        "display": "芝士美股分享②群",
        "username": "26929515373@chatroom",
    },
    {
        "display": "Slock 中文社区（暂定）",
        "username": "45271353210@chatroom",
    },
]


class ChatlogUnavailable(RuntimeError):
    pass


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def is_blank(value):
    return value in (None, "", "<nil>")


def clean(value):
    if is_blank(value):
        return ""
    return str(value).strip()


def load_state(path):
    if not path.exists():
        return {"api_state": {}, "seen": []}
    with path.open("r", encoding="utf-8") as f:
        state = json.load(f)
    state.setdefault("api_state", {})
    state.setdefault("seen", [])
    return state


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = now_iso()
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    tmp.replace(path)


def acquire_lock(path, stale_seconds):
    path.parent.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            payload = {
                "pid": os.getpid(),
                "created_at": now_iso(),
            }
            os.write(fd, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            os.write(fd, b"\n")
            os.close(fd)
            return True
        except FileExistsError:
            try:
                age = time.time() - path.stat().st_mtime
            except FileNotFoundError:
                continue
            if stale_seconds > 0 and age > stale_seconds:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
                continue
            return False


def release_lock(path):
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def json_from_text(text):
    stripped = text.strip()
    if not stripped:
        raise ChatlogUnavailable("empty chatlog CLI response")
    starts = [pos for pos in (stripped.find("{"), stripped.find("[")) if pos >= 0]
    if not starts:
        raise ChatlogUnavailable(stripped)
    return json.loads(stripped[min(starts):])


def chatlog_call(args, endpoint, query=None):
    cmd = [
        args.chatlog_bin,
        "http",
        "call",
        "--endpoint",
        endpoint,
        "--show-status=false",
        "--timeout",
        str(args.timeout),
        "--addr",
        args.addr,
    ]
    for key, value in query or []:
        cmd.extend(["--query", f"{key}={value}"])

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(args.repo),
            capture_output=True,
            text=True,
            timeout=args.timeout + 5,
        )
    except FileNotFoundError as exc:
        raise ChatlogUnavailable(f"chatlog binary not found: {args.chatlog_bin}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ChatlogUnavailable(f"chatlog CLI timed out after {args.timeout}s") from exc

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise ChatlogUnavailable(detail or f"chatlog CLI exited {proc.returncode}")

    stdout = proc.stdout.strip()
    stderr = proc.stderr.strip()
    if not stdout:
        raise ChatlogUnavailable(stderr or "empty chatlog CLI response")

    try:
        return json_from_text(stdout)
    except (json.JSONDecodeError, ChatlogUnavailable) as exc:
        detail = (proc.stderr or proc.stdout).strip()
        raise ChatlogUnavailable(detail or "invalid JSON from chatlog CLI") from exc


def healthcheck(args):
    payload = chatlog_call(args, "health")
    return payload.get("status") == "ok"


def group_lookup(groups):
    lookup = {}
    for group in groups:
        lookup[group["display"]] = group
        lookup[group["username"]] = group
    return lookup


def message_group(msg, lookup):
    candidates = [
        clean(msg.get("chat")),
        clean(msg.get("username")),
        clean(msg.get("source_group")),
        clean(msg.get("source_username")),
        clean(msg.get("group")),
        clean(msg.get("group_username")),
    ]
    for candidate in candidates:
        if candidate in lookup:
            return lookup[candidate]
    return None


def dedupe_key(msg, group):
    username = (
        clean(msg.get("username"))
        or clean(msg.get("source_username"))
        or clean(msg.get("group_username"))
        or group["username"]
        or clean(msg.get("chat"))
    )
    local_id = msg.get("local_id")
    if not is_blank(local_id):
        return f"{username}:{local_id}"
    raw = "|".join(
        clean(msg.get(key))
        for key in ("timestamp", "time", "sender", "type", "content")
    )
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()
    return f"{username}:sha1:{digest}"


def sort_key(row):
    timestamp = row.get("timestamp") or 0
    try:
        timestamp = int(timestamp)
    except (TypeError, ValueError):
        timestamp = 0
    return (timestamp, str(row.get("local_id") or ""), row.get("source_username") or "")


def append_jsonl(path, rows):
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, sort_keys=True))
            f.write("\n")


def fetch_new_messages(args, api_state):
    query = [
        ("limit", str(args.limit)),
        ("format", "json"),
    ]
    if api_state:
        state_text = json.dumps(api_state, ensure_ascii=False, separators=(",", ":"))
        query.append(("state", state_text))
    return chatlog_call(args, "new_messages", query)


def poll_once(args, state, seen_order, seen_set):
    payload = fetch_new_messages(args, state.get("api_state") or {})
    state["api_state"] = payload.get("new_state") or state.get("api_state") or {}

    lookup = group_lookup(args.groups)
    rows = []
    for msg in payload.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        group = message_group(msg, lookup)
        if not group:
            continue
        key = dedupe_key(msg, group)
        if key in seen_set:
            continue
        seen_set.add(key)
        seen_order.append(key)

        row = dict(msg)
        row["source_group"] = group["display"]
        row["source_username"] = group["username"]
        row["dedupe_key"] = key
        row["ingested_at"] = now_iso()
        rows.append(row)

    rows.sort(key=sort_key)
    append_jsonl(args.out, rows)

    max_seen = max(args.max_seen, args.limit * 10)
    if len(seen_order) > max_seen:
        del seen_order[:-max_seen]
        seen_set.intersection_update(seen_order)
    state["seen"] = seen_order
    save_state(args.state, state)
    return rows, payload


def parse_group(value):
    if "=" not in value:
        return {"display": value, "username": value}
    display, username = value.split("=", 1)
    return {"display": display.strip(), "username": username.strip()}


def parse_args():
    repo = Path(__file__).resolve().parents[1]
    out_dir = repo / "exports" / "follow_three_groups_jsonl"

    parser = argparse.ArgumentParser(
        description="Follow three target WeChat groups through chatlog CLI only."
    )
    parser.add_argument(
        "--chatlog-bin",
        default=os.environ.get("CHATLOG_BIN", "/opt/homebrew/bin/chatlog"),
        help="Path to chatlog CLI.",
    )
    parser.add_argument("--repo", type=Path, default=repo)
    parser.add_argument("--addr", default="127.0.0.1:5030")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--max-seen", type=int, default=50000)
    parser.add_argument("--stale-lock-seconds", type=int, default=600)
    parser.add_argument("--state", type=Path, default=out_dir / "state.json")
    parser.add_argument("--out", type=Path, default=out_dir / "new_messages.jsonl")
    parser.add_argument("--lock", type=Path, default=out_dir / "follow.lock")
    parser.add_argument(
        "--group",
        action="append",
        default=[],
        help="Extra group as display=username. Can repeat.",
    )
    parser.add_argument(
        "--backfill-first-run",
        action="store_true",
        help="Write the first no-state new_messages response instead of only saving baseline.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", dest="loop", action="store_false", help="Run one poll and exit.")
    mode.add_argument("--loop", dest="loop", action="store_true", help="Keep polling.")
    parser.set_defaults(loop=False)
    args = parser.parse_args()

    args.repo = args.repo.resolve()
    args.groups = list(DEFAULT_GROUPS)
    args.groups.extend(parse_group(item) for item in args.group if item.strip())
    return args


def main():
    args = parse_args()
    if not acquire_lock(args.lock, args.stale_lock_seconds):
        print(f"{now_iso()} already running: {args.lock}")
        return 0

    try:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.touch(exist_ok=True)

        try:
            if not healthcheck(args):
                print(f"{now_iso()} chatlog healthcheck failed")
                return 0
        except ChatlogUnavailable as exc:
            print(f"{now_iso()} chatlog unavailable: {exc}", file=sys.stderr)
            return 0

        state_existed = args.state.exists()
        state = load_state(args.state)
        seen_order = list(state.get("seen") or [])
        seen_set = set(seen_order)

        if not state_existed and not args.backfill_first_run:
            payload = fetch_new_messages(args, {})
            state["created_at"] = now_iso()
            state["groups"] = args.groups
            state["api_state"] = payload.get("new_state") or {}
            state["seen"] = []
            save_state(args.state, state)
            print(f"{now_iso()} baseline saved: {args.state}")
            if not args.loop:
                return 0

        while True:
            try:
                rows, payload = poll_once(args, state, seen_order, seen_set)
            except ChatlogUnavailable as exc:
                print(f"{now_iso()} chatlog unavailable: {exc}", file=sys.stderr)
                return 0 if not args.loop else 1

            total = len(payload.get("messages") or [])
            if rows:
                print(f"{now_iso()} wrote {len(rows)} target messages from {total} fetched -> {args.out}")
            elif not args.loop:
                print(f"{now_iso()} no new target messages from {total} fetched")

            if not args.loop:
                return 0
            time.sleep(args.interval)
    finally:
        release_lock(args.lock)


if __name__ == "__main__":
    raise SystemExit(main())
