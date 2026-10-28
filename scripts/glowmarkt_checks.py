#!/usr/bin/env python3
"""
Read-only checks against the Glowmarkt API for the next app release.

For every virtual entity on the account, and every resource in it:
  - name, classifier and base unit
  - /current: does it work (it needs a Glow display)?
  - /readings: half-hourly data for the last 3 days: latest slot with data, so how late the data is,
    plus the last 48 h total (shows the units gas really comes in)
  - /tariff: does it return a standing charge?
  - /last-time: what the platform says is the latest data time (if the endpoint exists)

Only GET requests after logging in. Your password and token are never printed. IDs are cut to the
last 4 characters, so the output is safe to paste into chat.

Run:  python3 scripts/glowmarkt_checks.py
"""
import getpass
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://api.glowmarkt.com/api/v0-1"
APP_ID = "b0f1b774-a586-4f72-9edd-27ead8aa7a8d"


def mask(s):
    s = str(s or "")
    return "…" + s[-4:] if len(s) > 4 else s


def call(method, path, token=None, body=None, params=None):
    url = BASE + path
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    headers = {"Content-Type": "application/json", "applicationId": APP_ID}
    if token:
        headers["token"] = token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(text)
            except ValueError:
                return r.status, text
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")[:200]
        return e.code, text
    except Exception as e:  # network errors
        return None, str(e)


def fmt_epoch(t):
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%d %b %H:%M UTC")


def check_readings(token, rid, now):
    start = (now - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%S")
    end = now.strftime("%Y-%m-%dT%H:%M:%S")
    status, data = call("GET", f"/resource/{rid}/readings", token,
                        params={"from": start, "to": end, "period": "PT30M", "offset": 0, "function": "sum"})
    if status != 200 or not isinstance(data, dict):
        return f"/readings: HTTP {status} {str(data)[:120]}"
    rows = [r for r in data.get("data", []) if isinstance(r, list) and len(r) == 2]
    if not rows:
        return "/readings: OK but no data in the last 3 days"
    with_value = [r for r in rows if r[1] not in (None, 0)]
    last_any = rows[-1][0]
    lines = [f"/readings: {len(rows)} half-hours returned, {len(with_value)} non-zero; last slot {fmt_epoch(last_any)}"]
    if with_value:
        last_val = with_value[-1][0]
        lag_h = (now.timestamp() - last_val) / 3600
        lines.append(f"    latest non-zero slot {fmt_epoch(last_val)} (≈{lag_h:.1f} h ago)")
        cutoff = now.timestamp() - 48 * 3600
        total48 = sum(r[1] for r in rows if r[0] >= cutoff and isinstance(r[1], (int, float)))
        lines.append(f"    total over last 48 h of returned data: {total48:.3f}")
        lines.append(f"    last 4 non-zero values: " + ", ".join(f"{fmt_epoch(t)[7:12]} {v}" for t, v in with_value[-4:]))
    return "\n".join(lines)


def main():
    print("Glowmarkt read-only checks. Use your Bright app login.")
    username = input("Username (email): ").strip()
    password = getpass.getpass("Password (not shown): ")
    status, auth = call("POST", "/auth", body={"username": username, "password": password})
    if status != 200 or not isinstance(auth, dict) or not auth.get("valid"):
        sys.exit(f"Login failed: HTTP {status} {str(auth)[:120]}")
    token = auth["token"]
    exp = auth.get("exp")
    print(f"\nLogged in. Token expires {fmt_epoch(exp) if exp else '?'}.")

    status, ves = call("GET", "/virtualentity", token)
    if status != 200 or not isinstance(ves, list):
        sys.exit(f"Listing virtual entities failed: HTTP {status} {str(ves)[:120]}")
    print(f"{len(ves)} virtual entit{'y' if len(ves) == 1 else 'ies'} on the account.")
    now = datetime.now(timezone.utc)

    for ve in ves:
        veid = ve.get("veId")
        print(f"\n=== Entity {mask(veid)}: \"{ve.get('name')}\" (created {str(ve.get('createdAt'))[:10]})")
        status, full = call("GET", f"/virtualentity/{veid}/resources", token)
        if status != 200 or not isinstance(full, dict):
            print(f"  /resources: HTTP {status} {str(full)[:120]}")
            continue
        resources = full.get("resources", [])
        print(f"  {len(resources)} resources: " + ", ".join(str(r.get("classifier")) for r in resources))
        for r in resources:
            rid = r.get("resourceId")
            print(f"\n  --- {r.get('classifier')} ({r.get('name')}), unit {r.get('baseUnit')}, id {mask(rid)}, active {r.get('active')}")

            s, cur = call("GET", f"/resource/{rid}/current", token)
            if s == 200 and isinstance(cur, dict) and cur.get("data"):
                t, v = cur["data"][0][0], cur["data"][0][1]
                print(f"  /current: OK, {v} at {fmt_epoch(t)}")
            else:
                print(f"  /current: HTTP {s} {str(cur)[:100]}")

            print("  " + check_readings(token, rid, now).replace("\n", "\n  "))

            s, lt = call("GET", f"/resource/{rid}/last-time", token)
            if s == 200:
                print(f"  /last-time: {json.dumps(lt)[:200]}")
            else:
                print(f"  /last-time: HTTP {s}")

            if not str(r.get("classifier", "")).endswith(".cost"):
                s, tariff = call("GET", f"/resource/{rid}/tariff", token)
                if s == 200:
                    text = json.dumps(tariff)
                    has_standing = "standing" in text.lower()
                    print(f"  /tariff: OK, mentions standing charge: {'yes' if has_standing else 'no'}")
                    print(f"  /tariff body (first 600 chars): {text[:600]}")
                else:
                    print(f"  /tariff: HTTP {s} {str(tariff)[:100]}")

    print("\nDone. Paste everything from 'Logged in' down.")


if __name__ == "__main__":
    main()
