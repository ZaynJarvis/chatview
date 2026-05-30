#!/bin/sh
set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$REPO/exports/follow_three_groups_jsonl"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$OUT_DIR"
cd "$REPO" || exit 1

rotate_log() {
  file="$1"
  max_bytes="${2:-10485760}"
  keep="${3:-10}"

  [ -f "$file" ] || return 0
  size="$(wc -c < "$file" 2>/dev/null || printf '0')"
  [ "$size" -lt "$max_bytes" ] && return 0

  i=$((keep - 1))
  while [ "$i" -ge 1 ]; do
    if [ -f "$file.$i" ]; then
      mv "$file.$i" "$file.$((i + 1))"
    fi
    i=$((i - 1))
  done
  mv "$file" "$file.1"
  : > "$file"
}

export CHATLOG_BIN="${CHATLOG_BIN:-/opt/homebrew/bin/chatlog}"
export CODEX_BIN="${CODEX_BIN:-/opt/homebrew/bin/codex}"
export CODEX_MODEL="${CODEX_MODEL:-gpt-5.5}"
export CODEX_REASONING_EFFORT="${CODEX_REASONING_EFFORT:-low}"
export L1_REASONING_EFFORT="${L1_REASONING_EFFORT:-medium}"
export L0_REASONING_EFFORT="${L0_REASONING_EFFORT:-high}"
export L0_MAX_REPORTS="${L0_MAX_REPORTS:-1}"
export DECISION_BATCH_SIZE="${DECISION_BATCH_SIZE:-20}"
export RUN_L1="${RUN_L1:-1}"
export RUN_L0="${RUN_L0:-1}"
export REPAIR_LOCAL_IMAGE_MARKDOWN="${REPAIR_LOCAL_IMAGE_MARKDOWN:-0}"
export WINDOW_ALIGN_HOUR="${WINDOW_ALIGN_HOUR:-1}"
export STALE_LOCK_SECONDS="${STALE_LOCK_SECONDS:-7200}"

if [ -f "$OUT_DIR/cloud.env" ]; then
  . "$OUT_DIR/cloud.env"
fi

rotate_log "$OUT_DIR/cron.log" "${LOG_MAX_BYTES:-10485760}" "${LOG_KEEP:-10}"

exec /usr/bin/python3 "$REPO/scripts/process_three_groups_api_pipeline.py" >> "$OUT_DIR/cron.log" 2>&1
