"""Claude Codeセッション内で分析を依頼する際のプロンプトテンプレートを生成する。

Usage:
    python -m idea_scout.analyze_prompt data/2026-03-18_collected.json
    → 分析用プロンプトをクリップボードにコピー or 標準出力
"""

import json
import sys
from pathlib import Path


USER_PROFILE = """\
ユーザーの専門領域:
- BIM/CAD/建築IT分野のソフトウェア開発者
- Revitアドイン開発（C#）、IFC関連の調査・開発経験
- AI/LLMを活用したツール開発に積極的
- 業務効率化ツールの開発にも関心がある
"""

PROMPT_TEMPLATE = """\
以下は今日の技術トレンド収集結果（{total}件）です。
分析してMarkdownレポートを生成してください。

## あなたの役割
技術トレンドアナリストとして、各項目を分析し開発ネタを発掘してください。

## ユーザープロファイル
{user_profile}

## 分析指示
各項目について以下を判定してください:
1. **日本語要約**（1-2行）
2. **カテゴリ**（AI, Web, DevTools, Data, Security, BIM/CAD, Infrastructure, Other）
3. **関連性スコア**（1-5: ユーザー専門領域との関連性）
4. **開発ネタコメント**（関連性3以上の場合：このネタからどんなツール開発ができそうか）

## 出力フォーマット
以下の形式でMarkdownレポートを生成し、`{report_path}` に保存してください。

```
# Idea Scout Daily Report - {date}

## 注目の開発ネタ候補
（関連性3以上の項目を関連性順に並べる）

### ★★★★★ [タイトル](URL)
- **ソース**: xxx | **カテゴリ**: xxx
- **要約**: xxx
- **開発ネタ**: xxx

## Hacker News / GitHub Trending / arXiv
（ソース別テーブル）

## 統計
```

## 収集データ
{items_json}
"""


def generate_prompt(json_path: str) -> str:
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    date = data["date"]
    items = data["items"]

    # 見やすいように整形
    items_summary = []
    for i, item in enumerate(items):
        items_summary.append({
            "no": i + 1,
            "source": item["source"],
            "title": item["title"],
            "url": item["url"],
            "description": item.get("description", "")[:200],
            "score": item.get("score", 0),
            "tags": item.get("tags", []),
        })

    src_dir = Path(__file__).parent.parent
    report_path = src_dir / "reports" / f"{date}.md"

    return PROMPT_TEMPLATE.format(
        total=len(items),
        user_profile=USER_PROFILE,
        date=date,
        report_path=report_path,
        items_json=json.dumps(items_summary, ensure_ascii=False, indent=2),
    )


def main():
    if len(sys.argv) < 2:
        # 最新のcollectedファイルを自動検出
        data_dir = Path(__file__).parent.parent / "data"
        json_files = sorted(data_dir.glob("*_collected.json"), reverse=True)
        if not json_files:
            print("収集データが見つかりません。先に python main.py を実行してください。")
            sys.exit(1)
        json_path = str(json_files[0])
        print(f"[自動検出] {json_path}", file=sys.stderr)
    else:
        json_path = sys.argv[1]

    prompt = generate_prompt(json_path)
    print(prompt)


if __name__ == "__main__":
    main()
