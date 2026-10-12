"""Daily reports from the coordinator: list, read, regenerate, resend, preview the email."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import db, settings
from ..agents.runtime import enqueue, task_dict
from ..engine import notify
from ..engine import reports as render
from ..models import Report, User
from . import serial
from .deps import actor, cap, found, get_db, ok, viewer

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("")
def list_reports(limit: int = Query(60, ge=1, le=365), _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    rows = s.scalars(select(Report).order_by(Report.created_at.desc()).limit(limit)).all()
    return ok([serial.report(r, full=False) for r in rows])


@router.post("/generate")
def generate(user: User = Depends(cap("reports")), s: Session = Depends(get_db, scope="function")) -> dict:
    t = enqueue(s, kind="coordinator.daily_report", title="تقرير الإنجاز (طلب المالك)", created_by=actor(user),
                origin="user", priority=1)
    return ok(task_dict(t))


@router.get("/{report_id}")
def get_report(report_id: str, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    r = found(s.get(Report, report_id), "التقرير")
    base = settings.get(s, "general").public_base_url
    return ok({**serial.report(r), "whatsapp_text": render.whatsapp_text(r, base)})


@router.get("/{report_id}/email", response_class=HTMLResponse)
def email_preview(report_id: str, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> HTMLResponse:
    r = found(s.get(Report, report_id), "التقرير")
    return HTMLResponse(render.email_html(r, settings.get(s, "general").public_base_url),
                        headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"})


@router.post("/{report_id}/send")
async def send(report_id: str, user: User = Depends(cap("reports"))) -> dict:
    with db.session() as s:
        r = found(s.get(Report, report_id), "التقرير")
        base = settings.get(s, "general").public_base_url
        wa, html, title = render.whatsapp_text(r, base), render.email_html(r, base), r.title
    deliveries = await notify.deliver("report", subject=title, text=wa, html=html)
    with db.session() as s:
        r = s.get(Report, report_id)
        r.deliveries = [*(r.deliveries or []), *deliveries]
        out = serial.report(r)
    return ok(out)
