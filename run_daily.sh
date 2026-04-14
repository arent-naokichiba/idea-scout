#!/bin/bash
# Idea Scout 日次実行スクリプト
# 手動テスト: bash run_daily.sh
# タスクスケジューラ: bash C:/Users/ChibaNaoki/NewDevelop/0318_開発ネタ発掘ツール/src/run_daily.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"

# ログ出力（stdoutとファイル両方）
exec > >(tee -a "$LOG_FILE") 2>&1

export IDEA_SCOUT_SSL_VERIFY=false

TODAY=$(date +%Y-%m-%d)

echo "========================================"
echo "[$(date)] Idea Scout 日次実行開始"
echo "========================================"

# 1. 収集（Python）
echo "[$(date)] Step 1: 収集..."
python main.py
echo "[$(date)] 収集完了"

# 最新のcollectedファイルを特定
LATEST_JSON=$(ls -t data/*_collected.json 2>/dev/null | head -1)
if [ -z "$LATEST_JSON" ]; then
    echo "[$(date)] エラー: 収集データが見つかりません"
    exit 1
fi
echo "[$(date)] 収集データ: $LATEST_JSON"

# 2. 指示ファイルを読み込み、変数を置換してプロンプト生成
PROMPT_TEMPLATE="$SCRIPT_DIR/prompts/daily_analysis.md"
if [ ! -f "$PROMPT_TEMPLATE" ]; then
    echo "[$(date)] エラー: 指示ファイルが見つかりません: $PROMPT_TEMPLATE"
    exit 1
fi

PROMPT=$(cat "$PROMPT_TEMPLATE" \
    | sed "s|{{DATA_JSON}}|$SCRIPT_DIR/$LATEST_JSON|g" \
    | sed "s|{{REPORT_PATH}}|$SCRIPT_DIR/reports/${TODAY}.md|g" \
    | sed "s|{{DATE}}|${TODAY}|g")

echo "[$(date)] Step 2: Claude Code で分析..."
echo "$PROMPT" | claude -p \
  --add-dir "$SCRIPT_DIR" \
  --allowedTools "Read,Write,Glob" \
  --dangerously-skip-permissions

echo "[$(date)] ========================================"
echo "[$(date)] 完了！レポート: reports/${TODAY}.md"
echo "[$(date)] ========================================"
