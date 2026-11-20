"""DBへのつなぎ方。

- AWS（Lambda）では、パスワードの代わりに IAM の通行証（15分だけ使えるトークン）でつなぐ
- 手元のテストでは、環境変数 DATABASE_PASSWORD があればそのパスワードでつなぐ
- 通信は必ず暗号化（TLS）。証明書は公開の標準のもの（certifi）で確かめる
"""

from __future__ import annotations

import os
import ssl
from collections.abc import Iterator
from contextlib import contextmanager

import pg8000.native

# Lambda は同じ箱（コンテナ）を使い回すので、つないだ線も使い回して速くする
_connections: dict[tuple[str, str], pg8000.native.Connection] = {}


class DatabaseUnavailable(Exception):
    """DBが起動中・つながらないとき（画面には「少し待ってね」と出す）"""


def _settings(user: str | None, database: str | None) -> dict:
    return {
        "host": os.environ["DB_HOST"],
        "port": int(os.environ.get("DB_PORT", "5432")),
        "user": user or os.environ["DB_USER"],
        "database": database or os.environ.get("DB_NAME", "shinkoku"),
    }


def _password(host: str, port: int, user: str) -> str:
    if "DATABASE_PASSWORD" in os.environ:  # 手元のテスト用
        return os.environ["DATABASE_PASSWORD"]
    import boto3  # Lambda の実行環境には最初から入っている

    return boto3.client("rds").generate_db_auth_token(
        DBHostname=host, Port=port, DBUsername=user, Region=os.environ["AWS_REGION"]
    )


def _ssl_context() -> ssl.SSLContext | None:
    if os.environ.get("DB_SSL", "require") == "disable":  # 手元のテスト用DBだけ
        return None
    import certifi

    return ssl.create_default_context(cafile=certifi.where())


def connect(user: str | None = None, database: str | None = None) -> pg8000.native.Connection:
    s = _settings(user, database)
    try:
        return pg8000.native.Connection(
            user=s["user"],
            password=_password(s["host"], s["port"], s["user"]),
            host=s["host"],
            port=s["port"],
            database=s["database"],
            ssl_context=_ssl_context(),
            timeout=int(os.environ.get("DB_CONNECT_TIMEOUT", "20")),
            application_name="shinkoku-note",
        )
    except (OSError, pg8000.exceptions.InterfaceError) as e:
        raise DatabaseUnavailable(str(e)) from e


def shared_connection(user: str | None = None, database: str | None = None) -> pg8000.native.Connection:
    """使い回しの線。切れていたらつなぎ直す。"""
    key = (user or "", database or "")
    con = _connections.get(key)
    if con is not None:
        try:
            con.run("select 1")
            return con
        except Exception:
            _connections.pop(key, None)
    con = connect(user, database)
    _connections[key] = con
    return con


@contextmanager
def as_user(con: pg8000.native.Connection, user_id: str) -> Iterator[pg8000.native.Connection]:
    """「この人として」1つのトランザクションを実行する。

    app.user_id にログイン中の人の番号を入れるので、DBのRLSで他人の行は見えない。
    途中でエラーが起きたら、全部なかったことにする（ROLLBACK）。
    """
    if not user_id:
        raise ValueError("user_id が空です")
    con.run("begin")
    try:
        con.run("select set_config('app.user_id', :uid, true)", uid=user_id)
        yield con
        con.run("commit")
    except BaseException:
        con.run("rollback")
        raise
