# Idea Scout - 開発ネタ発掘ツール

技術トレンドを複数ソースから日次収集し、AIが分析してレポートを生成するツール。

## セットアップ

```bash
cd src
pip install -r requirements.txt
```

プロキシ環境でSSLエラーが出る場合は `.env` を作成:
```bash
cp .env.example .env
# IDEA_SCOUT_SSL_VERIFY=false に設定
```

## 使い方

### 方法1: Claude Codeで分析（推奨・API key不要）

```bash
# 1. 収集してJSONを保存
python main.py

# 2. Claude Codeで以下のように依頼
#    「data/YYYY-MM-DD_collected.json を分析してレポートを生成して」
```

### 方法2: Claude APIで自動分析（ANTHROPIC_API_KEY必要）

```bash
python main.py --full
```

レポートは `reports/YYYY-MM-DD.md` に出力されます。

## 収集ソース

| ソース | 取得内容 | 認証 |
|---|---|---|
| Hacker News | トップ/ベストストーリー上位20件 | 不要 |
| GitHub Trending | 日次トレンドリポジトリ（全言語+Python/C#/TS） | 不要 |
| arXiv | cs.AI, cs.SE, cs.HC の最新論文 | 不要 |

## レポート構成

1. **注目の開発ネタ候補** — 専門領域との関連性3以上の項目をピックアップ
2. **ソース別一覧** — 全項目をテーブル形式で表示（関連性スコア付き）
3. **統計** — 収集数・注目候補数のサマリー

## 付属ツール

- **PLATEAU Viewer** (`plateau_viewer.py`) — 国土交通省 Project PLATEAU の3D都市モデルをブラウザで高速3D表示するビューア（Windows / Mac / Linux対応、検索・属性参照・計測・日照シミュレーション等）。
- **PLATEAU CLI** (`plateau_cli.py`) — 3D都市モデルの検索・ダウンロードを行うコマンドラインツール。

詳細は [docs/PLATEAU.md](PLATEAU.md) を参照。

## アーキテクチャ

```
python main.py → JSON収集データ (data/)
  ↓
Claude Code or Claude API → 分析
  ↓
Markdownレポート (reports/)
```
