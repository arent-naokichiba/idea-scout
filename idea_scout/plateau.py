"""国土交通省 Project PLATEAU データカタログAPIクライアント

PLATEAU（プラトー）が公開しているデータカタログAPIから、
3D都市モデル（CityGML / 3D Tiles / MVT）のデータセットを検索・取得する。

API仕様: https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets
認証不要。レスポンスは約9MBのJSONのため、ローカルにキャッシュする。
"""

import json
import os
import time
from pathlib import Path

from .config import get_requests_session

CATALOG_URL = "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets"
DEFAULT_CACHE_TTL_HOURS = 24


class PlateauClient:
    """PLATEAUデータカタログAPIへのアクセスを提供する"""

    def __init__(self, cache_dir: str | None = None, cache_ttl_hours: float = DEFAULT_CACHE_TTL_HOURS):
        self.session = get_requests_session()
        base = Path(cache_dir) if cache_dir else Path(__file__).parent.parent / "data"
        self.cache_path = base / "plateau_catalog.json"
        self.cache_ttl_seconds = cache_ttl_hours * 3600
        self._catalog: dict | None = None

    # --- カタログ取得 ---

    def load_catalog(self, refresh: bool = False) -> dict:
        """カタログ全体を取得する（キャッシュ優先）

        Returns:
            keys: datasets, latest_datasets, composite_tilesets, citygml, latest_citygml
        """
        if self._catalog is not None and not refresh:
            return self._catalog

        if not refresh and self._is_cache_valid():
            with open(self.cache_path, encoding="utf-8") as f:
                self._catalog = json.load(f)
            return self._catalog

        print("[PLATEAU] カタログをAPIから取得中...（約9MB）")
        resp = self.session.get(CATALOG_URL, timeout=120)
        resp.raise_for_status()
        self._catalog = resp.json()

        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.cache_path, "w", encoding="utf-8") as f:
            json.dump(self._catalog, f, ensure_ascii=False)
        return self._catalog

    def _is_cache_valid(self) -> bool:
        if not self.cache_path.exists():
            return False
        age = time.time() - self.cache_path.stat().st_mtime
        return age < self.cache_ttl_seconds

    # --- 検索 ---

    def list_cities(self, query: str | None = None, refresh: bool = False) -> list[dict]:
        """CityGMLを公開している自治体の一覧を返す

        Args:
            query: 都道府県名・市区町村名・団体コードの部分一致フィルタ
        """
        cities = self.load_catalog(refresh)["citygml"]
        if query:
            cities = [
                c for c in cities
                if query in (c.get("pref") or "")
                or query in (c.get("city") or "")
                or query in (c.get("city_code") or "")
            ]
        return sorted(cities, key=lambda c: c["city_code"])

    def search_datasets(
        self,
        query: str | None = None,
        pref: str | None = None,
        city: str | None = None,
        dataset_type: str | None = None,
        data_format: str | None = None,
        limit: int | None = None,
        refresh: bool = False,
    ) -> list[dict]:
        """データセット（3D Tiles / MVT）を条件で絞り込んで返す

        Args:
            query: データセット名・IDの部分一致
            pref: 都道府県名の部分一致
            city: 市区町村名の部分一致
            dataset_type: 種別（例: "建築物モデル"）または種別コード（例: "bldg"）の部分一致
            data_format: "3D Tiles" または "MVT"
            limit: 最大件数（Noneで全件）
        """
        datasets = self.load_catalog(refresh)["datasets"]
        results = []
        for d in datasets:
            if query and query not in (d.get("name") or "") and query not in (d.get("id") or ""):
                continue
            if pref and pref not in (d.get("pref") or ""):
                continue
            if city and city not in (d.get("city") or "") and city not in (d.get("ward") or ""):
                continue
            if dataset_type and dataset_type not in (d.get("type") or "") and dataset_type != (d.get("type_en") or ""):
                continue
            if data_format and data_format.lower() != (d.get("format") or "").lower():
                continue
            results.append(d)
            if limit and len(results) >= limit:
                break
        return results

    def get_dataset(self, dataset_id: str, refresh: bool = False) -> dict | None:
        """IDでデータセットを1件取得する"""
        for d in self.load_catalog(refresh)["datasets"]:
            if d["id"] == dataset_id:
                return d
        return None

    def get_citygml(self, city_code: str, refresh: bool = False) -> dict | None:
        """団体コードで自治体のCityGML情報を取得する"""
        for c in self.load_catalog(refresh)["citygml"]:
            if c["city_code"] == city_code:
                return c
        return None

    def list_composites(
        self,
        pref: str | None = None,
        dataset_type: str | None = None,
        refresh: bool = False,
    ) -> list[dict]:
        """都道府県全域の結合タイルセット一覧を返す（年度別・LOD別）

        市区町村別のdatasetsと違い、過去年度（2020〜）が残っているため経年比較に使える。
        """
        results = []
        for c in self.load_catalog(refresh)["composite_tilesets"]:
            if pref and pref not in (c.get("pref") or ""):
                continue
            if dataset_type and dataset_type not in (c.get("type") or "") and dataset_type != (c.get("type_en") or ""):
                continue
            results.append(self._enrich_composite(c))
        return results

    def get_composite(self, composite_id: str, refresh: bool = False) -> dict | None:
        """IDで結合タイルセットを1件取得する"""
        for c in self.load_catalog(refresh)["composite_tilesets"]:
            if c["id"] == composite_id:
                return self._enrich_composite(c)
        return None

    @staticmethod
    def _enrich_composite(c: dict) -> dict:
        """結合タイルセットをdatasetsと同じ形で扱えるように表示名等を補完する"""
        tex = ""
        if c.get("texture") is True:
            tex = "・テクスチャ"
        elif c.get("texture") is False:
            tex = "・テクスチャなし"
        year = c.get("year")
        year_label = "最新" if year == "latest" else f"{year}年度"
        d = dict(c)
        d.update({
            "name": f"{c['type']} LOD{c['lod']}{tex}（{c['pref']}全域・{year_label}）",
            "format": "3D Tiles",
            "city": None,
            "ward": None,
            "file_size": None,
            "composite": True,
        })
        return d

    def list_types(self, refresh: bool = False) -> list[tuple[str, str, int]]:
        """データセット種別の一覧を (種別名, 種別コード, 件数) で返す"""
        counts: dict[tuple[str, str], int] = {}
        for d in self.load_catalog(refresh)["datasets"]:
            key = (d.get("type") or "不明", d.get("type_en") or "-")
            counts[key] = counts.get(key, 0) + 1
        return sorted(
            [(t, t_en, n) for (t, t_en), n in counts.items()],
            key=lambda x: x[2],
            reverse=True,
        )

    # --- ダウンロード ---

    def download(self, url: str, output_dir: str, chunk_size: int = 1024 * 1024) -> str:
        """URLのファイルをストリーミングダウンロードして保存先パスを返す"""
        os.makedirs(output_dir, exist_ok=True)
        filename = url.rstrip("/").split("/")[-1] or "download.bin"
        filepath = os.path.join(output_dir, filename)

        with self.session.get(url, stream=True, timeout=60) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            with open(filepath, "wb") as f:
                for chunk in resp.iter_content(chunk_size=chunk_size):
                    f.write(chunk)
                    done += len(chunk)
                    if total:
                        print(f"\r  {done / 1024 / 1024:.1f} / {total / 1024 / 1024:.1f} MB", end="", flush=True)
                    else:
                        print(f"\r  {done / 1024 / 1024:.1f} MB", end="", flush=True)
            print()
        return filepath


def format_size(num_bytes: int | None) -> str:
    """バイト数を人間が読みやすい形式にする"""
    if not num_bytes:
        return "-"
    size = float(num_bytes)
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"
