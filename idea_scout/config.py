import os
import ssl
import urllib.request

import requests


def get_ssl_verify() -> bool:
    """SSL検証を行うかどうかを環境変数で制御する"""
    return os.getenv("IDEA_SCOUT_SSL_VERIFY", "true").lower() != "false"


def get_requests_session() -> requests.Session:
    """SSL設定済みのrequestsセッションを返す"""
    session = requests.Session()
    if not get_ssl_verify():
        session.verify = False
        # urllib3の警告を抑制
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    return session


def get_ssl_context() -> ssl.SSLContext | None:
    """arxivライブラリ用のSSLコンテキストを返す"""
    if not get_ssl_verify():
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return None
