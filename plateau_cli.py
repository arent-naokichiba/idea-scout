"""PLATEAU CLI - 国土交通省 Project PLATEAU データアクセスツール

PLATEAU（プラトー）のデータカタログAPIから3D都市モデルを検索・ダウンロードする。
認証不要。カタログは data/plateau_catalog.json に24時間キャッシュされる。

Usage:
    python plateau_cli.py cities -q 東京            # 自治体一覧（CityGML公開元）
    python plateau_cli.py types                     # データセット種別一覧
    python plateau_cli.py search -q 渋谷 -t bldg    # データセット検索
    python plateau_cli.py show <dataset_id>         # データセット詳細
    python plateau_cli.py download <dataset_id>     # データセットのダウンロード
    python plateau_cli.py download 13101 --citygml  # 団体コード指定でCityGML一式
"""

import argparse
import sys

from dotenv import load_dotenv

from idea_scout.plateau import PlateauClient, format_size


def cmd_cities(client: PlateauClient, args) -> None:
    cities = client.list_cities(query=args.query, refresh=args.refresh)
    if not cities:
        print("該当する自治体がありません。")
        return
    print(f"{'コード':<7} {'都道府県':<8} {'市区町村':<12} {'年度':<6} {'サイズ':>10}  地物")
    print("-" * 80)
    for c in cities:
        features = ",".join(c.get("feature_types") or [])
        print(
            f"{c['city_code']:<7} {c['pref']:<8} {c['city']:<12} "
            f"{c.get('year') or '-':<6} {format_size(c.get('file_size')):>10}  {features}"
        )
    print(f"\n合計 {len(cities)} 自治体")


def cmd_types(client: PlateauClient, args) -> None:
    print(f"{'種別':<24} {'コード':<10} {'件数':>6}")
    print("-" * 44)
    for name, code, count in client.list_types(refresh=args.refresh):
        print(f"{name:<24} {code:<10} {count:>6}")


def cmd_search(client: PlateauClient, args) -> None:
    datasets = client.search_datasets(
        query=args.query,
        pref=args.pref,
        city=args.city,
        dataset_type=args.type,
        data_format=args.format,
        limit=args.limit,
        refresh=args.refresh,
    )
    if not datasets:
        print("該当するデータセットがありません。")
        return
    for d in datasets:
        print(f"[{d['id']}]")
        print(f"  {d['name']}")
        print(
            f"  形式: {d.get('format')} / 年度: {d.get('year')} / "
            f"サイズ: {format_size(d.get('file_size'))}"
        )
    print(f"\n合計 {len(datasets)} 件（--limit {args.limit}）")


def cmd_show(client: PlateauClient, args) -> None:
    d = client.get_dataset(args.id, refresh=args.refresh)
    if not d:
        print(f"データセットが見つかりません: {args.id}")
        sys.exit(1)
    for key, value in d.items():
        print(f"{key:<20}: {value}")


def cmd_download(client: PlateauClient, args) -> None:
    if args.citygml:
        c = client.get_citygml(args.id, refresh=args.refresh)
        if not c:
            print(f"団体コードに該当するCityGMLがありません: {args.id}")
            sys.exit(1)
        url = c["url"]
        size = c.get("file_size")
        label = f"{c['pref']} {c['city']} CityGML一式"
    else:
        d = client.get_dataset(args.id, refresh=args.refresh)
        if not d:
            print(f"データセットが見つかりません: {args.id}")
            sys.exit(1)
        url = d["url"]
        size = d.get("file_size")
        label = d["name"]
        if url.endswith("tileset.json"):
            print("[注意] 3D Tilesのエントリポイント（tileset.json）のみをダウンロードします。")
            print("       タイル本体はビューア等がtileset.json内の参照から順次取得します。")

    print(f"ダウンロード: {label}")
    print(f"  URL : {url}")
    print(f"  サイズ: {format_size(size)}")

    if size and size > 500 * 1024 * 1024 and not args.yes:
        answer = input("500MBを超えるファイルです。続行しますか？ [y/N]: ")
        if answer.strip().lower() != "y":
            print("中止しました。")
            return

    filepath = client.download(url, args.output)
    print(f"保存完了: {filepath}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="PLATEAU CLI - 国土交通省 Project PLATEAU データアクセスツール"
    )
    parser.add_argument("--refresh", action="store_true", help="カタログキャッシュを無視して再取得する")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("cities", help="CityGMLを公開している自治体の一覧")
    p.add_argument("-q", "--query", help="都道府県名・市区町村名・団体コードで絞り込み")
    p.set_defaults(func=cmd_cities)

    p = sub.add_parser("types", help="データセット種別の一覧")
    p.set_defaults(func=cmd_types)

    p = sub.add_parser("search", help="データセット（3D Tiles / MVT）の検索")
    p.add_argument("-q", "--query", help="データセット名・IDの部分一致")
    p.add_argument("--pref", help="都道府県名で絞り込み")
    p.add_argument("--city", help="市区町村名で絞り込み")
    p.add_argument("-t", "--type", help="種別（例: 建築物モデル）または種別コード（例: bldg）")
    p.add_argument("-f", "--format", help="データ形式（3D Tiles / MVT）")
    p.add_argument("-n", "--limit", type=int, default=20, help="最大表示件数（デフォルト: 20）")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("show", help="データセットの詳細表示")
    p.add_argument("id", help="データセットID")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("download", help="データセットのダウンロード")
    p.add_argument("id", help="データセットID（--citygml指定時は5桁の団体コード）")
    p.add_argument("--citygml", action="store_true", help="自治体のCityGML一式（zip）をダウンロード")
    p.add_argument("-o", "--output", default="data/plateau", help="保存先ディレクトリ（デフォルト: data/plateau）")
    p.add_argument("-y", "--yes", action="store_true", help="大容量ファイルの確認をスキップ")
    p.set_defaults(func=cmd_download)

    args = parser.parse_args()
    load_dotenv()

    client = PlateauClient()
    try:
        args.func(client, args)
    except KeyboardInterrupt:
        print("\n中止しました。")
        sys.exit(1)
    except BrokenPipeError:
        # head等にパイプした際の正常な切断
        sys.exit(0)


if __name__ == "__main__":
    main()
