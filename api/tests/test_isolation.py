"""2人のデータが絶対に混ざらないことを確かめる。

API（ledger）の関数を通した場合だけでなく、SQLを直接たたいた場合も、
DBのRLS（行レベルセキュリティ）が他人の行を守ることを確かめる。
"""

import pg8000.exceptions
import pytest

from shinkoku import db, ledger

from .conftest import ALICE, BOB, expense_payload


@pytest.fixture
def alice_entry(app_con):
    with db.as_user(app_con, ALICE):
        return ledger.create_entry(app_con, ALICE, expense_payload(amount=5000))


def test_他人の仕訳は一覧に出ない(app_con, alice_entry):
    with db.as_user(app_con, BOB):
        assert ledger.list_entries(app_con, 2026) == []


def test_他人の仕訳は番号を知っていても読めない_直せない_消せない(app_con, alice_entry):
    eid = alice_entry["id"]
    with db.as_user(app_con, BOB):
        with pytest.raises(ledger.NotFound):
            ledger.get_entry(app_con, eid)
        with pytest.raises(ledger.NotFound):
            ledger.update_entry(app_con, BOB, eid, expense_payload(amount=1))
        with pytest.raises(ledger.NotFound):
            ledger.confirm_entry(app_con, BOB, eid)
        with pytest.raises(ledger.NotFound):
            ledger.delete_entry(app_con, BOB, eid)
    with db.as_user(app_con, ALICE):
        assert ledger.get_entry(app_con, eid)["total"] == 5000  # Alice の仕訳はそのまま


def test_他人の集計には入らない(app_con, alice_entry):
    with db.as_user(app_con, BOB):
        assert ledger.summary(app_con, 2026)["expense"] == 0


def test_SQLを直接たたいても他人の行は見えない_変えられない(app_con, alice_entry):
    with db.as_user(app_con, BOB):
        assert app_con.run("select count(*) from journal_entries")[0][0] == 0
        assert app_con.run("select count(*) from journal_lines")[0][0] == 0
        app_con.run("update journal_lines set amount = 1")  # 見えないので1行も変わらない
        app_con.run("delete from journal_entries")
    with db.as_user(app_con, ALICE):
        assert ledger.get_entry(app_con, alice_entry["id"])["total"] == 5000


def test_他人の名前で行を書きこもうとするとDBが断る(app_con):
    with pytest.raises(pg8000.exceptions.DatabaseError, match="row-level security"):
        with db.as_user(app_con, BOB):
            app_con.run(
                "insert into journal_entries (user_id, entry_date) values (:u, '2026-01-01')", u=ALICE)


def test_他人の仕訳に行を足すことはできない(app_con, alice_entry):
    with pytest.raises(pg8000.exceptions.DatabaseError):
        with db.as_user(app_con, BOB):
            app_con.run(
                "insert into journal_lines (entry_id, user_id, side, account_code, amount)"
                " values (cast(:e as uuid), :u, 'debit', '5190', 1)", e=alice_entry["id"], u=BOB)


def test_誰としてログインしたか分からないときは何も見えない(app_con, alice_entry):
    app_con.run("begin")
    try:
        assert app_con.run("select count(*) from journal_entries")[0][0] == 0
    finally:
        app_con.run("rollback")


def test_アプリ用ユーザーは科目の一覧を書きかえられない(app_con):
    with pytest.raises(pg8000.exceptions.DatabaseError, match="permission denied"):
        with db.as_user(app_con, ALICE):
            app_con.run("update accounts set name = 'x'")
