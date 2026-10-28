#!/usr/bin/env python3
"""
Tariff-only Glowmarkt check: calls /tariff on every consumption resource with a 2-minute timeout,
and reports how long each call took and what rates it returned.

Only GET requests after logging in. Password and token are never printed; IDs are cut to 4 characters.

Run:  python3 scripts/glowmarkt_tariff_check.py
"""
import getpass
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "https://api.glowmarkt.com/api/v0-1"
APP_ID = "b0f1b774-a586-4f72-9edd-27ead8aa7a8d"
TIMEOUT = 120


def mask(s):
    s = str(s or "")
    return "…" + s[-4:] if len(s) > 4 else s


def call(method, path, token=None, body=None, timeout=30):
    headers = {"Content-Type": "application/json", "applicationId": APP_ID}
    if token:
        headers["token"] = token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode("utf-8", "replace")
            elapsed = time.monotonic() - start
            try:
                return r.status, json.loads(text), elapsed
            except ValueError:
                return r.status, text, elapsed
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:200], time.monotonic() - start
    except Exception as e:
        return None, str(e), time.monotonic() - start


def summarise(tariff):
    """Pull the useful parts out of a /tariff response."""
    out = []
    for entry in (tariff.get("data") or []) if isinstance(tariff, dict) else []:
        rates = entry.get("currentRates")
        structure = entry.get("structure") or []
        sources = sorted({str(s.get("source")) for s in structure if isinstance(s, dict)})
        out.append(f"type {entry.get('type')}, commodity {entry.get('commodity')}, from {entry.get('from')}, "
                   f"source {', '.join(sources) or '?'}, current rates {json.dumps(rates)}")
    return out


def main():
    print(f"Glowmarkt tariff check ({TIMEOUT} s timeout per call). Use your Bright app login.")
    username = input("Username (email): ").strip()
    password = getpass.getpass("Password (not shown): ")
    status, auth, _ = call("POST", "/auth", body={"username": username, "password": password})
    if status != 200 or not isinstance(auth, dict) or not auth.get("valid"):
        sys.exit(f"Login failed: HTTP {status} {str(auth)[:120]}")
    token = auth["token"]
    print("\nLogged in.")

    status, ves, _ = call("GET", "/virtualentity", token)
    if status != 200 or not isinstance(ves, list):
        sys.exit(f"Listing virtual entities failed: HTTP {status}")

    for ve in ves:
        veid = ve.get("veId")
        status, full, _ = call("GET", f"/virtualentity/{veid}/resources", token)
        if status != 200 or not isinstance(full, dict):
            print(f"\nEntity {mask(veid)}: /resources HTTP {status}")
            continue
        print(f"\n=== Entity {mask(veid)}: \"{ve.get('name')}\"")
        for r in full.get("resources", []):
            classifier = str(r.get("classifier", ""))
            if classifier not in ("electricity.consumption", "gas.consumption"):
                continue
            rid = r.get("resourceId")
            print(f"\n  --- {classifier} ({r.get('name')}), id {mask(rid)}")
            for attempt in (1, 2):
                s, tariff, secs = call("GET", f"/resource/{rid}/tariff", token, timeout=TIMEOUT)
                if s == 200:
                    print(f"  attempt {attempt}: OK in {secs:.1f} s")
                    for line in summarise(tariff) or ["(no tariff entries in the response)"]:
                        print(f"    {line}")
                    break
                print(f"  attempt {attempt}: HTTP {s} after {secs:.1f} s: {str(tariff)[:100]}")
                if s == 401:
                    break

    print("\nDone. Paste everything from 'Logged in' down.")


if __name__ == "__main__":
    main()
