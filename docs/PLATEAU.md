# PLATEAU ツール - 国土交通省 Project PLATEAU データアクセス & 3Dビューア

国土交通省が主導する [Project PLATEAU（プラトー）](https://www.mlit.go.jp/plateau/) の
データカタログAPIにアクセスするツール群。

| ツール | 内容 |
|---|---|
| `plateau_viewer.py` | **3D都市モデルビューア**（ブラウザで3D表示・検索・属性参照） |
| `plateau_cli.py` | コマンドラインでの検索・ダウンロード |

## PLATEAU Viewer（3Dビューア）

```bash
python plateau_viewer.py            # サーバ起動 + ブラウザが自動で開く
python plateau_viewer.py --port 8080 --no-browser
```

Windows は `run_viewer.bat`、macOS / Linux は `./run_viewer.sh` でも起動できる。
追加のPythonパッケージは不要（標準ライブラリのみ）。ブラウザ（Chrome / Edge / Safari / Firefox）が
CesiumJSで3D Tilesをストリーミング描画するため、Windows / Mac どちらでも同じように動作する。

### 主な機能

- **3D表示（高速ストリーミング）** — 3D TilesのLOD制御により視点に応じて必要なタイルだけを読み込む。
  ヘッダーの「品質」スライダーで描画品質と速度のバランスを調整可能
- **クイックスタート** — 東京・大阪・名古屋・札幌・福岡の建築物モデルをワンクリック表示
- **データセット検索** — 都道府県 / 市区町村 / 種別（建築物・洪水浸水想定区域など24種）で絞り込み
- **レイヤー管理** — 複数データセットの重ね合わせ、表示/非表示、透明度、ズーム
- **色分け表示** — 建物の高さによる色分け、単色（白模型風）表示
- **属性フィルタ** — 建物高さの範囲指定で絞り込み表示（例: 60m以上の建物のみ）
- **属性参照** — 建物クリックでCityGML属性（階数・用途・建蔽率・容積率など）をパネル表示、JSONコピー
- **住所検索** — 国土地理院ジオコーダで地名・住所から移動
- **距離計測** — クリックで測点を追加して距離を計測（複数点の合計距離対応）
- **日照シミュレーション** — 影の表示 + 時刻スライダー
- **ベースマップ切替** — 航空写真 / 標準地図 / 淡色地図 / ダーク
- **ブックマーク** — 視点の保存・呼び出し
- **共有リンク** — 表示状態（カメラ・レイヤー・スタイル）をURLとしてコピー
- **セッション復元** — 前回の表示状態を自動保存・復元
- **スクリーンショット** — 表示中の3DビューをPNG保存
- **FPS表示 / 2D・3D切替**

### 表示の仕組み

```
plateau_viewer.py（ローカルHTTPサーバ）
  ├─ /              → viewer/ の静的ファイル（CesiumJSアプリ）
  ├─ /api/*         → データカタログAPIのプロキシ（ローカルキャッシュ利用）
  └─ /api/geocode   → 国土地理院 住所検索APIのプロキシ
ブラウザ → PLATEAU CDN（assets.cms.plateau.reearth.io）から3D Tilesを直接ストリーミング
```

※ 3D Tilesのタイル本体はPLATEAUのCDNから直接取得するため、インターネット接続が必要。
※ MVT形式のデータセット（都市計画決定情報など）は現在3D表示未対応（検索・詳細参照は可能）。

## PLATEAU CLI（コマンドライン）

- API: `https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets`（認証不要）
- カタログ（約9MB）は `data/plateau_catalog.json` に24時間キャッシュされる
- `--refresh` でキャッシュを無視して再取得できる（例: `python plateau_cli.py --refresh cities`）

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
