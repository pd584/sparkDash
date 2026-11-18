#!/usr/bin/env python3
"""sparkDash hermes occupancy bridge.

Reads the gateway routing index (gateway_routing in the shared state.db)
and serves the sparkDash helper contract:
  GET / -> {observedAt, adapters:{hermes:{...}}, rows:[...]}

Read-only, stdlib-only. Sessions surface as harness=hermes rows; spark
attribution comes from the route registered in the panel (configured
provenance), never fabricated here.

Binding: igor's LAN IP so the sparkDash container can reach it
(SPARKDASH_HELPER_HOSTS must list this host).
"""
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_DB = os.environ.get("HERMES_STATE_DB", os.path.expanduser("~/larry-hermes/state.db"))
BIND = os.environ.get("BRIDGE_BIND", "0.0.0.0")
PORT = int(os.environ.get("BRIDGE_PORT", "8124"))
MAX_AGE_DAYS = float(os.environ.get("BRIDGE_MAX_AGE_DAYS", "14"))
ROW_CAP = int(os.environ.get("BRIDGE_ROW_CAP", "200"))

def iso(value):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except ValueError:
        return None

def build_payload():
    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)
    rows = []
    con = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True)
    try:
        cur = con.execute(
            "SELECT scope, entry_json FROM gateway_routing ORDER BY updated_at DESC LIMIT ?",
            (ROW_CAP * 4,),
        )
        for scope, raw in cur:
            try:
                entry = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                continue
            updated = entry.get("updated_at")
            parsed = None
            try:
                parsed = datetime.fromisoformat(str(updated)) if updated else None
            except ValueError:
                parsed = None
            if parsed is not None:
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                if parsed < cutoff:
                    continue
            key = entry.get("session_key") or ""
            parts = key.split(":")
            profile = parts[1] if len(parts) > 1 and parts[0] == "agent" else ""
            platform = entry.get("platform") or (parts[2] if len(parts) > 2 else "")
            display = entry.get("display_name") or ""
            short = key.rsplit(":", 1)[-1]
            title = " · ".join(x for x in (display or f"{profile or 'agent'}/{platform or 'session'}", short[:8]) if x)
            row = {
                "harness": "hermes",
                "sessionId": entry.get("session_id") or key,
                "title": title[:120],
                "updatedAt": iso(updated) or datetime.now(timezone.utc).isoformat(),
            }
            if profile:
                row["agent"] = profile
            ctx = entry.get("last_prompt_tokens")
            if isinstance(ctx, int) and ctx > 0:
                row["contextUsed"] = ctx
            rows.append(row)
            if len(rows) >= ROW_CAP:
                break
    finally:
        con.close()
    return {
        "schemaVersion": 1,
        "observedAt": int(time.time() * 1000),
        "source": {
            "bridge": "hermes-bridge",
            "host": BIND,
            "db": STATE_DB,
        },
        "adapters": {
            "hermes": {"coverage": "supported", "stale": False, "rows": len(rows)},
        },
        "rows": rows,
    }

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        try:
            if self.path.startswith("/health"):
                body = json.dumps({"ok": True, "ts": time.time()}).encode()
            else:
                body = json.dumps(build_payload()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as err:  # keep the poller's error path clean
            body = json.dumps({"error": str(err)[:300]}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002
        pass

if __name__ == "__main__":
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"hermes occupancy bridge on http://{BIND}:{PORT}/ db={STATE_DB}", file=sys.stderr)
    server.serve_forever()
