from concurrent.futures import ThreadPoolExecutor, as_completed

from ..config import get_requests_session
from ..models import CollectedItem

BASE_URL = "https://hacker-news.firebaseio.com/v0"


class HackerNewsCollector:
    """Hacker News APIからトップ/ベストストーリーを収集する"""

    def __init__(self, max_items: int = 20):
        self.max_items = max_items
        self.session = get_requests_session()

    def collect(self) -> list[CollectedItem]:
        """トップストーリーとベストストーリーの和集合から上位を取得"""
        top_ids = self._fetch_story_ids("topstories")
        best_ids = self._fetch_story_ids("beststories")

        # 重複排除して上位を取得
        seen = set()
        merged_ids = []
        for sid in top_ids + best_ids:
            if sid not in seen:
                seen.add(sid)
                merged_ids.append(sid)
            if len(merged_ids) >= self.max_items:
                break

        items = self._fetch_items_parallel(merged_ids)
        # スコア順にソート
        items.sort(key=lambda x: x.score, reverse=True)
        return items[:self.max_items]

    def _fetch_story_ids(self, endpoint: str) -> list[int]:
        try:
            resp = self.session.get(f"{BASE_URL}/{endpoint}.json", timeout=10)
            resp.raise_for_status()
            return resp.json()[:self.max_items]
        except Exception as e:
            print(f"[HN] {endpoint} の取得に失敗: {e}")
            return []

    def _fetch_items_parallel(self, ids: list[int]) -> list[CollectedItem]:
        items = []
        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = {executor.submit(self._fetch_item, sid): sid for sid in ids}
            for future in as_completed(futures):
                item = future.result()
                if item:
                    items.append(item)
        return items

    def _fetch_item(self, item_id: int) -> CollectedItem | None:
        try:
            resp = self.session.get(f"{BASE_URL}/item/{item_id}.json", timeout=10)
            resp.raise_for_status()
            data = resp.json()
            if not data or data.get("type") != "story":
                return None
            return CollectedItem(
                source="hackernews",
                title=data.get("title", ""),
                url=data.get("url", f"https://news.ycombinator.com/item?id={item_id}"),
                description=f"Points: {data.get('score', 0)}, Comments: {data.get('descendants', 0)}",
                score=data.get("score", 0),
            )
        except requests.RequestException:
            return None
