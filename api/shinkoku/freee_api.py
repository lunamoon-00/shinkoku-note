"""freee（会計）の API とのやりとり。

- OAuth：許可画面の URL を作る／戻ってきた code を鍵（トークン）にかえる／鍵が切れたら更新する
- 鍵は AWS の金庫（パラメータストア・暗号化）に、利用者ごとにしまう
- API を呼ぶ（鍵が切れていたら1回だけ更新してやりなおす）
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from . import secrets

AUTHORIZE_URL = "https://accounts.secure.freee.co.jp/public_api/authorize"
TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token"
API = "https://api.freee.co.jp"

secrets.NAMES.update({
    "freee_client_id": "/shinkoku/freee/client-id",
    "freee_client_secret": "/shinkoku/freee/client-secret",
})


class FreeeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class NotConnected(Exception):
    """freee とつながっていない（鍵がない・取り消された）"""


def redirect_uri() -> str:
    return os.environ["FREEE_REDIRECT_URI"]


def authorize_url(state: str) -> str:
    q = urllib.parse.urlencode({
        "client_id": secrets.get("freee_client_id"),
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "state": state,
        "prompt": "select_company",  # どの事業所につなぐか選んでもらう
    })
    return f"{AUTHORIZE_URL}?{q}"


# ───────── HTTP（テストではこの関数を差しかえる） ─────────
def http(method: str, url: str, *, headers: dict | None = None, body: bytes | None = None, timeout: int = 15) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# ───────── 鍵（トークン）のしまい場所 ─────────
def _param(user_id: str) -> str:
    return f"/shinkoku/freee/tokens/{user_id}"


class TokenStore:
    """AWS の金庫（パラメータストア）。テストではメモリの辞書に差しかえる"""

    def get(self, user_id: str) -> dict | None:
        import boto3

        ssm = boto3.client("ssm")
        try:
            res = ssm.get_parameter(Name=_param(user_id), WithDecryption=True)
        except ssm.exceptions.ParameterNotFound:
            return None
        return json.loads(res["Parameter"]["Value"])

    def put(self, user_id: str, token: dict) -> None:
        import boto3

        boto3.client("ssm").put_parameter(
            Name=_param(user_id), Value=json.dumps(token), Type="SecureString", Overwrite=True, Tier="Standard"
        )

    def delete(self, user_id: str) -> None:
        import boto3

        try:
            boto3.client("ssm").delete_parameter(Name=_param(user_id))
        except Exception:
            pass


def _token_request(form: dict) -> dict:
    form = {**form, "client_id": secrets.get("freee_client_id"), "client_secret": secrets.get("freee_client_secret")}
    status, body = http(
        "POST", TOKEN_URL,
        headers={"content-type": "application/x-www-form-urlencoded"},
        body=urllib.parse.urlencode(form).encode(),
    )
    if status != 200:
        raise FreeeError(status, f"freee の鍵をもらえませんでした（{status}）")
    data = json.loads(body)
    return {
        "access_token": data["access_token"],
        "refresh_token": data["refresh_token"],
        "expires_at": int(time.time()) + int(data.get("expires_in", 21600)) - 300,  # 5分早めに更新
    }


def exchange_code(code: str) -> dict:
    return _token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri()})


def refresh(token: dict) -> dict:
    """freee の更新用の鍵は、使うたびに新しくなる（古いものは使えなくなる）ので、必ずしまいなおす"""
    return _token_request({"grant_type": "refresh_token", "refresh_token": token["refresh_token"]})


# ───────── API を呼ぶ ─────────
class Client:
    def __init__(self, user_id: str, store: TokenStore | None = None):
        self.user_id = user_id
        self.store = store or TokenStore()
        self._token: dict | None = None

    def _access_token(self, force_refresh: bool = False) -> str:
        if self._token is None:
            self._token = self.store.get(self.user_id)
        if not self._token:
            raise NotConnected()
        if force_refresh or self._token["expires_at"] <= time.time():
            try:
                self._token = refresh(self._token)
            except FreeeError as e:
                if e.status in (400, 401):
                    raise NotConnected() from e  # 許可が取り消された・期限切れ → つなぎなおしてもらう
                raise
            self.store.put(self.user_id, self._token)
        return self._token["access_token"]

    def request(self, method: str, path: str, *, query: dict | None = None, json_body: dict | None = None,
                multipart: tuple[dict, tuple[str, bytes, str]] | None = None):
        url = f"{API}{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
        for attempt in (0, 1):
            headers = {"authorization": f"Bearer {self._access_token(force_refresh=attempt == 1)}", "accept": "application/json"}
            body = None
            if json_body is not None:
                headers["content-type"] = "application/json"
                body = json.dumps(json_body, ensure_ascii=False).encode()
            elif multipart is not None:
                ctype, body = _multipart(*multipart)
                headers["content-type"] = ctype
            status, raw = http(method, url, headers=headers, body=body, timeout=30)
            if status == 401 and attempt == 0:
                continue  # 鍵が切れていた → 更新してもう1回
            if status >= 400:
                raise FreeeError(status, f"freee API {method} {path} → {status}: {raw[:300].decode('utf-8', 'replace')}")
            return json.loads(raw) if raw else None
        raise FreeeError(401, "freee の鍵が使えません")

    def get(self, path, **q):
        return self.request("GET", path, query=q)

    def post(self, path, body):
        return self.request("POST", path, json_body=body)

    def delete(self, path, **q):
        return self.request("DELETE", path, query=q)


def _multipart(fields: dict, file: tuple[str, bytes, str]) -> tuple[str, bytes]:
    """ファイルを送る形（multipart/form-data）を組み立てる"""
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    filename, content, mime = file
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="receipt"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n".encode() + content + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return f"multipart/form-data; boundary={boundary}", b"".join(parts)
