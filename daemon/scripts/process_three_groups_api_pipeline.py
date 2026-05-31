#!/usr/bin/env python3
import argparse
import base64
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


GROUPS = [
    {"channel_id": "25979223983@chatroom", "channel": "芝士美股分享①群"},
    {"channel_id": "26929515373@chatroom", "channel": "芝士美股分享②群"},
    {"channel_id": "45271353210@chatroom", "channel": "Slock 中文社区（暂定）"},
]

ZHISHI_GROUP_IDS = {"25979223983@chatroom", "26929515373@chatroom"}
ZHISHI_MERGED_GROUP = {
    "channel_id": "zhishi-us-stocks-merged",
    "channel": "芝士美股分享①②合并",
    "source_channel_ids": sorted(ZHISHI_GROUP_IDS),
}

KEY_SENDER_HINTS = [
    "🐯",
    "🧀",
    "天翼",
    "一只腊鸡的阿西",
    "一只辣鸡的阿西",
]

VALID_PRIORITIES = {"high", "low"}
HTTP_USER_AGENT = "chatview-daemon/1.0"
KNOWN_TICKER_ALIASES = {
    "老虎": "TIGR",
    "富途": "FUTU",
    "长桥": "LGTY",
    "高通": "QCOM",
    "诺基亚": "NOK",
    "微软": "MSFT",
    "英伟达": "NVDA",
    "苹果": "AAPL",
    "谷歌": "GOOGL",
    "特斯拉": "TSLA",
    "京东": "JD",
    "蔚来": "NIO",
    "科创": "KSTR",
}
MARKDOWN_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
L1_EMPTY_DOCUMENT = "<!-- L1_STATE_EMPTY -->"
L1_CARD_START = "<!-- L1_CARD_START -->"
L1_CARD_END = "<!-- L1_CARD_END -->"
L1_CARD_RE = re.compile(
    rf"{re.escape(L1_CARD_START)}\s*(.*?)\s*{re.escape(L1_CARD_END)}",
    re.DOTALL,
)
L1_MAX_CARDS = 80


class PreprocessDelete(Exception):
    pass


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def bool_env(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def is_blank(value):
    return value in (None, "", "<nil>")


def clean(value):
    if is_blank(value):
        return None
    return str(value).strip()


def clean_text(value):
    return clean(value) or ""


def load_json(path, default):
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    tmp.replace(path)


def append_jsonl(path, row):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False, sort_keys=True))
        f.write("\n")


def load_env_file(path):
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if not key or key in os.environ:
                continue
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            os.environ[key] = value


def acquire_lock(path, stale_seconds):
    path.parent.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            os.write(fd, json.dumps({"pid": os.getpid(), "created_at": now_iso()}).encode("utf-8"))
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


def read_raw_rows(path):
    if not path.exists():
        return []
    if path.suffix == ".jsonl":
        rows = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rows.append(json.loads(line))
        return rows
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("messages"), list):
        return data["messages"]
    raise ValueError(f"unsupported raw input shape: {path}")


def group_lookup():
    out = {}
    for group in GROUPS:
        out[group["channel_id"]] = group
        out[group["channel"]] = group
    out[ZHISHI_MERGED_GROUP["channel_id"]] = ZHISHI_MERGED_GROUP
    out[ZHISHI_MERGED_GROUP["channel"]] = ZHISHI_MERGED_GROUP
    return out


def intelligence_groups():
    return [ZHISHI_MERGED_GROUP]


def group_source_ids(group):
    return set(group.get("source_channel_ids") or [group["channel_id"]])


def resolve_group(raw):
    lookup = group_lookup()
    for key in ("source_username", "source_group", "group_username", "group", "username", "chat"):
        value = clean(raw.get(key))
        if value in lookup:
            return lookup[value]
    return None


def normalize_timestamp(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def external_id_for(raw, group):
    local_id = clean(raw.get("local_id"))
    if local_id:
        return f"{group['channel_id']}:{local_id}"
    basis = "|".join(
        clean_text(raw.get(key))
        for key in ("timestamp", "time", "sender", "type", "content")
    )
    digest = hashlib.sha1(basis.encode("utf-8")).hexdigest()
    return f"{group['channel_id']}:sha1:{digest}"


def as_list(value):
    if isinstance(value, list):
        return [clean(v) for v in value if clean(v)]
    single = clean(value)
    return [single] if single else []


def split_image_key_candidates(value):
    candidates = []
    for item in as_list(value):
        for part in item.split(","):
            part = part.strip()
            if part and part not in candidates:
                candidates.append(part)
    return candidates


def select_image_key(raw):
    candidates = []
    for key in ("image_key", "media_key"):
        value = clean(raw.get(key))
        if value:
            candidates.extend(split_image_key_candidates(value))
    for key in ("image_url", "media_url"):
        value = clean(raw.get(key))
        image_key = chatlog_image_key_from_url(value)
        if image_key:
            candidates.extend(split_image_key_candidates(image_key))
    for value in as_list(raw.get("image_keys")) + as_list(raw.get("media_keys")):
        candidates.extend(split_image_key_candidates(value))
    if not candidates:
        return None
    deduped = []
    for candidate in candidates:
        if candidate not in deduped:
            deduped.append(candidate)
    return ",".join(deduped)


def chatlog_image_key_from_url(url):
    raw = clean(url)
    if not raw:
        return None
    try:
        parsed = urllib.parse.urlsplit(raw)
    except ValueError:
        return None
    if parsed.scheme and parsed.scheme not in {"http", "https"}:
        return None
    if parsed.hostname and parsed.hostname not in {"127.0.0.1", "localhost"}:
        return None
    path = parsed.path or raw
    marker = "/image/"
    if marker not in path:
        return None
    key = path.split(marker, 1)[1]
    return urllib.parse.unquote(key) if key else None


def markdown_image_sources(content):
    sources = []
    for match in MARKDOWN_IMAGE_RE.finditer(clean_text(content)):
        url = match.group(2).strip()
        image_key = chatlog_image_key_from_url(url)
        if image_key:
            sources.append({"alt": match.group(1), "url": url, "image_key": image_key})
    return sources


def image_keys_for_message(raw):
    keys = []
    seen = set()

    def add(value):
        image_key = clean(value)
        if image_key and image_key not in seen:
            seen.add(image_key)
            keys.append(image_key)

    add(select_image_key(raw))
    for source in markdown_image_sources(raw.get("content")):
        add(source["image_key"])
    return keys


def preprocessing_delete_reason(raw):
    raw_type = clean_text(raw.get("type")).lower()
    content = clean_text(raw.get("content"))
    content_normalized = content.strip()
    if raw_type in {"sticker", "emoticon"}:
        return "animated sticker message"
    if "动画表情" in content:
        return "animated sticker image"
    if content_normalized in {"[GIF表情]", "[动画表情]", "[表情]"}:
        return "sticker placeholder text"
    return None


def clean_api_message(raw):
    group = resolve_group(raw)
    if not group:
        return None
    return {
        "external_id": external_id_for(raw, group),
        "channel_id": group["channel_id"],
        "channel": group["channel"],
        "username": clean_text(raw.get("sender")),
        "content": clean_text(raw.get("content")),
        "image_url": None,
        "timestamp": normalize_timestamp(raw.get("timestamp")),
    }


def is_key_sender(username):
    return any(hint in username for hint in KEY_SENDER_HINTS)


def build_decision_prompt(msg, raw):
    image_keys = image_keys_for_message(raw)
    key_sender = is_key_sender(msg["username"])
    payload = {
        "message": msg,
        "raw_type": clean_text(raw.get("type")),
        "raw_media_type": clean_text(raw.get("media_type")),
        "has_image": bool(image_keys),
        "image_keys": image_keys,
        "is_key_sender": key_sender,
    }
    return f"""
You are filtering WeChat group messages before they are sent to a frontend API.

Return JSON only matching the provided schema:
{{"action":"keep"|"delete","priority":"high"|"low"|null,"reason":"short reason"}}

Decision policy:
- Keep only messages that are useful for downstream market intelligence, especially concrete analysis, decisions, predictions, news, tickers, sectors, positions, risks, notable links/images, or actionable trading/investing context.
- Delete meaningless chatter: greetings, jokes, acknowledgements, pure reactions, very short off-topic replies, social coordination, duplicated noise, or messages with no standalone information.
- Important speakers are strong keep candidates: 🐯 and 🧀 first; 天翼 and 一只腊鸡的阿西 / 一只辣鸡的阿西 are secondary.
- For 🐯 and 🧀, keep unless the message is clearly empty/noise. Mark high when it contains substantive analysis, explicit recommendation, risk, market view, ticker/sector view, or actionable content. Mark low for lightweight but still potentially useful comments.
- Keep non-key messages when they reply to, challenge, clarify, add data to, or provide context for a 🐯/🧀 topic.
- If has_image is true, treat the image as potentially market-relevant unless clearly a sticker; downstream VLM/image handling must get a chance to inspect it.
- For other speakers, default to delete unless the message has clear standalone signal. If kept, choose high only for strong actionable/substantive information; otherwise low.
- If action is delete, priority must be null. If action is keep, priority must be high or low.

Message payload:
{json.dumps(payload, ensure_ascii=False, indent=2)}
""".strip()


def decision_payload(msg, raw):
    image_keys = image_keys_for_message(raw)
    prompt_msg = {**msg, "content": bounded_text(msg.get("content"), 1000)}
    return {
        "message": prompt_msg,
        "raw_type": clean_text(raw.get("type")),
        "raw_media_type": clean_text(raw.get("media_type")),
        "has_image": bool(image_keys),
        "image_keys": image_keys,
        "is_key_sender": is_key_sender(msg["username"]),
    }


def build_batch_decision_prompt(items):
    payload = [decision_payload(msg, raw) for msg, raw in items]
    return f"""
You are filtering WeChat group messages before they are sent to a frontend API.

Return JSON only matching the provided schema:
{{"decisions":[{{"external_id":"...","action":"keep"|"delete","priority":"high"|"low"|null,"reason":"short reason"}}]}}

Decision policy:
- Make one independent decision for every input message.external_id.
- Keep only messages useful for downstream market intelligence, especially concrete analysis, decisions, predictions, news, tickers, sectors, positions, risks, notable links/images, or actionable trading/investing context.
- Delete meaningless chatter: greetings, jokes, acknowledgements, pure reactions, very short off-topic replies, social coordination, duplicated noise, or messages with no standalone information.
- Important speakers are strong keep candidates: 🐯 and 🧀 first; 天翼 and 一只腊鸡的阿西 / 一只辣鸡的阿西 are secondary.
- For 🐯 and 🧀, keep unless the message is clearly empty/noise. Mark high when it contains substantive analysis, explicit recommendation, risk, market view, ticker/sector view, or actionable content. Mark low for lightweight but still potentially useful comments.
- Keep non-key messages when they reply to, challenge, clarify, add data to, or provide context for a 🐯/🧀 topic.
- If has_image is true, treat the image as potentially market-relevant unless clearly a sticker; downstream VLM/image handling must get a chance to inspect it.
- For other speakers, default to delete unless the message has clear standalone signal. If kept, choose high only for strong actionable/substantive information; otherwise low.
- If action is delete, priority must be null. If action is keep, priority must be high or low.
- Output exactly one decision per input external_id.

Message payloads:
{json.dumps(payload, ensure_ascii=False, indent=2)}
""".strip()


def strip_code_fence(text):
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return stripped


def normalize_decision(decision):
    action = decision.get("action")
    priority = decision.get("priority")
    reason = clean_text(decision.get("reason"))[:240]
    if action not in {"keep", "delete"}:
        raise ValueError(f"invalid action: {action}")
    if action == "delete":
        return {"action": "delete", "priority": None, "reason": reason}
    if priority not in VALID_PRIORITIES:
        raise ValueError(f"invalid keep priority: {priority}")
    return {"action": "keep", "priority": priority, "reason": reason}


def heuristic_decision(msg, raw):
    username = msg["username"]
    content = msg["content"].strip()
    has_image = bool(image_keys_for_message(raw))
    if is_key_sender(username):
        if not content and not has_image:
            return {"action": "delete", "priority": None, "reason": "key sender but empty message"}
        high_terms = ["买", "卖", "风险", "仓", "股票", "美股", "突破", "财报", "期权", "涨", "跌", "板块", "估值", "支撑"]
        priority = "high" if any(term in content for term in high_terms) or has_image else "low"
        return {"action": "keep", "priority": priority, "reason": "key sender fallback decision"}
    signal_terms = ["股票", "美股", "$", "ETF", "期权", "财报", "风险", "买", "卖", "板块", "估值", "支撑"]
    if len(content) >= 8 and any(term in content for term in signal_terms):
        return {"action": "keep", "priority": "low", "reason": "non-key sender with possible signal"}
    return {"action": "delete", "priority": None, "reason": "fallback deleted likely low-signal chatter"}


def codex_exec_json(args, prompt, schema_path, out_path, timeout, use_search=False, image_paths=None, reasoning_effort=None):
    args.codex_out_dir.mkdir(parents=True, exist_ok=True)
    try:
        out_path.unlink()
    except FileNotFoundError:
        pass
    cmd = [args.codex_bin]
    if use_search:
        cmd.append("--search")
    cmd.extend([
        "exec",
        "-c",
        "approval_policy=\"never\"",
        "--model",
        args.codex_model,
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--output-schema",
        str(schema_path),
        "-o",
        str(out_path),
        "-C",
        str(args.repo),
    ])
    for image_path in image_paths or []:
        cmd.extend(["--image", str(image_path)])
    cmd.append("-")
    effective_reasoning_effort = args.codex_reasoning_effort if reasoning_effort is None else reasoning_effort
    if effective_reasoning_effort:
        insert_at = 3 if use_search else 2
        cmd[insert_at:insert_at] = ["-c", f"model_reasoning_effort={json.dumps(effective_reasoning_effort)}"]

    try:
        proc = subprocess.run(
            cmd,
            input=prompt,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"codex binary not found: {args.codex_bin}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"codex timed out writing {out_path.name}") from exc

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(f"codex failed writing {out_path.name}: {detail}")
    if not out_path.exists():
        detail = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(f"codex did not write {out_path.name}: {detail}")
    return json.loads(strip_code_fence(out_path.read_text(encoding="utf-8")))


def codex_decision(args, msg, raw):
    if args.decision_mode == "heuristic":
        return heuristic_decision(msg, raw)

    prompt = build_decision_prompt(msg, raw)
    out_path = args.codex_out_dir / f"{safe_filename(msg['external_id'])}.decision.json"
    decision = codex_exec_json(args, prompt, args.decision_schema, out_path, args.codex_timeout)
    return normalize_decision(decision)


def codex_batch_decisions(args, items):
    if args.decision_mode == "heuristic" or args.decision_batch_size <= 1 or len(items) == 1:
        return {msg["external_id"]: codex_decision(args, msg, raw) for msg, raw in items}

    first_id = items[0][0]["external_id"]
    last_id = items[-1][0]["external_id"]
    digest = hashlib.sha1("|".join(msg["external_id"] for msg, _ in items).encode("utf-8")).hexdigest()[:16]
    out_path = args.codex_out_dir / f"batch_{safe_filename(first_id)}_{safe_filename(last_id)}_{digest}.decision.json"
    result = codex_exec_json(
        args,
        build_batch_decision_prompt(items),
        args.batch_decision_schema,
        out_path,
        args.codex_timeout,
    )

    decisions = {}
    for item in result.get("decisions") or []:
        if not isinstance(item, dict):
            continue
        external_id = clean(item.get("external_id"))
        if not external_id:
            continue
        decisions[external_id] = normalize_decision(item)

    missing = [item for item in items if item[0]["external_id"] not in decisions]
    for msg, raw in missing:
        decisions[msg["external_id"]] = codex_decision(args, msg, raw)
    return decisions


def chunked(items, size):
    size = max(1, int(size or 1))
    for start in range(0, len(items), size):
        yield items[start:start + size]


def safe_filename(value):
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in value)[:180]


def mime_type_for(data):
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) > 12 and data[4:8] == b"ftyp":
        brand = data[8:12].lower()
        if brand in {b"heic", b"heix", b"hevc", b"hevx"}:
            return "image/heic"
        if brand in {b"mif1", b"msf1"}:
            return "image/heif"
    return "application/octet-stream"


def is_animated_image_data(data):
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return True
    if data.startswith(b"\x89PNG\r\n\x1a\n") and b"acTL" in data[:4096]:
        return True
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP" and b"ANIM" in data[:4096]:
        return True
    return False


def chatlog_download_image(args, image_key):
    with tempfile.NamedTemporaryFile(prefix="chatlog-image-", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    cmd = [
        args.chatlog_bin,
        "http",
        "call",
        "--endpoint",
        "image",
        "--path-param",
        f"key={image_key}",
        "--show-status=false",
        "--timeout",
        str(args.chatlog_timeout),
        "--addr",
        args.chatlog_addr,
        "--output",
        str(tmp_path),
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(args.repo), capture_output=True, text=True, timeout=args.chatlog_timeout + 5)
        if proc.returncode != 0 or not tmp_path.exists() or tmp_path.stat().st_size == 0:
            detail = (proc.stderr or proc.stdout).strip()
            raise RuntimeError(detail or "empty image download")
        return tmp_path.read_bytes()
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def derive_cloud_endpoint(messages_endpoint, api_name):
    if not messages_endpoint:
        return ""
    parsed = urllib.parse.urlsplit(messages_endpoint)
    base_path = parsed.path.rstrip("/")
    if base_path.endswith("/messages"):
        base_path = base_path[: -len("/messages")]
    new_path = f"{base_path}/{api_name.strip('/')}"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, new_path, "", ""))


def request_headers(api_key):
    headers = {
        "Accept": "application/json",
        "User-Agent": HTTP_USER_AGENT,
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
        headers["X-API-Key"] = api_key
    return headers


def get_json(url, api_key, timeout, params=None, missing_ok=False):
    if params:
        query = urllib.parse.urlencode(params)
        separator = "&" if urllib.parse.urlsplit(url).query else "?"
        url = f"{url}{separator}{query}"
    req = urllib.request.Request(url, method="GET", headers=request_headers(api_key))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            parsed = json.loads(body) if body.strip() else {}
            return resp.status, parsed
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if missing_ok and exc.code == 404:
            return exc.code, {}
        raise RuntimeError(f"GET {url} failed HTTP {exc.code}: {body}") from exc


def post_json(url, api_key, payload, timeout):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers=request_headers(api_key))
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            parsed = json.loads(body) if body.strip() else {}
            return resp.status, parsed
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if exc.code == 409:
            return exc.code, {"duplicate": True, "body": body}
        raise RuntimeError(f"POST {url} failed HTTP {exc.code}: {body}") from exc


def message_url(args, external_id):
    return f"{args.cloud_msg_endpoint.rstrip('/')}/{urllib.parse.quote(external_id, safe='')}"


def cloud_message_exists(args, external_id):
    status, _ = get_json(message_url(args, external_id), args.cloud_api_key, args.cloud_timeout, missing_ok=True)
    return status == 200


def post_message_to_cloud(args, msg):
    status, response = post_json(args.cloud_msg_endpoint, args.cloud_api_key, msg, args.cloud_timeout)
    return {"mode": "cloud", "status": status, "duplicate": bool(response.get("duplicate"))}


def post_binary(url, api_key, data, mime_type, filename, timeout):
    req = urllib.request.Request(url, data=data, method="POST", headers=request_headers(api_key))
    req.add_header("Content-Type", mime_type)
    req.add_header("X-Filename", filename)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            parsed = json.loads(body) if body.strip() else {}
            return resp.status, parsed
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if exc.code == 409:
            return exc.code, {"duplicate": True, "body": body}
        raise RuntimeError(f"POST {url} failed HTTP {exc.code}: {body}") from exc


def post_image_json(url, api_key, data, mime_type, filename, timeout):
    payload = {
        "filename": filename,
        "content_type": mime_type,
        "data_base64": base64.b64encode(data).decode("ascii"),
    }
    return post_json(url, api_key, payload, timeout)


def extension_for_mime(mime_type):
    return {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/heic": "heic",
        "image/heif": "heif",
    }.get(mime_type, "bin")


def upload_image_data(args, data, source_label):
    if is_animated_image_data(data):
        raise PreprocessDelete("animated image detected before upload")
    mime_type = mime_type_for(data)
    if not mime_type.startswith("image/"):
        raise PreprocessDelete(f"unsupported image payload type: {mime_type}")
    digest = hashlib.sha256(data).hexdigest()
    filename = f"{digest}.{extension_for_mime(mime_type)}"
    try:
        _, response = post_binary(args.cloud_img_endpoint, args.cloud_api_key, data, mime_type, filename, args.cloud_timeout)
    except Exception:
        _, response = post_image_json(args.cloud_img_endpoint, args.cloud_api_key, data, mime_type, filename, args.cloud_timeout)
    image_url = response.get("image_url")
    if not image_url:
        raise RuntimeError(f"image upload response missing image_url for {source_label}: {response}")
    return image_url


def chatlog_download_best_image(args, image_key):
    candidates = split_image_key_candidates(image_key)
    if not candidates:
        raise RuntimeError("empty image key")

    best = None
    errors = []
    for candidate in candidates:
        try:
            data = chatlog_download_image(args, candidate)
            mime_type = mime_type_for(data)
            if not mime_type.startswith("image/"):
                errors.append(f"{candidate}: unsupported payload {mime_type}")
                continue
            if best is None or len(data) > len(best[0]):
                best = (data, candidate)
        except Exception as exc:
            errors.append(f"{candidate}: {exc}")

    if best is not None:
        return best
    detail = "; ".join(errors[:4]) if errors else "no candidates"
    raise RuntimeError(f"no usable image payload for {image_key}: {detail}")


def upload_image_key(args, image_key):
    if not image_key or not args.cloud_img_endpoint:
        return None
    try:
        data, selected_key = chatlog_download_best_image(args, image_key)
    except RuntimeError as exc:
        detail = str(exc)
        if "no usable image payload" in detail or "unsupported payload" in detail:
            raise PreprocessDelete(detail) from exc
        raise
    return upload_image_data(args, data, selected_key)


def upload_image(args, raw):
    return upload_image_key(args, select_image_key(raw))


def describe_image_with_vlm(args, image_key, msg):
    if not image_key:
        return None
    data, selected_key = chatlog_download_best_image(args, image_key)
    if is_animated_image_data(data):
        return None
    mime_type = mime_type_for(data)
    if not mime_type.startswith("image/"):
        return None
    suffix = "." + extension_for_mime(mime_type)
    with tempfile.NamedTemporaryFile(prefix="chatlog-vlm-", suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        image_path = Path(tmp.name)
    try:
        prompt = f"""
You are a VLM analyst for a Chinese US-stock WeChat feed.

Return JSON only matching the provided schema.

Extract only market-relevant visual information:
- OCR visible ticker/company/price/chart/table/news text when readable.
- Describe chart direction, support/resistance, earnings/news headlines, watchlist rows, or position/order information.
- If the image is not market-relevant, say so concisely.
- Do not invent unreadable text.

Selected chatlog image key: {selected_key}
Message context:
{json.dumps(prompt_message_view(msg), ensure_ascii=False, indent=2)}
""".strip()
        out_path = args.codex_out_dir / f"{safe_filename(msg['external_id'])}.image.json"
        result = codex_exec_json(
            args,
            prompt,
            args.image_caption_schema,
            out_path,
            args.image_codex_timeout,
            image_paths=[image_path],
            reasoning_effort=args.image_reasoning_effort,
        )
        return {
            "summary": bounded_text(result.get("summary"), 500),
            "visible_text": bounded_text(result.get("visible_text"), 1000),
            "market_relevance": result.get("market_relevance") if result.get("market_relevance") in {"high", "low", "none"} else "low",
            "tickers": [bounded_text(item, 12).upper() for item in result.get("tickers") or [] if clean(item)][:12],
        }
    finally:
        try:
            image_path.unlink()
        except FileNotFoundError:
            pass


def prepare_message_images(args, raw, msg):
    sources = markdown_image_sources(msg.get("content"))
    raw_image_key = select_image_key(raw)
    if args.cloud_msg_endpoint and (sources or raw_image_key) and not args.cloud_img_endpoint:
        raise RuntimeError("CLOUD_IMG_ENDPOINT is required before posting image messages to cloud")

    uploaded_by_key = {}
    uploaded_urls = []

    def upload_once(image_key):
        if image_key not in uploaded_by_key:
            uploaded_by_key[image_key] = upload_image_key(args, image_key)
        image_url = uploaded_by_key[image_key]
        if image_url and image_url not in uploaded_urls:
            uploaded_urls.append(image_url)
        return image_url

    content = msg.get("content") or ""
    for source in sources:
        image_url = upload_once(source["image_key"])
        if image_url:
            content = content.replace(source["url"], image_url)

    if raw_image_key and not sources:
        upload_once(raw_image_key)

    if uploaded_urls:
        msg["image_url"] = uploaded_urls[0]
    analysis_key = raw_image_key or (sources[0]["image_key"] if sources else None)
    if analysis_key:
        try:
            image_analysis = describe_image_with_vlm(args, analysis_key, msg)
            if image_analysis:
                msg["image_analysis"] = image_analysis
        except Exception as exc:
            append_jsonl(args.errors, {
                "at": now_iso(),
                "external_id": msg.get("external_id"),
                "stage": "image_vlm",
                "error": str(exc),
                "image_key": analysis_key,
            })
    msg["content"] = content
    return uploaded_urls


def submit_message(args, msg):
    if not args.cloud_msg_endpoint:
        append_jsonl(args.out, msg)
        return {"mode": "local", "duplicate": False}
    result = post_message_to_cloud(args, msg)
    append_jsonl(args.out, msg)
    return result


def refresh_snapshots(args):
    messages_by_id = {}
    if args.out.exists():
        with args.out.open("r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                external_id = row.get("external_id")
                if not external_id:
                    continue
                messages_by_id[external_id] = row
    messages = list(messages_by_id.values())
    messages.sort(key=lambda row: (row.get("timestamp") or 0, row.get("external_id") or ""))
    save_json(args.api_snapshot, {"updated_at": now_iso(), "count": len(messages), "messages": messages})

    counts = {group["channel_id"]: 0 for group in GROUPS}
    for msg in messages:
        if msg.get("channel_id") in counts:
            counts[msg["channel_id"]] += 1
    channels = [
        {"channel_id": group["channel_id"], "channel": group["channel"], "message_count": counts[group["channel_id"]]}
        for group in GROUPS
    ]
    save_json(args.channels_snapshot, {"updated_at": now_iso(), "channels": channels})


def bounded_text(value, limit):
    text = " ".join(clean_text(value).split())
    if len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3] + "..."


def iso_for_timestamp(timestamp):
    if not timestamp:
        return None
    try:
        return datetime.fromtimestamp(int(timestamp), timezone.utc).astimezone().isoformat(timespec="seconds")
    except (OSError, OverflowError, ValueError):
        return None


def intelligence_window(args):
    if args.window_end:
        end = int(args.window_end)
    elif args.window_align_hour:
        end = (int(time.time()) // args.window_seconds) * args.window_seconds
    else:
        end = int(time.time())
    start = int(args.window_start) if args.window_start else end - args.window_seconds
    if start >= end:
        raise ValueError(f"invalid intelligence window: start={start} end={end}")
    return start, end


def read_local_messages(path):
    if not path.exists():
        return []
    rows_by_id = {}
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            external_id = row.get("external_id")
            if not external_id:
                continue
            rows_by_id[external_id] = row
    rows = list(rows_by_id.values())
    rows.sort(key=lambda row: (row.get("timestamp") or 0, row.get("external_id") or ""))
    return rows


def source_ids_for_state_payload(payload):
    ids = []
    seen = set()

    def add(value):
        external_id = clean(value)
        if external_id and external_id not in seen:
            seen.add(external_id)
            ids.append(external_id)

    for external_id in payload.get("source_message_ids") or []:
        add(external_id)
    for card in payload.get("cards") or []:
        for external_id in card.get("message_ids") or []:
            add(external_id)
    return ids


def ensure_cloud_source_messages(args, payload, local_by_id):
    if not args.cloud_state_endpoint:
        return
    if not args.cloud_msg_endpoint:
        raise RuntimeError("refusing to post cloud L1 state without CLOUD_MSG_ENDPOINT; source message links would break")

    available = set()
    posted = 0
    missing_local = []
    for external_id in source_ids_for_state_payload(payload):
        if cloud_message_exists(args, external_id):
            available.add(external_id)
            continue
        msg = local_by_id.get(external_id)
        if not msg:
            missing_local.append(external_id)
            continue
        post_message_to_cloud(args, msg)
        available.add(external_id)
        posted += 1

    payload["source_message_ids"] = [
        external_id for external_id in payload.get("source_message_ids", [])
        if external_id in available
    ]
    filtered_cards = []
    for card in payload.get("cards") or []:
        message_ids = [
            external_id for external_id in card.get("message_ids", [])
            if external_id in available
        ]
        if not message_ids:
            continue
        filtered_cards.append({**card, "message_ids": message_ids})
    payload["cards"] = filtered_cards
    payload["markdown"] = "\n".join(f"- **{card['title']}** {card['body']}" for card in filtered_cards)

    if missing_local or posted:
        append_jsonl(args.states_out, {
            "at": now_iso(),
            "mode": "source_message_check",
            "state_id": payload.get("state_id"),
            "posted": posted,
            "missing_local": missing_local,
        })


def prompt_message_view(msg):
    return {
        "external_id": clean_text(msg.get("external_id")),
        "channel_id": clean_text(msg.get("channel_id")),
        "channel": clean_text(msg.get("channel")),
        "username": clean_text(msg.get("username")),
        "content": bounded_text(msg.get("content"), 1200),
        "image_url": msg.get("image_url"),
        "image_analysis": msg.get("image_analysis"),
        "timestamp": msg.get("timestamp"),
        "datetime": iso_for_timestamp(msg.get("timestamp")),
        "priority": msg.get("priority"),
        "is_key_sender": is_key_sender(clean_text(msg.get("username"))),
    }


def messages_for_channel_window(messages, channel_id, window_start, window_end, limit):
    selected = [
        msg for msg in messages
        if msg.get("channel_id") == channel_id
        and window_start <= normalize_timestamp(msg.get("timestamp")) < window_end
    ]
    if limit and len(selected) > limit:
        ranked = sorted(
            selected,
            key=lambda msg: (
                1 if msg.get("priority") == "high" else 0,
                1 if is_key_sender(clean_text(msg.get("username"))) else 0,
                normalize_timestamp(msg.get("timestamp")),
            ),
            reverse=True,
        )[:limit]
        selected = sorted(ranked, key=lambda msg: (normalize_timestamp(msg.get("timestamp")), msg.get("external_id") or ""))
    return selected


def messages_for_group_window(messages, group, window_start, window_end, limit):
    source_ids = group_source_ids(group)
    selected = [
        msg for msg in messages
        if msg.get("channel_id") in source_ids
        and window_start <= normalize_timestamp(msg.get("timestamp")) < window_end
    ]
    if limit and len(selected) > limit:
        ranked = sorted(
            selected,
            key=lambda msg: (
                1 if is_key_sender(clean_text(msg.get("username"))) else 0,
                1 if msg.get("priority") == "high" else 0,
                1 if msg.get("image_analysis") else 0,
                normalize_timestamp(msg.get("timestamp")),
            ),
            reverse=True,
        )[:limit]
        selected = sorted(ranked, key=lambda msg: (normalize_timestamp(msg.get("timestamp")), msg.get("external_id") or ""))
    return selected


def output_channels_for_group(group):
    if group.get("channel_id") != ZHISHI_MERGED_GROUP["channel_id"]:
        return [{"channel_id": group["channel_id"], "channel": group["channel"]}]
    lookup = group_lookup()
    return [
        {"channel_id": channel_id, "channel": lookup[channel_id]["channel"]}
        for channel_id in ["26929515373@chatroom", "25979223983@chatroom"]
    ]


def extract_state_response(data):
    if not isinstance(data, dict):
        return None
    if "state" in data:
        return data.get("state")
    states = data.get("states")
    if isinstance(states, list) and states:
        return states[0]
    if any(key in data for key in ("state_id", "id", "markdown", "cards")):
        return data
    return None


def get_channel_state(args, channel_id, level):
    if not args.cloud_state_endpoint:
        return None
    status, data = get_json(
        args.cloud_state_endpoint,
        args.cloud_api_key,
        args.cloud_timeout,
        params={"channel_id": channel_id, "level": level},
        missing_ok=True,
    )
    if status == 404:
        return None
    return extract_state_response(data)


def l1_card_field(value):
    return clean_text(value).replace("\r", " ").replace("\n", " ").strip()


def cards_to_l1_document(cards):
    blocks = []
    for card in cards or []:
        if not isinstance(card, dict):
            continue
        title = l1_card_field(card.get("title"))
        body = l1_card_field(card.get("body"))
        if not title or not body:
            continue
        priority = clean_text(card.get("priority")).lower()
        if priority not in VALID_PRIORITIES:
            priority = "low"
        message_ids = []
        for message_id in card.get("message_ids") or []:
            clean_id = clean(message_id)
            if clean_id and clean_id not in message_ids:
                message_ids.append(clean_id)
        blocks.append(
            "\n".join([
                L1_CARD_START,
                f"title: {title}",
                f"priority: {priority}",
                f"message_ids: {', '.join(message_ids)}",
                f"body: {body}",
                L1_CARD_END,
            ])
        )
    return "\n\n".join(blocks) if blocks else L1_EMPTY_DOCUMENT


def l1_document_from_state(previous_state):
    if not isinstance(previous_state, dict):
        return L1_EMPTY_DOCUMENT
    cards = previous_state.get("cards")
    if isinstance(cards, list) and cards:
        return cards_to_l1_document(cards)
    return L1_EMPTY_DOCUMENT


def parse_l1_card_block(block):
    fields = {}
    for raw_line in block.splitlines():
        if ":" not in raw_line:
            continue
        key, value = raw_line.split(":", 1)
        key = key.strip().lower()
        if key in {"title", "priority", "message_ids", "body"}:
            fields[key] = value.strip()

    title = bounded_text(fields.get("title"), 18)
    body = bounded_text(fields.get("body"), max(8, 50 - len(title)))
    priority = clean_text(fields.get("priority")).lower()
    if priority not in VALID_PRIORITIES:
        priority = "low"
    message_ids = []
    for message_id in fields.get("message_ids", "").split(","):
        clean_id = clean(message_id)
        if clean_id and clean_id not in message_ids:
            message_ids.append(clean_id)

    if not title or not body:
        return None
    return {
        "title": title,
        "body": body,
        "priority": priority,
        "message_ids": message_ids[:8],
    }


def l1_document_to_cards(document):
    text = clean_text(document)
    if not text or text == L1_EMPTY_DOCUMENT:
        return []

    cards = []
    for match in L1_CARD_RE.finditer(text):
        card = parse_l1_card_block(match.group(1))
        if card:
            cards.append(card)
        if len(cards) >= L1_MAX_CARDS:
            break

    if not cards:
        raise ValueError("patched L1 document contains no valid L1_CARD blocks")
    return cards


def markdown_for_l1_cards(cards):
    return "\n".join(f"- **{card['title']}** {card['body']}" for card in cards)


def build_l1_prompt(group, messages, previous_state, current_document, window_start, window_end, patch_error=None):
    payload = {
        "channel": group,
        "window": {
            "start": window_start,
            "end": window_end,
            "start_iso": iso_for_timestamp(window_start),
            "end_iso": iso_for_timestamp(window_end),
        },
        "previous_state": previous_state,
        "current_l1_document": current_document,
        "previous_patch_error": patch_error,
        "messages": [prompt_message_view(msg) for msg in messages],
    }
    return f"""
You maintain the L1 state document for the Zhishi US-stock intelligence feed.

Return JSON only matching the provided schema.

Goal:
- Update current_l1_document with the latest filtered messages from both Zhishi groups.
- Treat this L1 document as the durable topic layer extracted from L2 messages: sectors, themes, tickers, catalysts, stance, risk, and what changed.
- Focus on 🐯 and 🧀 as high-value investors. Their insight, advice, risk framing, and the topics they discuss are the primary signal.
- Preserve related messages from other people only when they clarify, challenge, add data to, or name the ticker/sector behind a 🐯/🧀 discussion.
- Preserve existing useful cards unless a new message changes, supersedes, or makes them stale.
- The executor will convert the patched document back into frontend cards.

Rules:
- action=skip if there is no meaningful state update.
- You may only change L1 content through replacements[] search/replace instructions.
- Each replacement must set match="single"; no other match mode is supported.
- Each replacement.search must be an exact substring copied from current_l1_document.
- The executor supports only single-match replacement. If search matches 0 or more than 1 block, it errors and you must retry.
- Do not use regex, ellipses, or prose placeholders inside search/replace.
- Prefer replacing one complete L1_CARD block at a time, including the card boundary comments.
- To add a card to an empty document, search exactly "{L1_EMPTY_DOCUMENT}" and replace it with a full L1_CARD block.
- To append a card to a non-empty document, search one unique existing L1_CARD block and replace it with itself plus the new block.
- To update a card, search the full old block and replace it with the revised full block.
- To delete a stale card, search the full old block and replace it with an empty string.
- If two identical blocks exist, search a larger unique substring; if no unique substring exists, return skip with a reason.
- Use exactly this card format in replacement text:
  {L1_CARD_START}
  title: short title, preferably <= 20 characters
  priority: high or low
  message_ids: comma-separated source external_id values
  body: <= 50 Chinese/English characters
  {L1_CARD_END}
- Drop stale, duplicated, vague, or low-signal chatter by explicit replacement only.
- Merge 芝士美股分享①群 and 芝士美股分享②群 into one combined view. Do not split output by group.
- Prefer cards about investable sectors/tickers over generic market mood.
- If image_analysis exists, use it as VLM evidence and cite the image message id when relevant.
- Do not invent external facts or research here; only extract and compress group evidence.

Input:
{json.dumps(payload, ensure_ascii=False, indent=2)}
""".strip()


def normalize_l1_result(result):
    action = result.get("action")
    reason = bounded_text(result.get("reason"), 240)
    if action not in {"post", "skip"}:
        raise ValueError(f"invalid L1 action: {action}")
    if action == "skip":
        return {"action": "skip", "replacements": [], "reason": reason}

    replacements = []
    for index, replacement in enumerate(result.get("replacements") or [], start=1):
        if not isinstance(replacement, dict):
            raise ValueError(f"replacement {index} must be an object")
        search = replacement.get("search")
        replace = replacement.get("replace")
        match_mode = replacement.get("match")
        if match_mode != "single":
            raise ValueError(f"replacement {index} match must be single")
        if not isinstance(search, str) or search == "":
            raise ValueError(f"replacement {index} search must be a non-empty string")
        if not isinstance(replace, str):
            raise ValueError(f"replacement {index} replace must be a string")
        replacements.append({"search": search, "replace": replace})

    if not replacements:
        raise ValueError("action=post requires at least one search/replace instruction")
    return {"action": "post", "replacements": replacements, "reason": reason}


def apply_l1_replacements(document, replacements):
    patched = document
    for index, replacement in enumerate(replacements, start=1):
        search = replacement["search"]
        replace = replacement["replace"]
        count = patched.count(search)
        if count != 1:
            raise ValueError(f"replacement {index} search matched {count} block(s); expected exactly 1")
        patched = patched.replace(search, replace, 1)
    return patched.strip() or L1_EMPTY_DOCUMENT


def generate_l1_state(args, group, messages, previous_state, current_document, window_start, window_end):
    patch_error = None
    for attempt in range(args.l1_patch_retries + 1):
        prompt = build_l1_prompt(group, messages, previous_state, current_document, window_start, window_end, patch_error)
        suffix = f"_attempt{attempt + 1}" if attempt else ""
        out_path = args.codex_out_dir / f"l1_{safe_filename(group['channel_id'])}_{window_start}_{window_end}{suffix}.json"
        try:
            result = codex_exec_json(
                args,
                prompt,
                args.l1_schema,
                out_path,
                args.l1_codex_timeout,
                reasoning_effort=args.l1_reasoning_effort,
            )
            normalized = normalize_l1_result(result)
            if normalized["action"] == "skip":
                return {"action": "skip", "markdown": "", "cards": [], "reason": normalized["reason"]}
            patched_document = apply_l1_replacements(current_document, normalized["replacements"])
            cards = l1_document_to_cards(patched_document)
            if not cards:
                return {"action": "skip", "markdown": "", "cards": [], "reason": "no valid L1 cards"}
            return {
                "action": "post",
                "markdown": markdown_for_l1_cards(cards),
                "cards": cards,
                "reason": normalized["reason"],
            }
        except Exception as exc:
            patch_error = str(exc)
            append_jsonl(args.states_out, {
                "at": now_iso(),
                "mode": "l1_patch_retry" if attempt < args.l1_patch_retries else "l1_patch_failed",
                "channel_id": group["channel_id"],
                "level": "L1",
                "window_start": window_start,
                "window_end": window_end,
                "attempt": attempt + 1,
                "error": patch_error,
            })
            if attempt >= args.l1_patch_retries:
                raise


def post_channel_state(args, payload):
    if not args.cloud_state_endpoint:
        append_jsonl(args.states_out, {"at": now_iso(), "mode": "local", "payload": payload})
        return {"mode": "local", "status": None, "response": {}}
    status, response = post_json(args.cloud_state_endpoint, args.cloud_api_key, payload, args.cloud_timeout)
    append_jsonl(args.states_out, {"at": now_iso(), "mode": "cloud", "status": status, "payload": payload, "response": response})
    return {"mode": "cloud", "status": status, "response": response}


def run_l1(args, all_messages, window_start, window_end, previous_states=None):
    summary = {"posted": 0, "skipped": 0, "failed": 0, "states": []}
    if not args.run_l1:
        return summary
    local_by_id = {
        msg["external_id"]: msg
        for msg in all_messages
        if msg.get("external_id")
    }
    for group in intelligence_groups():
        output_channels = output_channels_for_group(group)
        previous_channel_id = output_channels[0]["channel_id"]
        messages = messages_for_group_window(all_messages, group, window_start, window_end, args.l1_max_messages)
        if not messages:
            summary["skipped"] += 1
            continue
        try:
            if previous_states is not None:
                previous_state = previous_states.get(group["channel_id"]) or previous_states.get(previous_channel_id)
            elif args.disable_cloud_previous_state:
                previous_state = None
            else:
                previous_state = get_channel_state(args, previous_channel_id, "L1")
            current_document = l1_document_from_state(previous_state)
            normalized = generate_l1_state(args, group, messages, previous_state, current_document, window_start, window_end)
            if normalized["action"] == "skip":
                append_jsonl(args.states_out, {
                    "at": now_iso(),
                    "mode": "skip",
                    "channel_id": group["channel_id"],
                    "level": "L1",
                    "window_start": window_start,
                    "window_end": window_end,
                    "reason": normalized["reason"],
                })
                summary["skipped"] += 1
                continue
            canonical_payload = {
                "state_id": f"l1:{group['channel_id']}:{window_start}:{window_end}",
                "channel_id": group["channel_id"],
                "channel": group["channel"],
                "output_channel_ids": [item["channel_id"] for item in output_channels],
                "source_channel_ids": sorted(group_source_ids(group)),
                "level": "L1",
                "markdown": normalized["markdown"],
                "cards": normalized["cards"],
                "window_start": window_start,
                "window_end": window_end,
                "source_message_ids": [msg["external_id"] for msg in messages],
                "previous_state_id": previous_state.get("state_id") or previous_state.get("id") if isinstance(previous_state, dict) else None,
                "generated_at": now_iso(),
            }
            posted_any = False
            for output_channel in output_channels:
                payload = {
                    **canonical_payload,
                    "state_id": f"l1:{output_channel['channel_id']}:{window_start}:{window_end}",
                    "channel_id": output_channel["channel_id"],
                    "channel": output_channel["channel"],
                }
                ensure_cloud_source_messages(args, payload, local_by_id)
                if not payload["cards"]:
                    continue
                post_channel_state(args, payload)
                posted_any = True
            if not posted_any:
                append_jsonl(args.states_out, {
                    "at": now_iso(),
                    "mode": "skip",
                    "channel_id": group["channel_id"],
                    "level": "L1",
                    "window_start": window_start,
                    "window_end": window_end,
                    "reason": "no cloud-available source messages for L1 cards",
                })
                summary["skipped"] += 1
                continue
            summary["posted"] += 1
            summary["states"].append(canonical_payload)
        except Exception as exc:
            summary["failed"] += 1
            append_jsonl(args.errors, {
                "at": now_iso(),
                "stage": "l1_state",
                "channel_id": group["channel_id"],
                "window_start": window_start,
                "window_end": window_end,
                "error": str(exc),
            })
    return summary


def extract_candidate_tickers(text):
    candidates = set()
    for alias, symbol in KNOWN_TICKER_ALIASES.items():
        if alias in text:
            candidates.add(symbol)
    for token in re.findall(r"(?<![A-Z0-9])\$?([A-Z]{1,6})(?![A-Z0-9])", text):
        if token in {"AI", "API", "ATM", "CEO", "CFO", "ETF", "IPO", "USD", "USA", "US", "Q1", "Q2", "Q3", "Q4"}:
            continue
        candidates.add(token)
    return sorted(candidates)


def quote_number(value):
    if value is None:
        return None
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None


def fetch_market_quotes(args, symbols):
    symbols = [symbol for symbol in dict.fromkeys(symbols) if symbol]
    if not symbols or not args.quote_endpoint:
        return []
    selected = symbols[: args.max_quote_symbols]
    try:
        if "stooq.com" in args.quote_endpoint:
            stooq_symbols = "+".join(f"{symbol.lower()}.us" for symbol in selected)
            query = urllib.parse.urlencode({"f": "sd2t2ohlcv", "h": "", "e": "csv"})
            url = f"{args.quote_endpoint.rstrip('/?')}/?s={urllib.parse.quote(stooq_symbols, safe='+.')}&{query}"
            req = urllib.request.Request(url, headers={"Accept": "text/csv", "User-Agent": HTTP_USER_AGENT})
            with urllib.request.urlopen(req, timeout=args.quote_timeout) as resp:
                text = resp.read().decode("utf-8", errors="replace")
            rows = csv.DictReader(io.StringIO(text))
            quotes = []
            for row in rows:
                symbol = clean_text(row.get("Symbol")).upper().removesuffix(".US")
                if not symbol or clean_text(row.get("Date")) == "N/D":
                    continue
                quotes.append({
                    "symbol": symbol,
                    "source": "stooq",
                    "date": clean_text(row.get("Date")),
                    "time": clean_text(row.get("Time")),
                    "open": quote_number(row.get("Open")),
                    "high": quote_number(row.get("High")),
                    "low": quote_number(row.get("Low")),
                    "price": quote_number(row.get("Close")),
                    "volume": quote_number(row.get("Volume")),
                })
            return quotes

        status, data = get_json(args.quote_endpoint, "", args.quote_timeout, params={"symbols": ",".join(selected)})
        if status >= 400:
            return []
        results = data.get("quoteResponse", {}).get("result", []) if isinstance(data, dict) else []
        quotes = []
        for item in results:
            symbol = clean_text(item.get("symbol"))
            if not symbol:
                continue
            quotes.append({
                "symbol": symbol,
                "source": "json_quote_api",
                "short_name": clean_text(item.get("shortName") or item.get("longName")),
                "currency": clean_text(item.get("currency")),
                "price": quote_number(item.get("regularMarketPrice")),
                "change_percent": quote_number(item.get("regularMarketChangePercent")),
                "market_cap": quote_number(item.get("marketCap")),
                "fifty_two_week_low": quote_number(item.get("fiftyTwoWeekLow")),
                "fifty_two_week_high": quote_number(item.get("fiftyTwoWeekHigh")),
                "forward_pe": quote_number(item.get("forwardPE")),
                "trailing_pe": quote_number(item.get("trailingPE")),
                "regular_market_time": iso_for_timestamp(item.get("regularMarketTime")),
            })
        return quotes
    except Exception as exc:
        append_jsonl(args.errors, {
            "at": now_iso(),
            "stage": "market_quotes",
            "symbols": selected,
            "error": str(exc),
        })
        return []


def build_l0_prompt(group, state_payload, window_start, window_end, market_quotes, max_reports):
    max_reports = max(1, int(max_reports or 1))
    payload = {
        "channel": group,
        "window": {
            "start": window_start,
            "end": window_end,
            "start_iso": iso_for_timestamp(window_start),
            "end_iso": iso_for_timestamp(window_end),
        },
        "generated_at": now_iso(),
        "l1_state": state_payload,
        "market_quotes": market_quotes,
        "max_reports": max_reports,
    }
    return f"""
You are the Codex investment review agent for the Zhishi US-stock feed.

You generate L0 reports that act as the user's L1 investment advice layer, based on L1 topic state extracted from L2 messages.

Return JSON only matching the provided schema.

Goal:
- Always review the sectors and individual stocks extracted by L1 topic state.
- Use current facts, search, and the provided market quote API payload when useful.
- Produce compact but decisive investment analysis: value-investing view, short-term trading strategy, catalysts, risk, invalidation, and action.
- Output actionable recommendations for each stock/sector worth covering.
- Return at most {max_reports} report(s). Prefer one consolidated hourly stock-analysis brief over many separate posts.
- Preserve references back to L2 source message ids through reports[].source_message_ids.

Rules:
- action=skip only when L1 has no investable ticker/sector/theme. Do not skip because the analysis is hard.
- If max_reports is 1, reports[] must contain exactly one consolidated report when action=post. This report must be a 个股分析 brief, not a single-theme deep research note.
- The first report title should start with "个股分析：" unless there is only one dominant sector and no individual stock can be named.
- The markdown must start with a "## 个股结论" section and include a compact table with these columns when individual tickers exist: 标的, 方向, 触发因素, 风险/失效, 短线动作, 中线动作.
- Cover every important named ticker/company from L1 up to a practical maximum of 8. Rank them by actionability. Do not hide secondary stocks inside generic sector prose.
- After the table, include "## 重点拆解" with 2-5 short subsections for the highest-signal tickers/themes. Only then add a "## 深研补充" section if a sector-level research angle is necessary.
- Use search for current facts and references; prefer primary filings, IR/news releases, reputable market data, and current price context.
- Include reference URLs in reports[].references.
- Tie each report back to source_state_ids and source_message_ids.
- Treat 🐯 and 🧀 as high-value investors. Their opinions are important evidence, but you still need to review price, valuation, catalysts, and risk.
- Do not include generic "not investment advice" disclaimers or responsibility-avoidance language. Be direct about buy/hold/watch/avoid, position sizing, entry/exit levels when the evidence supports it.
- Do not invent public facts, official roles, filings, quotes, earnings, or macro events. If search does not verify a factual claim with a credible source, either omit it or label it as group interpretation.
- When the group mentions a public figure or event in shorthand, do not extrapolate it into a current official role or policy change unless a cited source verifies that exact fact.
- Use exact dates for market/fundamental facts when they matter. The provided market_quotes payload is the trusted quote context for symbols it contains.
- Separate value-investing thesis from short-term strategy.
- Mark uncertainty as specific decision conditions, not generic caveats.
- Avoid generic background. Focus on what changed, why it matters, and what to do.
- Do not overproduce reports. When several tickers are related, group them in the table by theme, but still name the individual stocks and rank the highest-value actions.

Input:
{json.dumps(payload, ensure_ascii=False, indent=2)}
""".strip()


def normalize_l0_result(result, max_reports):
    max_reports = max(1, int(max_reports or 1))
    action = result.get("action")
    reason = bounded_text(result.get("reason"), 240)
    if action not in {"post", "skip"}:
        raise ValueError(f"invalid L0 action: {action}")
    if action == "skip":
        return {"action": "skip", "reports": [], "reason": reason}

    reports = []
    for report in result.get("reports") or []:
        if not isinstance(report, dict):
            continue
        title = bounded_text(report.get("title"), 120)
        summary = bounded_text(report.get("summary"), 500)
        markdown = clean_text(report.get("markdown"))
        topics = [bounded_text(topic, 40) for topic in report.get("topics") or [] if clean(topic)][:10]
        references = []
        for ref in report.get("references") or []:
            if not isinstance(ref, dict):
                continue
            url = clean(ref.get("url"))
            if not url:
                continue
            references.append({"title": bounded_text(ref.get("title") or url, 120), "url": url})
            if len(references) >= 10:
                break
        source_state_ids = [clean(item) for item in report.get("source_state_ids") or [] if clean(item)]
        source_message_ids = [clean(item) for item in report.get("source_message_ids") or [] if clean(item)]
        if title and markdown:
            reports.append({
                "title": title,
                "summary": summary,
                "markdown": markdown,
                "topics": topics,
                "references": references,
                "source_state_ids": source_state_ids,
                "source_message_ids": source_message_ids,
            })
        if len(reports) >= max_reports:
            break
    if not reports:
        return {"action": "skip", "reports": [], "reason": reason or "no valid L0 reports"}
    return {"action": "post", "reports": reports, "reason": reason}


def post_report(args, payload):
    if not args.cloud_reports_endpoint:
        append_jsonl(args.reports_out, {"at": now_iso(), "mode": "local", "payload": payload})
        return {"mode": "local", "status": None, "response": {}}
    status, response = post_json(args.cloud_reports_endpoint, args.cloud_api_key, payload, args.cloud_timeout)
    append_jsonl(args.reports_out, {"at": now_iso(), "mode": "cloud", "status": status, "payload": payload, "response": response})
    return {"mode": "cloud", "status": status, "response": response}


def run_l0(args, l1_states, window_start, window_end):
    summary = {"posted": 0, "skipped": 0, "failed": 0}
    if not args.run_l0:
        return summary
    for state_payload in l1_states:
        group = group_lookup().get(state_payload.get("channel_id"))
        if not group:
            continue
        try:
            ticker_text = json.dumps(state_payload, ensure_ascii=False)
            market_quotes = fetch_market_quotes(args, extract_candidate_tickers(ticker_text))
            prompt = build_l0_prompt(group, state_payload, window_start, window_end, market_quotes, args.l0_max_reports)
            out_path = args.codex_out_dir / f"l0_investment_{safe_filename(group['channel_id'])}_{window_start}_{window_end}.json"
            result = codex_exec_json(
                args,
                prompt,
                args.l0_schema,
                out_path,
                args.l0_codex_timeout,
                use_search=True,
                reasoning_effort=args.l0_reasoning_effort,
            )
            normalized = normalize_l0_result(result, args.l0_max_reports)
            if normalized["action"] == "skip":
                append_jsonl(args.reports_out, {
                    "at": now_iso(),
                    "mode": "skip",
                    "channel_id": group["channel_id"],
                    "level": "L0",
                    "window_start": window_start,
                    "window_end": window_end,
                    "reason": normalized["reason"],
                })
                summary["skipped"] += 1
                continue
            for index, report in enumerate(normalized["reports"], start=1):
                for output_channel in output_channels_for_group(group):
                    digest = hashlib.sha1(
                        f"{output_channel['channel_id']}|{window_start}|{window_end}|{index}".encode("utf-8")
                    ).hexdigest()
                    payload = {
                        "report_id": f"l0:{digest}",
                        "level": "L0",
                        "channel_id": output_channel["channel_id"],
                        "channel": output_channel["channel"],
                        "title": report["title"],
                        "summary": report["summary"],
                        "markdown": report["markdown"],
                        "topics": report["topics"],
                        "references": report["references"],
                        "window_start": window_start,
                        "window_end": window_end,
                        "source_state_ids": [f"l1:{output_channel['channel_id']}:{window_start}:{window_end}"],
                        "source_message_ids": report["source_message_ids"],
                        "generated_at": now_iso(),
                        "ordinal": index,
                    }
                    post_report(args, payload)
                    summary["posted"] += 1
        except Exception as exc:
            summary["failed"] += 1
            append_jsonl(args.errors, {
                "at": now_iso(),
                "stage": "l0_report",
                "channel_id": state_payload.get("channel_id"),
                "window_start": window_start,
                "window_end": window_end,
                "error": str(exc),
            })
    return summary


def run_intelligence(args):
    if args.dry_run or (not args.run_l1 and not args.run_l0):
        return {"window_start": None, "window_end": None, "l1": {"posted": 0, "skipped": 0, "failed": 0}, "l0": {"posted": 0, "skipped": 0, "failed": 0}}
    window_start, window_end = intelligence_window(args)
    all_messages = read_local_messages(args.out)
    l1_summary = run_l1(args, all_messages, window_start, window_end)
    l0_summary = run_l0(args, l1_summary.get("states", []), window_start, window_end)
    return {"window_start": window_start, "window_end": window_end, "l1": l1_summary, "l0": l0_summary}


def run_collector(args):
    if args.skip_collect:
        return
    cmd = [sys.executable, str(args.collector), "--once"]
    proc = subprocess.run(cmd, cwd=str(args.repo), capture_output=True, text=True, timeout=args.collect_timeout)
    if proc.stdout.strip():
        print(proc.stdout.strip())
    if proc.stderr.strip():
        print(proc.stderr.strip(), file=sys.stderr)
    if proc.returncode != 0:
        raise RuntimeError(f"collector exited {proc.returncode}")


def process(args):
    state = load_json(args.state, {"processed": [], "deleted": [], "failed": []})
    processed = set(state.get("processed") or [])
    deleted = set(state.get("deleted") or [])
    process_start = args.process_start
    process_end = args.process_end
    if args.process_window:
        process_start, process_end = intelligence_window(args)

    rows = read_raw_rows(args.input)
    candidates = []
    preprocessed_deleted = 0
    for raw in rows:
        raw_timestamp = normalize_timestamp(raw.get("timestamp"))
        if process_start and raw_timestamp < process_start:
            continue
        if process_end and raw_timestamp >= process_end:
            continue
        msg = clean_api_message(raw)
        if not msg:
            continue
        external_id = msg["external_id"]
        if external_id in processed or external_id in deleted:
            continue
        pre_delete_reason = preprocessing_delete_reason(raw)
        if pre_delete_reason:
            decision = {"action": "delete", "priority": None, "reason": pre_delete_reason}
            decision_row = {
                "external_id": msg["external_id"],
                "decided_at": now_iso(),
                "decision": decision,
                "username": msg["username"],
                "channel_id": msg["channel_id"],
                "channel": msg["channel"],
                "stage": "preprocess",
            }
            if args.dry_run:
                append_jsonl(args.dry_run_out, {"message": msg, "decision": decision})
            else:
                append_jsonl(args.decisions, decision_row)
                append_jsonl(args.rejected, {**decision_row, "message": msg})
                deleted.add(external_id)
            preprocessed_deleted += 1
            if args.max_messages and (len(candidates) + preprocessed_deleted) >= args.max_messages:
                break
            continue
        candidates.append((msg, raw))
        if args.max_messages and (len(candidates) + preprocessed_deleted) >= args.max_messages:
            break

    kept = 0
    removed = 0
    failed = 0
    for batch in chunked(candidates, args.decision_batch_size):
        try:
            batch_decisions = codex_batch_decisions(args, batch)
        except Exception as exc:
            failed += len(batch)
            append_jsonl(args.errors, {
                "at": now_iso(),
                "stage": "decision_batch",
                "count": len(batch),
                "error": str(exc),
                "external_ids": [msg["external_id"] for msg, _ in batch],
            })
            if args.stop_on_error:
                break
            continue

        for msg, raw in batch:
            try:
                decision = batch_decisions[msg["external_id"]]
                decision_row = {
                    "external_id": msg["external_id"],
                    "decided_at": now_iso(),
                    "decision": decision,
                    "username": msg["username"],
                    "channel_id": msg["channel_id"],
                    "channel": msg["channel"],
                }
                if args.dry_run:
                    append_jsonl(args.dry_run_out, {"message": msg, "decision": decision})
                    if decision["action"] == "delete":
                        removed += 1
                    else:
                        kept += 1
                    continue

                append_jsonl(args.decisions, decision_row)

                if decision["action"] == "delete":
                    deleted.add(msg["external_id"])
                    append_jsonl(args.rejected, {**decision_row, "message": msg})
                    removed += 1
                else:
                    msg["priority"] = decision["priority"]
                    try:
                        prepare_message_images(args, raw, msg)
                    except PreprocessDelete as exc:
                        decision = {"action": "delete", "priority": None, "reason": str(exc)}
                        decision_row = {
                            "external_id": msg["external_id"],
                            "decided_at": now_iso(),
                            "decision": decision,
                            "username": msg["username"],
                            "channel_id": msg["channel_id"],
                            "channel": msg["channel"],
                            "stage": "preprocess",
                        }
                        append_jsonl(args.decisions, decision_row)
                        append_jsonl(args.rejected, {**decision_row, "message": msg})
                        deleted.add(msg["external_id"])
                        removed += 1
                        continue
                    except Exception as exc:
                        failed += 1
                        append_jsonl(args.errors, {
                            "at": now_iso(),
                            "external_id": msg["external_id"],
                            "stage": "image_processing",
                            "error": str(exc),
                            "image_keys": image_keys_for_message(raw),
                        })
                        if args.stop_on_error:
                            break
                        continue
                    if not args.dry_run:
                        submit_result = submit_message(args, msg)
                        append_jsonl(args.submitted, {"at": now_iso(), "external_id": msg["external_id"], **submit_result})
                        processed.add(msg["external_id"])
                    kept += 1

                if not args.dry_run:
                    state["processed"] = sorted(processed)
                    state["deleted"] = sorted(deleted)
                    state["updated_at"] = now_iso()
                    save_json(args.state, state)
            except Exception as exc:
                failed += 1
                append_jsonl(args.errors, {
                    "at": now_iso(),
                    "external_id": msg["external_id"],
                    "stage": "process_message",
                    "error": str(exc),
                })
                if args.stop_on_error:
                    break
        if args.stop_on_error and failed:
            break

    if not args.dry_run:
        state["processed"] = sorted(processed)
        state["deleted"] = sorted(deleted)
        state["updated_at"] = now_iso()
        save_json(args.state, state)
        refresh_snapshots(args)

    return {
        "candidates": len(candidates),
        "kept": kept,
        "deleted": removed + preprocessed_deleted,
        "preprocessed_deleted": preprocessed_deleted,
        "failed": failed,
    }


def repair_local_image_markdown(args):
    summary = {"scanned": 0, "repaired": 0, "failed": 0, "skipped": 0}
    if args.dry_run or not args.repair_local_image_markdown:
        return summary
    if not args.cloud_msg_endpoint or not args.cloud_img_endpoint:
        return summary

    candidates = [
        msg for msg in read_local_messages(args.out)
        if markdown_image_sources(msg.get("content"))
    ]
    candidates.sort(key=lambda msg: (normalize_timestamp(msg.get("timestamp")), msg.get("external_id") or ""), reverse=True)
    if args.image_repair_limit:
        candidates = candidates[:args.image_repair_limit]

    for msg in candidates:
        summary["scanned"] += 1
        fixed = dict(msg)
        try:
            prepare_message_images(args, {"content": fixed.get("content")}, fixed)
            if fixed.get("content") == msg.get("content") and fixed.get("image_url") == msg.get("image_url"):
                summary["skipped"] += 1
                continue
            submit_result = submit_message(args, fixed)
            append_jsonl(args.submitted, {
                "at": now_iso(),
                "external_id": fixed["external_id"],
                "stage": "image_markdown_repair",
                **submit_result,
            })
            summary["repaired"] += 1
        except PreprocessDelete as exc:
            summary["skipped"] += 1
            append_jsonl(args.errors, {
                "at": now_iso(),
                "external_id": msg.get("external_id"),
                "stage": "image_markdown_repair",
                "skipped": True,
                "error": str(exc),
            })
        except Exception as exc:
            summary["failed"] += 1
            error = str(exc)
            lower_error = error.lower()
            append_jsonl(args.errors, {
                "at": now_iso(),
                "external_id": msg.get("external_id"),
                "stage": "image_markdown_repair",
                "error": error,
                "image_keys": image_keys_for_message({"content": msg.get("content")}),
            })
            if "connection refused" in lower_error or "dial tcp" in lower_error or args.stop_on_error:
                break
    if summary["repaired"]:
        refresh_snapshots(args)
    return summary


def parse_args():
    repo = Path(__file__).resolve().parents[1]
    out_dir = repo / "exports" / "follow_three_groups_jsonl"
    load_env_file(out_dir / "cloud.env")
    cloud_msg_endpoint = os.environ.get("CLOUD_MSG_ENDPOINT", "")
    parser = argparse.ArgumentParser(description="Collect, clean, Codex-filter, and assemble API messages.")
    parser.add_argument("--repo", type=Path, default=repo)
    parser.add_argument("--input", type=Path, default=out_dir / "new_messages.jsonl")
    parser.add_argument("--collector", type=Path, default=repo / "scripts" / "follow_three_groups_chatlog_cli.py")
    parser.add_argument("--state", type=Path, default=out_dir / "pipeline_state.json")
    parser.add_argument("--lock", type=Path, default=out_dir / "pipeline.lock")
    parser.add_argument("--stale-lock-seconds", type=int, default=int(os.environ.get("STALE_LOCK_SECONDS", "7200")))
    parser.add_argument("--out", type=Path, default=out_dir / "api_messages.jsonl")
    parser.add_argument("--api-snapshot", type=Path, default=out_dir / "api_messages.json")
    parser.add_argument("--channels-snapshot", type=Path, default=out_dir / "api_channels.json")
    parser.add_argument("--decisions", type=Path, default=out_dir / "codex_decisions.jsonl")
    parser.add_argument("--rejected", type=Path, default=out_dir / "rejected_messages.jsonl")
    parser.add_argument("--submitted", type=Path, default=out_dir / "submitted_messages.jsonl")
    parser.add_argument("--states-out", type=Path, default=out_dir / "l1_states.jsonl")
    parser.add_argument("--reports-out", type=Path, default=out_dir / "l0_reports.jsonl")
    parser.add_argument("--errors", type=Path, default=out_dir / "pipeline_errors.jsonl")
    parser.add_argument("--dry-run-out", type=Path, default=out_dir / "dry_run_api_messages.jsonl")
    parser.add_argument("--decision-schema", type=Path, default=repo / "scripts" / "codex_message_decision.schema.json")
    parser.add_argument("--batch-decision-schema", type=Path, default=repo / "scripts" / "codex_message_decisions_batch.schema.json")
    parser.add_argument("--image-caption-schema", type=Path, default=repo / "scripts" / "codex_image_caption.schema.json")
    parser.add_argument("--l1-schema", type=Path, default=repo / "scripts" / "codex_l1_state.schema.json")
    parser.add_argument("--l0-schema", type=Path, default=repo / "scripts" / "codex_l0_reports.schema.json")
    parser.add_argument("--codex-bin", default=os.environ.get("CODEX_BIN", "/opt/homebrew/bin/codex"))
    parser.add_argument("--codex-model", default=os.environ.get("CODEX_MODEL", "gpt-5.5"))
    parser.add_argument("--codex-reasoning-effort", default=os.environ.get("CODEX_REASONING_EFFORT", "low"))
    parser.add_argument("--image-reasoning-effort", default=os.environ.get("IMAGE_REASONING_EFFORT", "low"))
    parser.add_argument("--l1-reasoning-effort", default=os.environ.get("L1_REASONING_EFFORT", "medium"))
    parser.add_argument("--l0-reasoning-effort", default=os.environ.get("L0_REASONING_EFFORT", "high"))
    parser.add_argument("--codex-timeout", type=int, default=int(os.environ.get("CODEX_TIMEOUT", "180")))
    parser.add_argument("--image-codex-timeout", type=int, default=int(os.environ.get("IMAGE_CODEX_TIMEOUT", "180")))
    parser.add_argument("--l1-codex-timeout", type=int, default=int(os.environ.get("L1_CODEX_TIMEOUT", "300")))
    parser.add_argument("--l0-codex-timeout", type=int, default=int(os.environ.get("L0_CODEX_TIMEOUT", "900")))
    parser.add_argument("--codex-out-dir", type=Path, default=out_dir / "codex_outputs")
    parser.add_argument("--decision-mode", choices=["codex", "heuristic"], default=os.environ.get("DECISION_MODE", "codex"))
    parser.add_argument("--decision-batch-size", type=int, default=int(os.environ.get("DECISION_BATCH_SIZE", "1")))
    parser.add_argument("--chatlog-bin", default=os.environ.get("CHATLOG_BIN", "/opt/homebrew/bin/chatlog"))
    parser.add_argument("--chatlog-addr", default=os.environ.get("CHATLOG_ADDR", "127.0.0.1:5030"))
    parser.add_argument("--chatlog-timeout", type=int, default=int(os.environ.get("CHATLOG_TIMEOUT", "30")))
    parser.add_argument("--cloud-msg-endpoint", default=cloud_msg_endpoint)
    parser.add_argument("--cloud-img-endpoint", default=os.environ.get("CLOUD_IMG_ENDPOINT", ""))
    parser.add_argument(
        "--cloud-state-endpoint",
        default=os.environ.get("CLOUD_STATE_ENDPOINT", derive_cloud_endpoint(cloud_msg_endpoint, "channel-state")),
    )
    parser.add_argument(
        "--cloud-reports-endpoint",
        default=os.environ.get("CLOUD_REPORTS_ENDPOINT", derive_cloud_endpoint(cloud_msg_endpoint, "reports")),
    )
    parser.add_argument("--cloud-api-key", default=os.environ.get("CLOUD_API_KEY", ""))
    parser.add_argument("--cloud-timeout", type=int, default=int(os.environ.get("CLOUD_TIMEOUT", "30")))
    parser.add_argument(
        "--quote-endpoint",
        default=os.environ.get("QUOTE_ENDPOINT", "https://stooq.com/q/l/"),
    )
    parser.add_argument("--quote-timeout", type=int, default=int(os.environ.get("QUOTE_TIMEOUT", "15")))
    parser.add_argument("--max-quote-symbols", type=int, default=int(os.environ.get("MAX_QUOTE_SYMBOLS", "16")))
    parser.add_argument("--l0-max-reports", type=int, default=int(os.environ.get("L0_MAX_REPORTS", "1")))
    parser.add_argument("--collect-timeout", type=int, default=120)
    parser.add_argument("--max-messages", type=int, default=int(os.environ.get("MAX_MESSAGES_PER_RUN", "0")))
    parser.add_argument("--window-seconds", type=int, default=int(os.environ.get("WINDOW_SECONDS", "3600")))
    parser.add_argument("--window-start", type=int, default=int(os.environ.get("WINDOW_START", "0") or "0"))
    parser.add_argument("--window-end", type=int, default=int(os.environ.get("WINDOW_END", "0") or "0"))
    parser.add_argument("--window-align-hour", dest="window_align_hour", action="store_true", default=bool_env("WINDOW_ALIGN_HOUR", True))
    parser.add_argument("--no-window-align-hour", dest="window_align_hour", action="store_false")
    parser.add_argument("--process-start", type=int, default=int(os.environ.get("PROCESS_START", "0") or "0"))
    parser.add_argument("--process-end", type=int, default=int(os.environ.get("PROCESS_END", "0") or "0"))
    parser.add_argument("--process-window", action="store_true", default=bool_env("PROCESS_WINDOW", False))
    parser.add_argument("--run-l1", dest="run_l1", action="store_true", default=bool_env("RUN_L1", True))
    parser.add_argument("--skip-l1", dest="run_l1", action="store_false")
    parser.add_argument("--run-l0", dest="run_l0", action="store_true", default=bool_env("RUN_L0", True))
    parser.add_argument("--skip-l0", dest="run_l0", action="store_false")
    parser.add_argument("--l1-max-messages", type=int, default=int(os.environ.get("L1_MAX_MESSAGES", "120")))
    parser.add_argument("--l1-patch-retries", type=int, default=int(os.environ.get("L1_PATCH_RETRIES", "2")))
    parser.add_argument("--disable-cloud-previous-state", action="store_true", default=bool_env("DISABLE_CLOUD_PREVIOUS_STATE", False))
    parser.add_argument("--repair-local-image-markdown", dest="repair_local_image_markdown", action="store_true", default=bool_env("REPAIR_LOCAL_IMAGE_MARKDOWN", False))
    parser.add_argument("--skip-repair-local-image-markdown", dest="repair_local_image_markdown", action="store_false")
    parser.add_argument("--image-repair-limit", type=int, default=int(os.environ.get("IMAGE_REPAIR_LIMIT", "30")))
    parser.add_argument("--skip-collect", action="store_true")
    parser.add_argument("--skip-processing", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--stop-on-error", action="store_true")
    args = parser.parse_args()
    args.repo = args.repo.resolve()
    if args.cloud_msg_endpoint:
        if not args.cloud_state_endpoint:
            args.cloud_state_endpoint = derive_cloud_endpoint(args.cloud_msg_endpoint, "channel-state")
        if not args.cloud_reports_endpoint:
            args.cloud_reports_endpoint = derive_cloud_endpoint(args.cloud_msg_endpoint, "reports")
    return args


def main():
    args = parse_args()
    if not acquire_lock(args.lock, args.stale_lock_seconds):
        print(f"{now_iso()} pipeline already running: {args.lock}")
        return 0
    try:
        run_collector(args)
        if args.skip_processing:
            summary = {"candidates": 0, "kept": 0, "deleted": 0, "preprocessed_deleted": 0, "failed": 0}
            if not args.dry_run:
                refresh_snapshots(args)
        else:
            summary = process(args)
        image_repair = repair_local_image_markdown(args)
        intelligence = run_intelligence(args)
        print(
            f"{now_iso()} pipeline candidates={summary['candidates']} "
            f"kept={summary['kept']} deleted={summary['deleted']} "
            f"preprocessed_deleted={summary['preprocessed_deleted']} failed={summary['failed']} "
            f"image_repaired={image_repair['repaired']} image_repair_failed={image_repair['failed']}"
        )
        if intelligence["window_start"] is not None:
            print(
                f"{now_iso()} intelligence window={intelligence['window_start']}..{intelligence['window_end']} "
                f"l1_posted={intelligence['l1']['posted']} l1_skipped={intelligence['l1']['skipped']} "
                f"l1_failed={intelligence['l1']['failed']} l0_posted={intelligence['l0']['posted']} "
                f"l0_skipped={intelligence['l0']['skipped']} l0_failed={intelligence['l0']['failed']}"
            )
        failed = summary["failed"] + image_repair["failed"] + intelligence["l1"]["failed"] + intelligence["l0"]["failed"]
        return 1 if failed and args.stop_on_error else 0
    finally:
        release_lock(args.lock)


if __name__ == "__main__":
    raise SystemExit(main())
