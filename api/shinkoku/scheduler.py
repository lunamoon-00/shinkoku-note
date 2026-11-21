"""目覚まし係（EventBridge Scheduler から決まった時間に呼ばれる）。

- task = "recurring"：毎朝6時。くり返し設定の記録日が来た分を記録する
- task = "review_reminder"：毎週月曜9時。確認待ちがある人に LINE でお知らせ
1人ぶんの失敗で、ほかの人の処理を止めない。
"""

from __future__ import annotations

import json
import traceback

from . import db, freee_worker, line, recurring


def _all(con, sql: str) -> list:
    con.run("begin")
    try:
        rows = con.run(sql)
        con.run("commit")
        return rows
    except BaseException:
        con.run("rollback")
        raise


def run_recurring(con, today) -> dict:
    users = [u for (u,) in _all(con, "select * from users_with_recurring_rules()")]
    created = failed = 0
    for user_id in users:
        try:
            with db.as_user(con, user_id):
                created += recurring.run_for_user(con, user_id, today)
        except Exception:
            failed += 1
            traceback.print_exc()
    return {"users": len(users), "created": created, "failed": failed}


def sweep_freee(con, sync=None) -> dict:
    """freee に送れていない記録の見回り（送る係が起こせなかった分・失敗した分をやりなおす）"""
    sync = sync or freee_worker.sync
    users = [u for (u,) in _all(con, "select * from users_with_pending_freee()")]
    sent = failed = 0
    for user_id in users:
        try:
            r = sync(user_id)
            sent += r["sent"]
            failed += r["failed"]
        except Exception:
            failed += 1
            traceback.print_exc()
    return {"freee_users": len(users), "freee_sent": sent, "freee_failed": failed}


def send_review_reminders(con) -> dict:
    rows = _all(con, "select user_id, line_user_id, drafts from users_to_remind()")
    sent = failed = 0
    for _user_id, line_user_id, drafts in rows:
        try:
            line.push(line_user_id, [line.text(
                f"📝 確認待ちの記録が {drafts}件 あるよ\n"
                "アプリの「一覧」→「確認待ち」から、中身を見て確定してね（科目を直すと、次から覚えるよ）"
            )])
            sent += 1
        except Exception:
            failed += 1
            traceback.print_exc()
    return {"sent": sent, "failed": failed}


def handler(event, context):  # Lambda の入口
    task = (event or {}).get("task")
    con = db.shared_connection()
    if task == "recurring":
        result = run_recurring(con, recurring.today_jst())
        result.update(sweep_freee(con))  # 朝の記録のあとに、freee への送り残しも送る
    elif task == "review_reminder":
        result = send_review_reminders(con)
    else:
        raise ValueError(f"知らない task です: {task!r}")
    print(json.dumps({"task": task, **result}))
    # くり返しの記録は、何回やりなおしても二重にならないので、失敗したらエラーにして目覚ましにやりなおしてもらう。
    # お知らせは、やりなおすと届いた人にも2回送ってしまうので、エラーにしない（ログには残る）
    if task == "recurring" and result.get("failed"):
        raise RuntimeError(f"{result['failed']}人分 失敗しました")
    return result
