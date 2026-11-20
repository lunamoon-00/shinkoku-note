"""LINE（Messaging API）とのやりとり。

- 届いた通知が本物の LINE からか、合言葉（チャネルシークレット）で作った署名で確かめる
- 返事（reply：無料・届いてすぐだけ使える）と、こちらから送る（push：月の上限あり）
- 送られてきた写真を取ってくる
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import urllib.error
import urllib.request

from . import secrets

API = "https://api.line.me/v2/bot"
DATA_API = "https://api-data.line.me/v2/bot"
MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10MB をこえる写真は断る


class LineError(Exception):
    pass


def verify_signature(body: bytes, signature: str, channel_secret: str) -> bool:
    """LINE は本文を合言葉で HMAC-SHA256 して、x-line-signature に入れてくる。同じ計算をして比べる。"""
    if not signature:
        return False
    expected = base64.b64encode(hmac.new(channel_secret.encode(), body, hashlib.sha256).digest()).decode()
    return hmac.compare_digest(expected, signature)  # 時間差で中身を推測されないように、比べ方も安全に


def _request(method: str, url: str, body: dict | None = None, timeout: int = 10) -> bytes:
    """LINE の API を呼ぶ（テストではこの関数を差しかえる）"""
    headers = {"authorization": f"Bearer {secrets.get('line_channel_access_token')}"}
    data = None
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            content = res.read(MAX_IMAGE_BYTES + 1)
            if len(content) > MAX_IMAGE_BYTES:
                raise LineError("写真が大きすぎます")
            return content
    except urllib.error.HTTPError as e:
        raise LineError(f"LINE API {e.code}: {e.read()[:200]!r}") from e


def text(message: str) -> dict:
    return {"type": "text", "text": message[:4900]}


def reply(reply_token: str, messages: list[dict]) -> None:
    _request("POST", f"{API}/message/reply", {"replyToken": reply_token, "messages": messages})


def push(line_user_id: str, messages: list[dict]) -> None:
    _request("POST", f"{API}/message/push", {"to": line_user_id, "messages": messages})


def reply_or_push(reply_token: str | None, line_user_id: str, messages: list[dict]) -> None:
    """まず無料の reply で返し、期限切れなどで失敗したら push で送る"""
    if reply_token:
        try:
            reply(reply_token, messages)
            return
        except LineError:
            pass
    push(line_user_id, messages)


def get_content(message_id: str) -> bytes:
    return _request("GET", f"{DATA_API}/message/{message_id}/content", timeout=20)
