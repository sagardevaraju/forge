"""Task P3.24 — Dockerfile contract tests.

These pin the version pins + the multi-stage shape so a future edit
that silently un-pins a runtime image doesn't slip in unnoticed.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = REPO_ROOT / "Dockerfile"
DOCKERIGNORE = REPO_ROOT / ".dockerignore"


def _read_dockerfile() -> str:
    if not DOCKERFILE.exists():
        pytest.skip("Dockerfile missing — P3.24 not landed yet?")
    return DOCKERFILE.read_text()


def test_dockerfile_exists():
    assert DOCKERFILE.exists(), "P3.24 Dockerfile must exist"


def test_dockerignore_exists():
    assert DOCKERIGNORE.exists(), "P3.24 .dockerignore must exist"


def test_node_image_is_pinned_to_lts():
    """Node base image must pin to a specific version (no `:latest`)."""
    text = _read_dockerfile()
    # Expect node:<major>.<minor>.<patch>-<flavor> form somewhere.
    matches = re.findall(r"FROM node:(\S+)", text)
    assert matches, "no node base image found"
    for tag in matches:
        assert tag != "latest", "Node image must not pin to :latest"
        assert re.match(r"\d+\.\d+\.\d+", tag), (
            f"Node tag '{tag}' must include a patch version (X.Y.Z)"
        )


def test_python_image_is_pinned_to_312():
    """Python base must pin to 3.12.x per CLAUDE.md vercel.json runtime."""
    text = _read_dockerfile()
    matches = re.findall(r"FROM python:(\S+)", text)
    assert matches, "no python base image found"
    pinned = False
    for tag in matches:
        if tag.startswith("3.12."):
            pinned = True
            break
    assert pinned, "Python image must pin to 3.12.x (per CLAUDE.md)"


def test_dockerfile_uses_multi_stage_build():
    """Three stages: node-build → py-build → runtime."""
    text = _read_dockerfile()
    assert "AS node-build" in text, "stage 'node-build' required"
    assert "AS py-build" in text, "stage 'py-build' required"
    assert "AS runtime" in text, "stage 'runtime' required"


def test_dockerfile_installs_cbc_solver():
    """The runtime stage must install coinor-cbc so PuLP solves work."""
    text = _read_dockerfile()
    assert "coinor-cbc" in text, "coinor-cbc apt package required for PuLP"


def test_dockerfile_does_not_install_training_deps():
    """Per CLAUDE.md, requirements-train.txt (torch + timm) MUST NOT
    be bundled into runtime images. Mentions in comments are fine; an
    actual `pip install -r requirements-train.txt` invocation is not."""
    text = _read_dockerfile()
    # Strip line comments before checking — the warning comment is
    # allowed; the install command is not.
    code_lines = [
        line for line in text.splitlines()
        if not line.strip().startswith("#")
    ]
    code = "\n".join(code_lines)
    assert "requirements-train.txt" not in code, (
        "requirements-train.txt must NOT be installed into the runtime image "
        "(see CLAUDE.md — 'ml/ deps must not be bundled into Vercel functions' "
        "and that constraint carries over to Docker)"
    )


def test_dockerfile_uses_nextjs_standalone_output():
    """Next.js standalone output keeps the image slim."""
    text = _read_dockerfile()
    assert "standalone" in text, "Next.js standalone output expected"


def test_dockerfile_sets_pythonpath_and_unbuffered():
    """Subprocess spawns need PYTHONPATH=/app and PYTHONUNBUFFERED=1."""
    text = _read_dockerfile()
    assert "PYTHONPATH=/app" in text
    assert "PYTHONUNBUFFERED=1" in text


def test_dockerignore_excludes_local_db_and_caches():
    """forge-local.db and big artifacts must not be slurped into the
    build context."""
    text = DOCKERIGNORE.read_text()
    for pattern in (
        "node_modules",
        ".next",
        "__pycache__",
        "forge-local.db",
        "artifacts/simulations",
    ):
        assert pattern in text, f"{pattern} must be in .dockerignore"
