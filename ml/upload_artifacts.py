"""
FORGE — Artifact uploader for Vercel Blob storage.

This module uploads generated artifact files (e.g. cv_features.parquet,
cv_head.pt) to Vercel Blob for persistent cloud storage accessible by the
Next.js app and other services.

Behaviour
---------
- If ``BLOB_READ_WRITE_TOKEN`` is not set in the environment, the upload
  is skipped gracefully (a warning is printed, no exception raised).
- When the token is present, files are uploaded via the Vercel Blob REST
  API and the resulting public URL is returned.

Real upload path (for when credentials land)
--------------------------------------------
  1. Set BLOB_READ_WRITE_TOKEN in your environment or .env.local.
  2. Call:
       python -c "from ml.upload_artifacts import upload_artifact; print(upload_artifact('artifacts/cv_features.parquet'))"
  3. Store the returned URL in your Vercel env / DB as needed.

References
----------
  Vercel Blob REST API:
    https://vercel.com/docs/storage/vercel-blob/using-blob-sdk#put
  Python requests lib (used here; no SDK dependency):
    https://docs.python-requests.org/
"""

from __future__ import annotations

import os
import warnings
from pathlib import Path
from typing import Optional


def upload_artifact(
    file_path: str | Path,
    blob_pathname: str | None = None,
    content_type: str = "application/octet-stream",
) -> Optional[str]:
    """Upload a local file to Vercel Blob storage.

    Parameters
    ----------
    file_path:
        Local path to the file to upload.
    blob_pathname:
        The path/name to use in Blob storage. Defaults to the file's name.
    content_type:
        MIME type for the upload.

    Returns
    -------
    str or None
        The public URL of the uploaded blob, or ``None`` if the upload was
        skipped (no token set).

    Notes
    -----
    The function is intentionally no-op when ``BLOB_READ_WRITE_TOKEN`` is
    absent — it will warn and return ``None`` rather than raise.
    """
    token = os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()

    if not token:
        warnings.warn(
            "BLOB_READ_WRITE_TOKEN is not set — skipping Vercel Blob upload for "
            f"'{file_path}'. Set the token when credentials are available.",
            stacklevel=2,
        )
        return None

    file_path = Path(file_path)
    if not file_path.exists():
        warnings.warn(
            f"Artifact file not found: {file_path} — skipping upload.",
            stacklevel=2,
        )
        return None

    if blob_pathname is None:
        blob_pathname = file_path.name

    # Lazy import — requests is in requirements.txt but we don't want to
    # force the import at module level in no-op environments.
    try:
        import requests  # noqa: PLC0415
    except ImportError as exc:
        raise RuntimeError(
            "The 'requests' package is required for Vercel Blob uploads. "
            "Install via: pip install requests"
        ) from exc

    # Vercel Blob REST API — multipart PUT
    # Reference: https://vercel.com/docs/storage/vercel-blob/using-blob-sdk#put
    api_url = f"https://blob.vercel-storage.com/{blob_pathname}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type,
        "x-content-type": content_type,
    }

    file_size = file_path.stat().st_size
    print(f"[upload_artifact] Uploading '{file_path.name}' ({file_size:,} bytes) → {api_url}")

    with file_path.open("rb") as fh:
        response = requests.put(api_url, headers=headers, data=fh, timeout=120)

    if response.status_code not in (200, 201):
        raise RuntimeError(
            f"Vercel Blob upload failed with status {response.status_code}: "
            f"{response.text}"
        )

    blob_url: str = response.json().get("url", api_url)
    print(f"[upload_artifact] Upload successful → {blob_url}")
    return blob_url


def upload_cv_features(
    parquet_path: str | Path | None = None,
) -> Optional[str]:
    """Convenience wrapper to upload the CV features parquet artifact.

    Parameters
    ----------
    parquet_path:
        Path to the parquet file. Defaults to
        ``artifacts/cv_features.parquet`` relative to the repo root.

    Returns
    -------
    str or None
        The public blob URL, or None if skipped.
    """
    if parquet_path is None:
        repo_root = Path(__file__).resolve().parent.parent
        parquet_path = repo_root / "artifacts" / "cv_features.parquet"

    return upload_artifact(
        file_path=parquet_path,
        blob_pathname="forge/cv_features.parquet",
        content_type="application/octet-stream",
    )


def upload_cv_head(
    head_path: str | Path | None = None,
) -> Optional[str]:
    """Convenience wrapper to upload the trained MLP head weights.

    Parameters
    ----------
    head_path:
        Path to the PyTorch weights file. Defaults to
        ``artifacts/cv_head.pt`` relative to the repo root.

    Returns
    -------
    str or None
        The public blob URL, or None if skipped.
    """
    if head_path is None:
        repo_root = Path(__file__).resolve().parent.parent
        head_path = repo_root / "artifacts" / "cv_head.pt"

    return upload_artifact(
        file_path=head_path,
        blob_pathname="forge/cv_head.pt",
        content_type="application/octet-stream",
    )
