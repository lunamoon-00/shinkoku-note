"""api/ の勘定科目のSQL（0002_accounts.sql）から、お試しモード用の JSON を作る。
科目を変えたら `python scripts/gen-mock-accounts.py` を流しなおす（テストで差がないか確かめている）。"""
import json, re, pathlib
root = pathlib.Path(__file__).resolve().parents[2]
sql = (root / "api/shinkoku/migrations/0002_accounts.sql").read_text(encoding="utf-8")
rows = re.findall(r"^\('(\d+)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'(\w+)',\s*'(\w+)',\s*(null|'[^']*'),\s*(\d+)\)", sql, re.M)
keys = ["code", "name", "friendly_name", "description", "kind", "normal_side", "white_line", "sort_order"]
out = []
for r in rows:
    d = dict(zip(keys, r))
    d["white_line"] = None if d["white_line"] == "null" else d["white_line"].strip("'")
    d["sort_order"] = int(d["sort_order"])
    out.append(d)
out.sort(key=lambda d: d["sort_order"])
for d in out: d.pop("sort_order")
(root / "web/lib/mock-accounts.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(len(out), "accounts")
