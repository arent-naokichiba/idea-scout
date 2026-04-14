from dataclasses import dataclass, field


@dataclass
class CollectedItem:
    """収集された1件の情報"""
    source: str  # "hackernews", "github", "arxiv"
    title: str
    url: str
    description: str = ""
    score: int = 0  # ソース内でのスコア（HNポイント、GitHub stars等）
    tags: list[str] = field(default_factory=list)


@dataclass
class AnalyzedItem:
    """AI分析済みの1件の情報"""
    source: str
    title: str
    url: str
    summary_ja: str  # 日本語要約
    category: str  # AI, Web, DevTools, BIM/CAD, etc.
    relevance_score: int  # 1-5: ユーザー専門領域との関連性
    idea_comment: str = ""  # 開発ネタとしての可能性コメント（関連性3以上）
