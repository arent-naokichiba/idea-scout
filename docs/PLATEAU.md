# PLATEAU CLI - 国土交通省 Project PLATEAU データアクセスツール

国土交通省が主導する [Project PLATEAU（プラトー）](https://www.mlit.go.jp/plateau/) の
データカタログAPIから、3D都市モデル（CityGML / 3D Tiles / MVT）を検索・ダウンロードするツール。

- API: `https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets`（認証不要）
- カタログ（約9MB）は `data/plateau_catalog.json` に24時間キャッシュされる
- `--refresh` でキャッシュを無視して再取得できる（例: `python plateau_cli.py --refresh cities`）

## 使い方

### 自治体一覧（CityGML公開元）

```bash
python plateau_cli.py cities              # 全自治体（約300件）
python plateau_cli.py cities -q 東京      # 名前・団体コードで絞り込み
```

### データセット種別の一覧

```bash
python plateau_cli.py types
# 建築物モデル(bldg)、洪水浸水想定区域モデル(fld)、交通（道路）モデル(tran) など
```

### データセット検索

```bash
python plateau_cli.py search --city 千代田 -t bldg        # 千代田区の建築物モデル
python plateau_cli.py search --pref 北海道 -t 洪水 -n 50   # 種別は日本語名でも可
python plateau_cli.py search -q 渋谷 -f "3D Tiles"        # 形式で絞り込み
```

### 詳細表示・ダウンロード

```bash
python plateau_cli.py show 13101_bldg_lod2                # データセット詳細（URL等）
python plateau_cli.py download 13101_bldg_lod2            # データセットをダウンロード
python plateau_cli.py download 13101 --citygml -o data/plateau  # CityGML一式（zip）
```

- 保存先はデフォルトで `data/plateau/`（`-o` で変更可）
- 500MB超のファイルは確認プロンプトが出る（`-y` でスキップ）
- 形式が「3D Tiles」のデータセットはエントリポイント（`tileset.json`）のみ取得する。
  タイル本体はCesium等のビューアに `tileset.json` のURLを渡して利用するのが基本
- CityGML一式は自治体によっては数GBになるので注意（`cities` コマンドでサイズ確認可）

## Pythonから使う

```python
from idea_scout.plateau import PlateauClient

client = PlateauClient()
datasets = client.search_datasets(city="千代田", dataset_type="bldg")
for d in datasets:
    print(d["id"], d["name"], d["url"])
```

`PlateauClient` の主なメソッド:

| メソッド | 内容 |
|---|---|
| `list_cities(query)` | CityGML公開自治体の一覧 |
| `search_datasets(query, pref, city, dataset_type, data_format, limit)` | データセット検索 |
| `get_dataset(dataset_id)` | ID指定で1件取得 |
| `get_citygml(city_code)` | 団体コードでCityGML情報を取得 |
| `list_types()` | 種別一覧（件数付き） |
| `download(url, output_dir)` | ストリーミングダウンロード |
