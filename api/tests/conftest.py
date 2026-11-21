"""テストの準備。

本物の PostgreSQL（手元は Docker、GitHub Actions はサービスコンテナ）に
テスト用のデータベースを毎回まっさらに作り、マイグレーションを流してから試す。

API と同じく、権限をしぼった shinkoku_app ユーザーでつなぐので、RLS もちゃんと効いた状態で試せる。
"""

from __future__ import annotations

import os

import pytest

# 手元・GitHub Actions のテスト用DBの場所（AWSのDBには絶対につながない）
os.environ.setdefault("DB_HOST", "localhost")
os.environ.setdefault("DB_PORT", "55432")
os.environ.setdefault("DATABASE_PASSWORD", "localdev")
os.environ["DB_SSL"] = "disable"
os.environ["DB_NAME"] = "shinkoku_test"
os.environ["DB_USER"] = "postgres"

APP_PASSWORD = "app-local-only"

from shinkoku import db, migrate  # noqa: E402

ALICE = "11111111-aaaa-4aaa-8aaa-111111111111"
BOB = "22222222-bbbb-4bbb-8bbb-222222222222"


@pytest.fixture(scope="session")
def database():
    admin = db.connect(database="postgres")
    admin.run("drop database if exists shinkoku_test with (force)")
    admin.run("create database shinkoku_test")
    admin.close()
    con = db.connect(database="shinkoku_test")
    migrate.migrate(con)
    con.run(f"alter role shinkoku_app password '{APP_PASSWORD}'")  # 手元のテストだけパスワードでログイン
    yield con
    con.close()


@pytest.fixture
def app_con(database, monkeypatch):
    """アプリ用ユーザー（shinkoku_app）での接続。テストごとに仕訳を空にする。"""
    database.run("truncate journal_entries, journal_lines, audit_logs, profiles, import_files, partner_rules, line_links, line_link_codes, recurring_rules, recurring_runs, freee_connections, freee_oauth_states, freee_syncs, tax_inputs, fixed_assets, tax_documents cascade")
    monkeypatch.setenv("DATABASE_PASSWORD", APP_PASSWORD)
    con = db.connect(user="shinkoku_app")
    yield con
    con.close()


def expense_payload(amount=3300, code="5190", date="2026-01-10", **extra):
    """よく使う仕訳：私物のお金で仕事の物を買った（消耗品費 / 事業主借）"""
    return {
        "entry_date": date,
        "description": "USBケーブル",
        "partner": "家電量販店",
        "status": "confirmed",
        "lines": [
            {"side": "debit", "account_code": code, "amount": amount},
            {"side": "credit", "account_code": "2900", "amount": amount},
        ],
        **extra,
    }
