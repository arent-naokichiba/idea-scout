"""Idea Scout - 開発ネタ発掘ツール

技術トレンドを複数ソースから収集し、JSON中間ファイルに保存する。
分析・レポート生成はClaude Codeセッション内で行う想定。

Usage:
    python main.py              # 収集してJSON出力
    python main.py --full       # 収集 + API分析 + レポート（API key必要）
"""

import argparse
import json
import os
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

from idea_scout.collectors import HackerNewsCollector, GitHubTrendingCollector, ArXivCollector
from idea_scout.analyzer import ClaudeAnalyzer
from idea_scout.reporter import MarkdownReporter


def collect_all() -> list:
    """全ソースから情報を収集する"""
    collectors = [
        ("Hacker News", HackerNewsCollector(max_items=20)),
        ("GitHub Trending", GitHubTrendingCollector(max_items=15)),
        ("arXiv", ArXivCollector(max_items=15)),
    ]

    all_items = []
    for name, collector in collectors:
        print(f"[収集中] {name}...")
        try:
            items = collector.collect()
            print(f"  → {len(items)}件取得")
            all_items.extend(items)
        except Exception as e:
            print(f"  → エラー: {e}")

    return all_items


def save_collected(items, output_dir: str) -> str:
    """収集結果をJSONファイルに保存する"""
    os.makedirs(output_dir, exist_ok=True)
    date_str = datetime.now().strftime("%Y-%m-%d")
    filepath = os.path.join(output_dir, f"{date_str}_collected.json")

    data = {
        "date": date_str,
        "collected_at": datetime.now().isoformat(),
        "total": len(items),
        "items": [asdict(item) for item in items],
    }

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    return filepath


def main():
    parser = argparse.ArgumentParser(description="Idea Scout - 開発ネタ発掘ツール")
    parser.add_argument("--full", action="store_true", help="収集 + API分析 + レポート生成（ANTHROPIC_API_KEY必要）")
    args = parser.parse_args()

    load_dotenv()

    print("=" * 60)
    print(f"Idea Scout - {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 60)

    # 1. 収集
    items = collect_all()
    print(f"\n[合計] {len(items)}件収集")

    if not items:
        print("収集結果が0件のため終了します。")
        sys.exit(1)

    # 2. JSON保存（常に実行）
    data_dir = str(Path(__file__).parent / "data")
    json_path = save_collected(items, data_dir)
    print(f"\n[保存] {json_path}")

    # --full: API分析 + レポート生成
    if args.full:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            print("\n[エラー] ANTHROPIC_API_KEY が設定されていません。")
            sys.exit(1)

        print("\n[分析中] Claude APIで分析しています...")
        analyzer = ClaudeAnalyzer(api_key=api_key)
        analyzed = analyzer.analyze(items)
        print(f"  → {len(analyzed)}件分析完了")

        reports_dir = str(Path(__file__).parent / "reports")
        reporter = MarkdownReporter(output_dir=reports_dir)
        filepath = reporter.generate(analyzed)
        print(f"\nレポート生成完了: {filepath}")
        return

    # デフォルト: 収集結果のサマリー表示
    print(f"\n[次のステップ]")
    print(f"  Claude Codeで以下を実行してください:")
    print(f"  「{json_path} を分析してレポートを生成して」")


if __name__ == "__main__":
    main()
