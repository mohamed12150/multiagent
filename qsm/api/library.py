"""The media library (no design workspace): upload, describe, approve designs, serve files.

Agents only ever use `approved` files — the approval here is the platform's «اعتماد التصميم»."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import events
from ..agents.runtime import enqueue
from ..engine import approvals, media
from ..models import Approval, Asset, Post, User
from . import serial
from .deps import ApiError, actor, cap, found, get_db, ok, viewer

router = APIRouter(tags=["library"])
MAX_FILES = 20


@router.get("/api/library")
def list_assets(kind: str | None = None, status: str | None = None, folder: str | None = None,
                q: str | None = None, limit: int = Query(300, ge=1, le=1000), _: User = Depends(viewer),
                s: Session = Depends(get_db, scope="function")) -> dict:
    query = select(Asset)
    if kind:
        query = query.where(Asset.kind == kind)
    if status:
        query = query.where(Asset.status == status)
    if folder:
        query = query.where(Asset.folder == folder)
    if q:
        like = f"%{q.strip()[:80]}%"
        query = query.where(Asset.title.like(like) | Asset.description.like(like) | Asset.original_name.like(like))
    rows = s.scalars(query.order_by(Asset.created_at.desc()).limit(limit)).all()
    folders = [f for f, in s.execute(select(Asset.folder).group_by(Asset.folder)).all()]
    counts = {st: int(n) for st, n in s.execute(select(Asset.status, func.count()).group_by(Asset.status)).all()}
    return ok([serial.asset(a) for a in rows], folders=folders, counts=counts)


@router.get("/api/library/{asset_id}")
def get_asset(asset_id: str, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    return ok(serial.asset(found(s.get(Asset, asset_id), "الملف")))


@router.post("/api/library")
def upload(files: list[UploadFile] = File(...), folder: str = Form("عام"), user: User = Depends(cap("library")),
           s: Session = Depends(get_db, scope="function")) -> dict:
    if len(files) > MAX_FILES:
        raise ApiError(422, "too_many", f"ارفع {MAX_FILES} ملفًا كحد أقصى في المرة")
    saved, errors = [], []
    for f in files:
        try:
            asset = media.save_upload(f.file, f.filename or "file", uploaded_by=actor(user), folder=folder.strip())
        except media.MediaError as exc:
            errors.append({"name": f.filename, "error": str(exc)})
            continue
        s.add(asset)
        s.flush()
        approvals.request(s, "asset", ref_id=asset.id, agent_id="content", title=f"تصميم جديد: {asset.title}",
                          summary=f"{'مقطع' if asset.kind == 'video' else 'صورة'} في مجلد {asset.folder}",
                          payload={"kind": asset.kind, "thumb": f"/api/library/{asset.id}/thumb"})
        enqueue(s, kind="content.describe_asset", title=f"وصف ملف: {asset.title}", input={"asset_id": asset.id},
                created_by=actor(user), origin="event", priority=6)
        saved.append(serial.asset(asset))
    if saved:
        events.record(s, "library.upload", f"رُفع {len(saved)} ملف إلى المكتبة", actor=actor(user))
    return ok(saved, errors=errors)


class AssetPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    tags: list[str] | None = Field(default=None, max_length=30)
    folder: str | None = Field(default=None, max_length=80)


@router.patch("/api/library/{asset_id}")
def update_asset(asset_id: str, body: AssetPatch, _: User = Depends(cap("library")),
                 s: Session = Depends(get_db, scope="function")) -> dict:
    a = found(s.get(Asset, asset_id), "الملف")
    if body.title is not None:
        a.title = body.title.strip() or a.title
    if body.description is not None:
        a.description = body.description.strip()
    if body.tags is not None:
        a.tags = list(dict.fromkeys(t.strip("# ").strip() for t in body.tags if t.strip()))
    if body.folder is not None:
        a.folder = body.folder.strip() or "عام"
    return ok(serial.asset(a))


class ReviewIn(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=1000)


def review_asset(s: Session, a: Asset, approve: bool, note: str, by: str) -> None:
    a.status, a.review_note = ("approved" if approve else "rejected"), note
    events.record(s, "library.review", f"{'اعتُمد' if approve else 'رُفض'} التصميم «{a.title}»", actor=by,
                  ref_kind="asset", ref_id=a.id)


@approvals.resolver("asset")
def _resolve_asset(s: Session, approval: Approval, approved: bool) -> None:
    a = s.get(Asset, approval.ref_id)
    if a is not None and a.status == "pending":
        review_asset(s, a, approved, approval.note, approval.decided_by)


@router.post("/api/library/{asset_id}/review")
def review(asset_id: str, body: ReviewIn, user: User = Depends(cap("approve")), s: Session = Depends(get_db, scope="function")) -> dict:
    a = found(s.get(Asset, asset_id), "الملف")
    pending = s.scalar(select(Approval).where(Approval.kind == "asset", Approval.ref_id == asset_id,
                                              Approval.status == "pending"))
    if pending is not None:
        approvals.decide(s, pending.id, body.approve, by=actor(user), note=body.note)
    else:
        review_asset(s, a, body.approve, body.note, actor(user))
    return ok(serial.asset(a))


@router.delete("/api/library/{asset_id}")
def delete_asset(asset_id: str, _: User = Depends(cap("approve")), s: Session = Depends(get_db, scope="function")) -> dict:
    a = found(s.get(Asset, asset_id), "الملف")
    in_use = s.scalars(select(Post).where(Post.status.in_(("review", "approved", "scheduled", "publishing")))).all()
    if any(asset_id in (p.asset_ids or []) for p in in_use):
        raise ApiError(409, "in_use", "الملف مستخدم في منشور قادم — أزله من المنشور أولًا")
    approvals.cancel_for(s, "asset", asset_id)
    media.delete_files(a)
    s.delete(a)
    return ok()


@router.get("/api/library/{asset_id}/file")
def asset_file(asset_id: str, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> FileResponse:
    a = found(s.get(Asset, asset_id), "الملف")
    path = media.file_path(a)
    if not path.exists():
        raise ApiError(404, "missing_file", "الملف مفقود من التخزين")
    return FileResponse(path, media_type=a.mime, headers={"Cache-Control": "private, max-age=3600"})


@router.get("/api/library/{asset_id}/thumb")
def asset_thumb(asset_id: str, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> FileResponse:
    a = found(s.get(Asset, asset_id), "الملف")
    path = media.thumb_path(a) if a.has_thumb else media.file_path(a)
    if not path.exists() or (not a.has_thumb and a.kind == "video"):
        raise ApiError(404, "no_thumb", "لا توجد صورة مصغرة")
    return FileResponse(path, media_type="image/jpeg" if a.has_thumb else a.mime,
                        headers={"Cache-Control": "private, max-age=86400"})


@router.get("/m/{name}")
def public_media(name: str, exp: int, sig: str, s: Session = Depends(get_db, scope="function")) -> FileResponse:
    """Signed, time-limited link for platforms that pull media (Instagram, TikTok). No session needed."""
    asset_id = name.split(".", 1)[0]
    if not media.verify(asset_id, exp, sig):
        raise ApiError(403, "bad_signature", "الرابط منتهي أو غير صالح")
    a = found(s.get(Asset, asset_id), "الملف")
    if a.status != "approved":
        raise ApiError(403, "not_approved", "الملف غير معتمد")
    return FileResponse(media.file_path(a), media_type=a.mime)

