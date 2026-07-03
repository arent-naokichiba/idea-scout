"""PLATEAU Viewer - 国土交通省 Project PLATEAU 3D都市モデルビューア

ローカルHTTPサーバを起動し、ブラウザでCesiumJSベースの3Dビューアを開く。
Windows / macOS / Linux で動作する（Python標準ライブラリのみ使用）。

Usage:
    python plateau_viewer.py                # サーバ起動 + ブラウザを開く
    python plateau_viewer.py --port 8080    # ポート指定
    python plateau_viewer.py --no-browser   # ブラウザを自動で開かない
"""

import argparse
import json
import socket
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from idea_scout.plateau import PlateauClient

VIEWER_DIR = Path(__file__).parent / "viewer"
GSI_GEOCODE_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch"


class ViewerHandler(SimpleHTTPRequestHandler):
    """静的ファイル配信 + データカタログAPIのプロキシ"""

    # サーバ起動時に注入される共有クライアント
    plateau: PlateauClient = None

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            try:
                self._handle_api(parsed.path, parse_qs(parsed.query))
            except BrokenPipeError:
                pass
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return
        super().do_GET()

    def _handle_api(self, path: str, query: dict) -> None:
        q = {k: v[0] for k, v in query.items()}

        if path == "/api/prefs":
            prefs = {}
            for c in self.plateau.load_catalog()["citygml"]:
                prefs[c["pref_code"]] = c["pref"]
            result = [{"code": k, "name": v} for k, v in sorted(prefs.items())]
            self._send_json(result)

        elif path == "/api/cities":
            self._send_json(self.plateau.list_cities(query=q.get("q")))

        elif path == "/api/types":
            result = [
                {"name": name, "code": code, "count": count}
                for name, code, count in self.plateau.list_types()
            ]
            self._send_json(result)

        elif path == "/api/datasets":
            result = self.plateau.search_datasets(
                query=q.get("q"),
                pref=q.get("pref"),
                city=q.get("city"),
                dataset_type=q.get("type"),
                data_format=q.get("format"),
                limit=int(q.get("limit", 50)),
            )
            self._send_json(result)

        elif path == "/api/dataset":
            ds_id = q.get("id", "")
            d = self.plateau.get_dataset(ds_id) or self.plateau.get_composite(ds_id)
            self._send_json(d or {"error": "not found"}, status=200 if d else 404)

        elif path == "/api/composites":
            self._send_json(self.plateau.list_composites(
                pref=q.get("pref"), dataset_type=q.get("type")))

        elif path == "/api/citygml":
            c = self.plateau.get_citygml(q.get("code", ""))
            self._send_json(c or {"error": "not found"}, status=200 if c else 404)

        elif path == "/api/geocode":
            # 国土地理院の住所検索APIをプロキシする（ブラウザからのCORS回避）
            resp = self.plateau.session.get(
                GSI_GEOCODE_URL, params={"q": q.get("q", "")}, timeout=15
            )
            resp.raise_for_status()
            self._send_json(resp.json())

        else:
            self._send_json({"error": "unknown endpoint"}, status=404)

    def _send_json(self, data, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # 静的ファイルのアクセスログは抑制する（APIエラーのみ表示）
        if args and str(args[1] if len(args) > 1 else "").startswith("5"):
            super().log_message(format, *args)


def get_lan_ip() -> str | None:
    """このマシンのLAN側IPアドレスを取得する（パケットは送信しない）"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="PLATEAU Viewer - 3D都市モデルビューア"
    )
    parser.add_argument("--host", default="127.0.0.1", help="バインドするホスト（デフォルト: 127.0.0.1）")
    parser.add_argument("--port", type=int, default=8765, help="ポート番号（デフォルト: 8765）")
    parser.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    parser.add_argument("--lan", action="store_true",
                        help="同一Wi-Fi内のスマートフォン等からアクセス可能にする（0.0.0.0にバインド）")
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else args.host

    print("[PLATEAU Viewer] カタログを準備中...")
    client = PlateauClient()
    client.load_catalog()

    handler = partial(ViewerHandler, directory=str(VIEWER_DIR))
    ViewerHandler.plateau = client

    server = ThreadingHTTPServer((host, args.port), handler)
    url = f"http://{'127.0.0.1' if host == '0.0.0.0' else host}:{args.port}/"
    print(f"[PLATEAU Viewer] 起動しました: {url}")
    if host == "0.0.0.0":
        lan_ip = get_lan_ip()
        if lan_ip:
            print()
            print("  ┌─ スマートフォンからのアクセス ─────────────────")
            print(f"  │ 同じWi-Fiに接続したスマホのブラウザで開いてください:")
            print(f"  │   http://{lan_ip}:{args.port}/")
            print("  │ ※ 初回はOSのファイアウォールの許可が必要な場合があります")
            print("  └───────────────────────────────────")
    else:
        print("  スマホから使う場合は --lan を付けて起動してください。")
    print("  終了するには Ctrl+C を押してください。")

    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=[url]).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[PLATEAU Viewer] 終了します。")
        server.shutdown()


if __name__ == "__main__":
    main()
