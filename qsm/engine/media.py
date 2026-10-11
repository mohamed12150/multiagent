"""Library storage: type sniffing (magic bytes, never the client's claim), probing and thumbnails via ffmpeg
when available, and signed time-limited public links for platforms that pull media (Instagram, TikTok)."""
from __future__ import annotations

import hmac
import json
import logging
import os
import shutil
import subprocess  # nosec B404 — fixed argv, no shell
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from sqlalchemy.orm import Session

from .. import config, security, settings
from ..connectors.base import MediaFile
from ..db import new_id
from ..models import Asset

log = logging.getLogger("qsm.media")
SIGNED_TTL_S = 3600
THUMB_WIDTH = 640
FFMPEG_TIMEOUT_S = 60
MAX_PIXELS = 80_000_000  # ~ 8K × 8K; larger "images" are decompression bombs, not designs
_HEAVY = threading.BoundedSemaphore(2)  # probing/thumbnailing never takes over the worker pool

KINDS = {  # sniffed type → (kind, extension, mime)
    "jpeg": ("image", "jpg", "image/jpeg"), "png": ("image", "png", "image/png"), "gif": ("image", "gif", "image/gif"),
    "webp": ("image", "webp", "image/webp"), "mp4": ("video", "mp4", "video/mp4"),
    "mov": ("video", "mov", "video/quicktime"), "webm": ("video", "webm", "video/webm"),
}


class MediaError(ValueError):
    pass


@dataclass(frozen=True)
class Probe:
    width: int = 0
    height: int = 0
    duration: float = 0.0


def sniff(head: bytes) -> str | None:
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[4:8] == b"ftyp":
        return "mov" if head[8:10] == b"qt" else "mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "webm"
    return None


def media_dir() -> Path:
    d = config.get().media_dir
    (d / "thumbs").mkdir(parents=True, exist_ok=True)
    return d


FFMPEG_DIRS = (Path.home() / ".local/bin", Path("/opt/homebrew/bin"), Path("/usr/local/bin"), Path("/usr/bin"))


def _ffmpeg(name: str) -> str | None:
    """On PATH, or in the usual install folders (services often start with a minimal PATH)."""
    found = shutil.which(name)
    if found:
        return found
    for d in FFMPEG_DIRS:
        candidate = d / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def probe(path: Path) -> Probe:
    exe = _ffmpeg("ffprobe")
    if not exe:
        return Probe()
    try:
        out = subprocess.run(  # nosec B603 — fixed argv
            [exe, "-v", "error", "-protocol_whitelist", "file", "-print_format", "json", "-show_streams", "-show_format",
             str(path)],
            capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=True).stdout
        data = json.loads(out or b"{}")
    except (subprocess.SubprocessError, ValueError, OSError):
        return Probe()
    stream = next((st for st in data.get("streams", []) if st.get("codec_type") == "video"), {})
    dur = float((data.get("format") or {}).get("duration") or 0)
    return Probe(width=int(stream.get("width") or 0), height=int(stream.get("height") or 0), duration=round(dur, 2))


def make_thumb(path: Path, thumb: Path, kind: str) -> bool:
    exe = _ffmpeg("ffmpeg")
    if not exe:
        return False
    args = [exe, "-nostdin", "-y", "-loglevel", "error", "-threads", "1", "-protocol_whitelist", "file"]
    if kind == "video":
        args += ["-ss", "1", "-i", str(path), "-frames:v", "1"]
    else:
        args += ["-i", str(path), "-frames:v", "1"]
    args += ["-vf", f"scale='min({THUMB_WIDTH},iw)':-2", "-q:v", "4", str(thumb)]
    try:
        subprocess.run(args, capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=True)  # nosec B603
    except (subprocess.SubprocessError, OSError):
        return False
    return thumb.exists() and thumb.stat().st_size > 0


def save_upload(stream: BinaryIO, original_name: str, *, uploaded_by: str, folder: str = "عام") -> Asset:
    """Stream to disk with a size cap, sniff the real type, probe, thumbnail. Returns an unsaved Asset."""
    limit = config.get().max_upload_mb * 1024 * 1024
    head = stream.read(16)
    kind_key = sniff(head)
    if kind_key is None:
        raise MediaError("نوع الملف غير مدعوم — المسموح: JPG, PNG, WEBP, GIF, MP4, MOV, WEBM")
    kind, ext, mime = KINDS[kind_key]
    asset_id = new_id()
    target = media_dir() / f"{asset_id}.{ext}"
    size = len(head)
    with target.open("wb") as out:
        out.write(head)
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                out.close()
                target.unlink(missing_ok=True)
                raise MediaError(f"الملف أكبر من الحد المسموح ({config.get().max_upload_mb} ميجابايت)")
            out.write(chunk)
    with _HEAVY:
        info = probe(target)
        if info.width * info.height > MAX_PIXELS:
            target.unlink(missing_ok=True)
            raise MediaError("أبعاد الملف أكبر من المسموح")
        has_thumb = make_thumb(target, media_dir() / "thumbs" / f"{asset_id}.jpg", kind)
    title = Path(original_name).stem[:200] or "ملف"
    return Asset(id=asset_id, kind=kind, file_name=target.name, original_name=original_name[:240], mime=mime,
                 size_bytes=size, width=info.width, height=info.height, duration_s=info.duration,
                 has_thumb=has_thumb, title=title, folder=folder[:80] or "عام", uploaded_by=uploaded_by)


def file_path(asset: Asset) -> Path:
    return media_dir() / Path(asset.file_name).name


def thumb_path(asset: Asset) -> Path:
    return media_dir() / "thumbs" / f"{asset.id}.jpg"


def delete_files(asset: Asset) -> None:
    file_path(asset).unlink(missing_ok=True)
    thumb_path(asset).unlink(missing_ok=True)


def public_base(s: Session) -> str:
    return (settings.get(s, "general").public_base_url or config.get().public_base_url).rstrip("/")


def signature(asset_id: str, exp: int) -> str:
    return security.sign(f"media:{asset_id}:{exp}", config.get().secret_key)


def signed_url(s: Session, asset: Asset) -> str:
    base = public_base(s)
    if not base:
        return ""
    exp = int(time.time()) + SIGNED_TTL_S
    return f"{base}/m/{asset.id}.{Path(asset.file_name).suffix.lstrip('.')}?exp={exp}&sig={signature(asset.id, exp)}"


def verify(asset_id: str, exp: int, sig: str) -> bool:
    return exp >= int(time.time()) and hmac.compare_digest(signature(asset_id, exp).encode(), sig.encode())


def media_files(s: Session, asset_ids: list[str]) -> tuple[MediaFile, ...]:
    out = []
    for aid in asset_ids:
        asset = s.get(Asset, aid)
        if asset is None or asset.status != "approved":
            continue
        path = file_path(asset)
        if path.exists():
            out.append(MediaFile(path=path, mime=asset.mime, kind=asset.kind, size=asset.size_bytes,
                                 public_url=signed_url(s, asset)))
    return tuple(out)
