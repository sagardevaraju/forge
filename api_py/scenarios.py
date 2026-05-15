"""Task 12 — Vercel Python serverless endpoint wrapping ``generate_scenarios``.

Accepts:

    GET /api/scenarios?storm_id=AL092024&n=1000

Returns a JSON array of scenario dicts.  See ``ml.scenarios.generate`` for
the schema.
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Make ml/ importable when this file is executed by Vercel's Python runtime
# (the function is loaded from a flat working directory).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ml.scenarios.generate import generate_scenarios  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 — Vercel requires this exact name
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        storm_id = (params.get("storm_id") or [""])[0].strip()
        try:
            n = int((params.get("n") or ["1000"])[0])
        except ValueError:
            self._send_json(400, {"error": "n must be an integer"})
            return

        if not storm_id:
            self._send_json(400, {"error": "storm_id required"})
            return
        if n <= 0 or n > 10000:
            self._send_json(400, {"error": "n must be in (0, 10000]"})
            return

        scenarios = generate_scenarios(storm_id, n=n)
        self._send_json(200, scenarios)

    # ── helpers ───────────────────────────────────────────────────────
    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
