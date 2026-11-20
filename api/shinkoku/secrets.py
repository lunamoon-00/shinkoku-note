"""鍵（LINE・Gemini）の取り出し。

AWS では Systems Manager のパラメータストア（暗号化された「安全な文字列」）から読む。
一度読んだら Lambda の箱が生きている間は覚えておく（毎回読むと遅くなるため）。
テストでは環境変数 SHINKOKU_SECRET_<名前> で上書きできる（例：SHINKOKU_SECRET_LINE_CHANNEL_SECRET）。
"""

from __future__ import annotations

import os

NAMES = {
    "line_channel_secret": "/shinkoku/line/channel-secret",
    "line_channel_access_token": "/shinkoku/line/channel-access-token",
    "gemini_api_key": "/shinkoku/gemini/api-key",
}

_cache: dict[str, str] = {}


def get(name: str) -> str:
    override = os.environ.get(f"SHINKOKU_SECRET_{name.upper()}")
    if override is not None:
        return override
    if name not in _cache:
        import boto3

        res = boto3.client("ssm").get_parameter(Name=NAMES[name], WithDecryption=True)
        _cache[name] = res["Parameter"]["Value"]
    return _cache[name]
