import json

import anthropic

from .models import CollectedItem, AnalyzedItem

USER_PROFILE = """
ユーザーの専門領域:
- BIM/CAD/建築IT分野のソフトウェア開発者
- Revitアドイン開発（C#）、IFC関連の調査・開発経験
- AI/LLMを活用したツール開発に積極的
- 業務効率化ツールの開発にも関心がある
"""

ANALYSIS_PROMPT = """あなたは技術トレンドアナリストです。以下の技術ニュース/リポジトリ/論文のリストを分析してください。

## ユーザープロファイル
{user_profile}

## 分析対象
{items_json}

## 指示
各項目について以下をJSON配列で返してください。JSON以外は出力しないでください。

各要素のフォーマット:
{{
  "index": (項目のインデックス, 0始まり),
  "summary_ja": "(日本語で1-2行の要約)",
  "category": "(以下から1つ: AI, Web, DevTools, Data, Security, BIM/CAD, Infrastructure, Other)",
  "relevance_score": (1-5の整数。ユーザーの専門領域との関連性。5=直接関連、1=無関係),
  "idea_comment": "(関連性3以上の場合のみ。このネタからどんな開発ができそうか、日本語で1-2文)"
}}
"""


class ClaudeAnalyzer:
    """Claude APIで収集データを分析する"""

    def __init__(self, api_key: str, model: str = "claude-haiku-4-5-20251001"):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model

    def analyze(self, items: list[CollectedItem]) -> list[AnalyzedItem]:
        if not items:
            return []

        # バッチサイズで分割（1回のAPI呼び出しで処理する件数）
        batch_size = 25
        all_analyzed = []

        for i in range(0, len(items), batch_size):
            batch = items[i:i + batch_size]
            analyzed = self._analyze_batch(batch, offset=i)
            all_analyzed.extend(analyzed)

        return all_analyzed

    def _analyze_batch(self, items: list[CollectedItem], offset: int = 0) -> list[AnalyzedItem]:
        items_for_prompt = []
        for idx, item in enumerate(items):
            items_for_prompt.append({
                "index": idx,
                "source": item.source,
                "title": item.title,
                "url": item.url,
                "description": item.description[:200],
                "tags": item.tags,
            })

        prompt = ANALYSIS_PROMPT.format(
            user_profile=USER_PROFILE,
            items_json=json.dumps(items_for_prompt, ensure_ascii=False, indent=2),
        )

        try:
            response = self.client.messages.create(
                model=self.model,
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            )

            response_text = response.content[0].text.strip()
            # JSON部分を抽出（```json ... ``` で囲まれている場合の対応）
            if "```" in response_text:
                start = response_text.find("[")
                end = response_text.rfind("]") + 1
                response_text = response_text[start:end]

            analyses = json.loads(response_text)

            analyzed_items = []
            for analysis in analyses:
                idx = analysis["index"]
                if idx >= len(items):
                    continue
                item = items[idx]
                analyzed_items.append(AnalyzedItem(
                    source=item.source,
                    title=item.title,
                    url=item.url,
                    summary_ja=analysis.get("summary_ja", ""),
                    category=analysis.get("category", "Other"),
                    relevance_score=analysis.get("relevance_score", 1),
                    idea_comment=analysis.get("idea_comment", ""),
                ))

            return analyzed_items

        except Exception as e:
            print(f"[Analyzer] 分析に失敗: {e}")
            # フォールバック: 分析なしで返す
            return [
                AnalyzedItem(
                    source=item.source,
                    title=item.title,
                    url=item.url,
                    summary_ja="(分析失敗)",
                    category="Other",
                    relevance_score=1,
                )
                for item in items
            ]
