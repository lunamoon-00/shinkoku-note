"""マイグレーション（DBのテーブルを作る・変える）。

migrations/ の中の 0001_*.sql, 0002_*.sql … を番号順に、まだ流していないものだけ流す。
流したものは schema_migrations に記録するので、何回実行しても同じ結果になる。
最後に grants.sql（アプリ用ユーザーの権限）を毎回流す。

AWS では公開（デプロイ）のたびに Lambda として自動で実行される。
"""

from __future__ import annotations

import os
from pathlib import Path

import pg8000.native

from . import db

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def ensure_database(name: str) -> None:
    """データベース（shinkoku）がなければ作る。CREATE DATABASE はトランザクションの外で実行する決まり。"""
    con = db.connect(database="postgres")
    try:
        exists = con.run("select 1 from pg_database where datname = :n", n=name)
        if not exists:
            con.run(f'create database "{name}"')
    finally:
        con.close()


def _run_script(con: pg8000.native.Connection, sql: str) -> None:
    # 何も値を埋め込まないので、複数の文をまとめて流せる
    con.run(sql)


def migrate(con: pg8000.native.Connection) -> list[str]:
    con.run(
        "create table if not exists schema_migrations ("
        " name text primary key, applied_at timestamptz not null default now())"
    )
    applied = {row[0] for row in con.run("select name from schema_migrations")}
    done: list[str] = []
    for path in sorted(MIGRATIONS_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        if path.name in applied:
            continue
        con.run("begin")
        try:
            _run_script(con, path.read_text(encoding="utf-8"))
            con.run("insert into schema_migrations (name) values (:n)", n=path.name)
            con.run("commit")
        except BaseException:
            con.run("rollback")
            raise
        done.append(path.name)
    _run_script(con, (MIGRATIONS_DIR / "grants.sql").read_text(encoding="utf-8"))
    return done


def handler(event, context):  # Lambda の入口
    name = os.environ.get("DB_NAME", "shinkoku")
    ensure_database(name)
    con = db.connect(database=name)
    try:
        done = migrate(con)
    finally:
        con.close()
    print({"applied": done})
    return {"applied": done}
