import time
import xml.etree.ElementTree as ET

from ..config import get_requests_session
from ..models import CollectedItem

ARXIV_API_URL = "http://export.arxiv.org/api/query"
DEFAULT_CATEGORIES = ["cs.AI", "cs.SE", "cs.HC"]

# Atom XML名前空間
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}


class ArXivCollector:
    """arXiv APIから最新論文を収集する（HTTP直接アクセス版）"""

    def __init__(self, categories: list[str] | None = None, max_items: int = 15):
        self.categories = categories or DEFAULT_CATEGORIES
        self.max_items = max_items
        self.session = get_requests_session()

    def collect(self) -> list[CollectedItem]:
        items = []
        per_category = max(1, self.max_items // len(self.categories))

        for i, cat in enumerate(self.categories):
            if i > 0:
                time.sleep(3)
            new_items = self._search_category(cat, per_category)
            items.extend(new_items)

        # 重複排除
        seen = set()
        unique = []
        for item in items:
            if item.url not in seen:
                seen.add(item.url)
                unique.append(item)

        return unique[:self.max_items]

    def _search_category(self, category: str, max_results: int) -> list[CollectedItem]:
        for attempt in range(3):
            try:
                resp = self.session.get(
                    ARXIV_API_URL,
                    params={
                        "search_query": f"cat:{category}",
                        "sortBy": "submittedDate",
                        "sortOrder": "descending",
                        "start": 0,
                        "max_results": max_results,
                    },
                    timeout=30,
                )
                resp.raise_for_status()
                return self._parse_atom(resp.text, category)
            except Exception as e:
                if attempt < 2:
                    time.sleep(5 * (attempt + 1))
                else:
                    print(f"[arXiv] {category} の取得に失敗: {e}")
        return []

    def _parse_atom(self, xml_text: str, default_category: str) -> list[CollectedItem]:
        items = []
        try:
            root = ET.fromstring(xml_text)
            for entry in root.findall("atom:entry", NS):
                title_elem = entry.find("atom:title", NS)
                title = title_elem.text.strip().replace("\n", " ") if title_elem is not None and title_elem.text else ""

                id_elem = entry.find("atom:id", NS)
                url = id_elem.text.strip() if id_elem is not None and id_elem.text else ""

                summary_elem = entry.find("atom:summary", NS)
                summary = summary_elem.text.strip()[:300] if summary_elem is not None and summary_elem.text else ""

                # カテゴリタグ
                tags = [default_category]
                for cat_elem in entry.findall("atom:category", NS):
                    term = cat_elem.get("term", "")
                    if term and term != default_category:
                        tags.append(term)

                items.append(CollectedItem(
                    source="arxiv",
                    title=title,
                    url=url,
                    description=summary,
                    score=0,
                    tags=tags[:4],
                ))
        except ET.ParseError as e:
            print(f"[arXiv] XMLパースエラー: {e}")
        return items
