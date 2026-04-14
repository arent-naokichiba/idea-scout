from bs4 import BeautifulSoup

from ..config import get_requests_session
from ..models import CollectedItem

GITHUB_TRENDING_URL = "https://github.com/trending"


class GitHubTrendingCollector:
    """GitHub Trendingページをスクレイピングして注目リポジトリを収集する"""

    def __init__(self, languages: list[str] | None = None, max_items: int = 15):
        self.languages = languages or ["", "python", "csharp", "typescript"]
        self.max_items = max_items
        self.session = get_requests_session()

    def collect(self) -> list[CollectedItem]:
        seen_repos = set()
        items = []

        for lang in self.languages:
            if len(items) >= self.max_items:
                break
            new_items = self._scrape_trending(lang)
            for item in new_items:
                if item.url not in seen_repos and len(items) < self.max_items:
                    seen_repos.add(item.url)
                    items.append(item)

        return items

    def _scrape_trending(self, language: str) -> list[CollectedItem]:
        url = f"{GITHUB_TRENDING_URL}/{language}?since=daily" if language else f"{GITHUB_TRENDING_URL}?since=daily"
        try:
            resp = self.session.get(url, timeout=15, headers={"User-Agent": "IdeaScout/1.0"})
            resp.raise_for_status()
        except Exception as e:
            print(f"[GitHub] trending/{language} の取得に失敗: {e}")
            return []

        return self._parse_html(resp.text)

    def _parse_html(self, html: str) -> list[CollectedItem]:
        soup = BeautifulSoup(html, "html.parser")
        items = []

        for article in soup.select("article.Box-row"):
            try:
                # リポジトリ名
                h2 = article.select_one("h2 a")
                if not h2:
                    continue
                repo_path = h2.get("href", "").strip("/")
                if not repo_path:
                    continue

                title = repo_path
                url = f"https://github.com/{repo_path}"

                # 説明文
                desc_elem = article.select_one("p")
                description = desc_elem.get_text(strip=True) if desc_elem else ""

                # スター数
                stars = 0
                star_elem = article.select_one("a[href$='/stargazers']")
                if star_elem:
                    star_text = star_elem.get_text(strip=True).replace(",", "")
                    stars = int(star_text) if star_text.isdigit() else 0

                # 今日のスター増分
                today_stars_elem = article.select_one("span.d-inline-block.float-sm-right")
                today_stars = ""
                if today_stars_elem:
                    today_stars = today_stars_elem.get_text(strip=True)

                # 言語
                lang_elem = article.select_one("span[itemprop='programmingLanguage']")
                lang = lang_elem.get_text(strip=True) if lang_elem else ""

                tags = [lang] if lang else []

                items.append(CollectedItem(
                    source="github",
                    title=title,
                    url=url,
                    description=f"{description} ({today_stars})" if today_stars else description,
                    score=stars,
                    tags=tags,
                ))
            except Exception:
                continue

        return items
