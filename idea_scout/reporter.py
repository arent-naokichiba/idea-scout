import os
from datetime import datetime

from .models import AnalyzedItem

SOURCE_LABEL = {
    "hackernews": "Hacker News",
    "github": "GitHub Trending",
    "arxiv": "arXiv",
}


class MarkdownReporter:
    """分析結果をMarkdownレポートとして出力する"""

    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        os.makedirs(output_dir, exist_ok=True)

    def generate(self, items: list[AnalyzedItem], date: datetime | None = None) -> str:
        date = date or datetime.now()
        date_str = date.strftime("%Y-%m-%d")

        lines = [
            f"# Idea Scout Daily Report - {date_str}",
            "",
            f"生成日時: {date.strftime('%Y-%m-%d %H:%M')}",
            "",
        ]

        # 注目ネタ（関連性3以上）
        high_relevance = [i for i in items if i.relevance_score >= 3]
        if high_relevance:
            high_relevance.sort(key=lambda x: x.relevance_score, reverse=True)
            lines.append("## 注目の開発ネタ候補")
            lines.append("")
            for item in high_relevance:
                stars = "★" * item.relevance_score
                lines.append(f"### {stars} [{item.title}]({item.url})")
                lines.append(f"- **ソース**: {SOURCE_LABEL.get(item.source, item.source)} | **カテゴリ**: {item.category}")
                lines.append(f"- **要約**: {item.summary_ja}")
                if item.idea_comment:
                    lines.append(f"- **開発ネタ**: {item.idea_comment}")
                lines.append("")

        # ソース別一覧
        for source_key, source_name in SOURCE_LABEL.items():
            source_items = [i for i in items if i.source == source_key]
            if not source_items:
                continue

            lines.append(f"## {source_name}")
            lines.append("")
            lines.append("| 関連性 | タイトル | カテゴリ | 要約 |")
            lines.append("|:---:|---|---|---|")

            for item in source_items:
                relevance = "★" * item.relevance_score + "☆" * (5 - item.relevance_score)
                title_link = f"[{item.title}]({item.url})"
                # テーブル内の改行を防ぐ
                summary = item.summary_ja.replace("\n", " ").replace("|", "\\|")
                lines.append(f"| {relevance} | {title_link} | {item.category} | {summary} |")

            lines.append("")

        # 統計
        lines.append("## 統計")
        lines.append("")
        lines.append(f"- 総収集数: {len(items)}")
        lines.append(f"- 注目ネタ候補（関連性3以上）: {len(high_relevance) if high_relevance else 0}")
        by_source = {}
        for item in items:
            by_source[item.source] = by_source.get(item.source, 0) + 1
        for src, count in by_source.items():
            lines.append(f"- {SOURCE_LABEL.get(src, src)}: {count}件")
        lines.append("")

        content = "\n".join(lines)

        # ファイル出力
        filepath = os.path.join(self.output_dir, f"{date_str}.md")
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)

        print(f"[Reporter] レポート出力: {filepath}")
        return filepath
