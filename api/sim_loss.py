"""Vercel Python function entrypoint for the K=1000 sim-loss model.

Vercel only auto-detects Python serverless functions under the `/api`
directory, so this thin wrapper lives here and re-exports the real
`handler` (a `BaseHTTPRequestHandler`) from `api_py.sim_loss`. The substantive
logic stays in the `api_py` package so the dev spawn path and the test suite
keep importing it as `from api_py.sim_loss import ...`.

We add the repo root to `sys.path` so the `from api_py...` imports resolve
inside the Vercel function bundle (the `api_py/**` tree is bundled via
`includeFiles` in vercel.json). Deployed route: POST /api/sim_loss — the
promote route fetches it in production.
"""
import os
import sys

# Repo root = parent of this file's directory (/api → repo root).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api_py.sim_loss import handler  # noqa: E402  (re-exported for Vercel)

__all__ = ["handler"]
