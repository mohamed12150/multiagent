"""الحارس — sweeps the whole system, fixes what a safe playbook can fix without the owner, and reports every fix.

Each check returns findings; each finding names a playbook. With `auto_fix` = auto the playbook runs at once;
with `approve` it waits on the approval desk; with `off` the owner is only told. Problems no playbook can solve
(revoked tokens, a corrupted database) are marked «يحتاج تدخلك» and sent as an urgent alert — once per incident.
"""
from __future__ import annotations

import shutil
import sqlite3
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

from .. import config, connectors, db, events, settings
from ..ai import client as ai
from ..connectors.base import ConnectorError
from ..db import utcnow
from ..engine import approvals, clock, incidents, notify, policy
from ..engine import reports as render
from ..engine.scheduler import scheduler
from ..models import Approval, Connection, Incident, Post, Report, Setting, Task
from . import text
from .registry import BY_ID, CHANNEL_LABELS
from .runtime import Ctx, enqueue, runtime, skill

STUCK_TASK_MIN = 15
STUCK_PUBLISH_MIN = 20
MISSED_MIN = 15
BACKLOG = 40
MIN_FREE_BYTES = 1024**3
BACKUP_EVERY_H = 24
BACKUPS_KEPT = 14
TOKEN_WARN_DAYS = 2
MAX_FIX_ATTEMPTS = 2
RECURRING = 3  # the same fingerprint this many times in 24h → stop auto-fixing, ask the owner
SCHEDULER_STALE_S = 180
TRANSIENT_HINTS = ("مهلة", "مشغولة", "تعذر الاتصال", "حد طلبات", "غير مكتمل", "transient", "Anthropic 5")


@dataclass(frozen=True)
class Finding:
    check: str
    fingerprint: str
    severity: str
    title: str
    detail: str
    fix: str = ""  # playbook name; "" = needs the owner
    data: dict[str, Any] = field(default_factory=dict)


Check = Callable[[Any], list[Finding]]
Playbook = Callable[[dict[str, Any]], Awaitable[str]]
CHECKS: list[Check] = []
PLAYBOOKS: dict[str, Playbook] = {}
FIX_LABELS = {"restart_runtime": "إعادة تشغيل محرك المهام", "restart_scheduler": "إعادة تشغيل المجدول",
              "requeue_task": "إعادة جدولة مهمة عالقة", "retry_task": "إعادة محاولة مهمة متعثرة",
              "retry_post": "إعادة محاولة نشر", "kick_publish": "تشغيل النشر المتأخر",
              "reset_publishing": "استعادة منشور عالق", "reconnect": "إعادة الاتصال بالقناة",
              "refresh_token": "تجديد رمز الوصول", "cleanup_disk": "تنظيف المساحة", "backup_db": "نسخة احتياطية",
              "boost_concurrency": "رفع سرعة المعالجة", "expire_approval": "إغلاق طلب اعتماد قديم",
              "generate_report": "إصدار تقرير اليوم", "resend_report": "إعادة إرسال التقرير"}


def check(fn: Check) -> Check:
    CHECKS.append(fn)
    return fn


def playbook(name: str) -> Callable[[Playbook], Playbook]:
    def wrap(fn: Playbook) -> Playbook:
        PLAYBOOKS[name] = fn
        return fn
    return wrap


# ---------------------------------------------------------------- checks

@check
def engines(s: Any) -> list[Finding]:
    out = []
    if not runtime.alive or (runtime.heartbeat and utcnow() - runtime.heartbeat > timedelta(seconds=60)):
        out.append(Finding("runtime", "runtime:stalled", "critical", "محرك المهام متوقف أو بطيء",
                           "آخر نبضة أقدم من دقيقة", "restart_runtime"))
    if config.get().scheduler_enabled and (not scheduler.alive or (
            scheduler.heartbeat and (utcnow() - scheduler.heartbeat).total_seconds() > SCHEDULER_STALE_S)):
        out.append(Finding("scheduler", "scheduler:stalled", "critical", "المجدول متوقف",
                           "لم يعمل المجدول منذ أكثر من 3 دقائق", "restart_scheduler"))
    return out


@check
def stuck_tasks(s: Any) -> list[Finding]:
    cutoff = utcnow() - timedelta(minutes=STUCK_TASK_MIN)
    rows = s.scalars(select(Task).where(Task.status == "running", Task.started_at < cutoff,
                                        Task.kind != "guardian.sweep")).all()
    return [Finding("stuck_task", f"task:stuck:{t.id}", "warning", f"مهمة عالقة: {t.title}",
                    f"{BY_ID[t.agent_id].name} — قيد التنفيذ منذ أكثر من {STUCK_TASK_MIN} دقيقة", "requeue_task",
                    {"task_id": t.id}) for t in rows]


@check
def failed_tasks(s: Any) -> list[Finding]:
    since = utcnow() - timedelta(hours=24)
    rows = s.scalars(select(Task).where(Task.status == "failed", Task.finished_at >= since)
                     .order_by(Task.finished_at.desc()).limit(20)).all()
    out = []
    for t in rows:
        transient = any(h in (t.error or "") for h in TRANSIENT_HINTS)
        if "مفتاح Anthropic غير صالح" in (t.error or ""):
            out.append(Finding("ai_key", "ai:key", "critical", "مفتاح Claude غير صالح",
                               "الوكلاء متوقفون عن التفكير — حدّث المفتاح من الإعدادات › الربط"))
            continue
        out.append(Finding("failed_task", f"task:failed:{t.id}", "warning" if transient else "info",
                           f"تعثّر {BY_ID[t.agent_id].name}: {t.title}", text.clip(t.error, 400),
                           "retry_task" if transient else "", {"task_id": t.id, "error": t.error}))
    return out


@check
def posts(s: Any) -> list[Finding]:
    now = utcnow()
    out = []
    for p in s.scalars(select(Post).where(Post.status == "failed", Post.updated_at >= now - timedelta(hours=48))).all():
        conn = s.get(Connection, p.channel)
        auth = conn is not None and conn.status == "error"
        out.append(Finding("failed_post", f"post:failed:{p.id}", "warning",
                           f"تعذر نشر منشور {CHANNEL_LABELS[p.channel]}", text.clip(p.error, 300),
                           "" if auth else "retry_post", {"post_id": p.id}))
    for p in s.scalars(select(Post).where(Post.status == "publishing",
                                          Post.updated_at < now - timedelta(minutes=STUCK_PUBLISH_MIN))).all():
        out.append(Finding("stuck_publish", f"post:stuck:{p.id}", "warning", "منشور عالق أثناء النشر",
                           CHANNEL_LABELS[p.channel], "reset_publishing", {"post_id": p.id}))
    late = s.scalars(select(Post.channel).where(Post.status == "scheduled",
                                                Post.scheduled_at < now - timedelta(minutes=MISSED_MIN))).all()
    for ch in set(late):
        out.append(Finding("missed_schedule", f"publish:late:{ch}", "warning",
                           f"منشورات {CHANNEL_LABELS[ch]} متأخرة عن موعدها", f"{late.count(ch)} منشور", "kick_publish",
                           {"channel": ch}))
    return out


@check
def connections(s: Any) -> list[Finding]:
    out = []
    for c in s.scalars(select(Connection).where(Connection.mode == "live")).all():
        if c.status == "error":
            out.append(Finding("connection", f"conn:error:{c.id}", "critical", f"انقطع الربط مع {c.id}",
                               text.clip(c.last_error, 300), "reconnect", {"provider": c.id}))
        if c.token_expires_at and c.token_expires_at < utcnow() + timedelta(days=TOKEN_WARN_DAYS):
            out.append(Finding("token", f"conn:token:{c.id}", "warning", f"رمز {c.id} ينتهي قريبًا",
                               clock.human(c.token_expires_at), "refresh_token", {"provider": c.id}))
    return out


@check
def resources(s: Any) -> list[Finding]:
    out = []
    data_dir = config.get().data_dir
    if shutil.disk_usage(data_dir).free < MIN_FREE_BYTES:
        out.append(Finding("disk", "disk:low", "critical", "المساحة المتبقية أقل من 1 جيجابايت", str(data_dir),
                           "cleanup_disk"))
    if config.get().database_url.startswith("sqlite"):
        newest = max((p.stat().st_mtime for p in _backups()), default=0)
        if utcnow().timestamp() - newest > BACKUP_EVERY_H * 3600:
            out.append(Finding("backup", f"backup:{clock.today().isoformat()}", "info", "لا توجد نسخة احتياطية حديثة",
                               "آخر نسخة أقدم من 24 ساعة", "backup_db"))
    backlog = int(s.scalar(select(func.count()).select_from(Task).where(
        Task.status == "queued", Task.run_after <= utcnow())) or 0)
    if backlog > BACKLOG:
        out.append(Finding("backlog", "queue:backlog", "warning", f"{backlog} مهمة بانتظار التنفيذ",
                           "الطابور أطول من المعتاد", "boost_concurrency"))
    cap = settings.get(s, "limits").ai_daily_cost_cap_usd
    spent = ai.spent_today_usd()
    if cap and spent >= cap * 0.8:
        full = spent >= cap
        out.append(Finding("ai_budget", f"ai:budget:{clock.today().isoformat()}", "warning" if not full else "critical",
                           "اكتمل سقف إنفاق الذكاء الاصطناعي اليوم" if full else "اقترب إنفاق الذكاء الاصطناعي من سقفه",
                           f"{spent:.2f}$ من {cap:g}$ — المهام تُستأنف تلقائيًا غدًا أو ارفع السقف من الإعدادات"))
    return out


@check
def housekeeping(s: Any) -> list[Finding]:
    out = []
    for a in s.scalars(select(Approval).where(Approval.status == "pending", Approval.kind == "post")).all():
        post = s.get(Post, a.ref_id)
        if post is None or post.status != "review":
            out.append(Finding("approval", f"approval:stale:{a.id}", "info", "طلب اعتماد لم يعد لازمًا", a.title,
                               "expire_approval", {"approval_id": a.id}))
    now = clock.now_local()
    report_at = clock.parse_hhmm(settings.get(s, "notify").report_time)
    late = now.replace(hour=report_at.hour, minute=report_at.minute) + timedelta(minutes=30)
    today = clock.today().isoformat()
    report = s.scalars(select(Report).where(Report.day == today, Report.kind == "daily")
                       .order_by(Report.created_at.desc()).limit(1)).first()
    agent_on = policy.decide(s, "coordinator", "send_reports") != "off"
    if now > late and report is None and agent_on:
        out.append(Finding("report", f"report:missing:{today}", "warning", "لم يصدر تقرير اليوم في موعده", today,
                           "generate_report"))
    if report is not None and any(d.get("status") == "failed" for d in report.deliveries or []):
        out.append(Finding("report_delivery", f"report:delivery:{report.id}", "warning", "تعذر إرسال تقرير اليوم",
                           "; ".join(str(d.get("error", "")) for d in report.deliveries if d.get("status") == "failed"),
                           "resend_report", {"report_id": report.id}))
    return out


# ---------------------------------------------------------------- playbooks

@playbook("restart_runtime")
async def _restart_runtime(data: dict[str, Any]) -> str:
    await runtime.restart()
    return "أُعيد تشغيل محرك المهام"


@playbook("restart_scheduler")
async def _restart_scheduler(data: dict[str, Any]) -> str:
    await scheduler.restart()
    return "أُعيد تشغيل المجدول"


@playbook("requeue_task")
async def _requeue(data: dict[str, Any]) -> str:
    with db.session() as s:
        t = s.get(Task, data["task_id"])
        if t is None or t.status != "running":
            return "انتهت المهمة قبل الإصلاح"
        t.attempts = (t.attempts or 0) + 1
        if t.attempts >= (t.max_attempts or 3):
            t.status, t.finished_at, t.error = "failed", utcnow(), "توقفت بعد محاولات متكررة"
            return "أُغلقت المهمة بعد تكرار تعثرها"
        t.status, t.run_after = "queued", utcnow()
        return "أُعيدت المهمة إلى الطابور"


@playbook("retry_task")
async def _retry(data: dict[str, Any]) -> str:
    with db.session() as s:
        t = s.get(Task, data["task_id"])
        if t is None or t.status != "failed":
            return "لم تعد المهمة متعثرة"
        t.status, t.summary = "cancelled", "أعاد الحارس المحاولة في مهمة جديدة"
        enqueue(s, kind=t.kind, title=t.title, input=t.input, created_by="guardian", origin="guardian", priority=4)
        return "أُعيدت محاولة المهمة"


@playbook("retry_post")
async def _retry_post(data: dict[str, Any]) -> str:
    with db.session() as s:
        p = s.get(Post, data["post_id"])
        if p is None or p.status != "failed":
            return "لم يعد المنشور متعثرًا"
        p.status, p.scheduled_at, p.attempts, p.error = "scheduled", utcnow() + timedelta(minutes=5), 0, ""
        return "أُعيدت جدولة المنشور بعد 5 دقائق"


@playbook("kick_publish")
async def _kick(data: dict[str, Any]) -> str:
    with db.session() as s:
        enqueue(s, kind="channel.publish", title="نشر المتأخر", channel=data["channel"], created_by="guardian",
                origin="guardian", priority=1)
    return "شُغّل النشر فورًا"


@playbook("reset_publishing")
async def _reset_publishing(data: dict[str, Any]) -> str:
    with db.session() as s:
        p = s.get(Post, data["post_id"])
        if p is None or p.status != "publishing":
            return "لم يعد المنشور عالقًا"
        p.status, p.scheduled_at = "scheduled", utcnow()
        return "أُعيد المنشور إلى قائمة النشر"


@playbook("reconnect")
async def _reconnect(data: dict[str, Any]) -> str:
    provider = data["provider"]
    try:
        info = await connectors.build(provider, force_live=True).test()
    except ConnectorError as exc:
        raise _NeedsOwner(f"ما زال الربط مرفوضًا: {exc}") from exc
    with db.session() as s:
        c = s.get(Connection, provider)
        c.status, c.last_error, c.last_checked_at = "connected", "", utcnow()
        c.account = {**(c.account or {}), "name": info.name, "handle": info.handle, "followers": info.followers}
    return "عاد الربط يعمل"


@playbook("refresh_token")
async def _refresh(data: dict[str, Any]) -> str:
    provider = data["provider"]
    try:
        tokens = await connectors.build(provider, force_live=True).refresh()
    except ConnectorError as exc:
        raise _NeedsOwner(f"تعذر التجديد: {exc}") from exc
    if tokens is None:
        raise _NeedsOwner("هذه القناة لا تدعم التجديد التلقائي — أضف رمزًا جديدًا")
    with db.session() as s:
        connectors.store_refresh(s, provider, tokens)
    return "جُدّد رمز الوصول"


def _backups() -> list[Path]:
    d = config.get().backup_dir
    d.mkdir(parents=True, exist_ok=True)
    return sorted(d.glob("qsm-*.db"))


@playbook("backup_db")
async def _backup(data: dict[str, Any]) -> str:
    url = config.get().database_url
    src_path = url.removeprefix("sqlite:///")
    target = config.get().backup_dir / f"qsm-{clock.now_local():%Y%m%d-%H%M}.db"
    target.parent.mkdir(parents=True, exist_ok=True)
    src, dst = sqlite3.connect(src_path), sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    for old in _backups()[:-BACKUPS_KEPT]:
        old.unlink(missing_ok=True)
    return f"نسخة احتياطية: {target.name}"


@playbook("cleanup_disk")
async def _cleanup(data: dict[str, Any]) -> str:
    removed = 0
    for old in _backups()[:-3]:
        old.unlink(missing_ok=True)
        removed += 1
    if shutil.disk_usage(config.get().data_dir).free < MIN_FREE_BYTES:
        raise _NeedsOwner("نظّفت النسخ القديمة وما زالت المساحة منخفضة — وسّع التخزين")
    return f"حُذفت {removed} نسخ احتياطية قديمة"


@playbook("boost_concurrency")
async def _boost(data: dict[str, Any]) -> str:
    runtime.concurrency = min(runtime.concurrency + 2, 8)
    return f"رُفعت المعالجة المتوازية إلى {runtime.concurrency}"


@playbook("expire_approval")
async def _expire(data: dict[str, Any]) -> str:
    with db.session() as s:
        a = s.get(Approval, data["approval_id"])
        if a is not None and a.status == "pending":
            a.status, a.decided_by, a.decided_at = "expired", "guardian", utcnow()
            events.publish("approvals", {"pending": approvals.pending_count(s)})
    return "أُغلق الطلب"


@playbook("generate_report")
async def _gen_report(data: dict[str, Any]) -> str:
    with db.session() as s:
        enqueue(s, kind="coordinator.daily_report", title="تقرير الإنجاز اليومي (متأخر)", created_by="guardian",
                origin="guardian", priority=2)
    return "طُلب إصدار التقرير الآن"


@playbook("resend_report")
async def _resend(data: dict[str, Any]) -> str:
    with db.session() as s:
        r = s.get(Report, data["report_id"])
        base = (settings.get(s, "general").public_base_url or "").rstrip("/")
        wa, html, subject = render.whatsapp_text(r, base), render.email_html(r, base), r.title
    deliveries = await notify.deliver("report", subject=subject, text=wa, html=html)
    with db.session() as s:
        r = s.get(Report, data["report_id"])
        r.deliveries = deliveries
    if all(d.get("status") == "failed" for d in deliveries):
        raise _NeedsOwner("فشل الإرسال مجددًا — راجع إعدادات واتساب والبريد")
    return "أُعيد إرسال التقرير"


class _NeedsOwner(Exception):
    pass


# ---------------------------------------------------------------- the sweep

DIAG_SCHEMA: dict[str, Any] = {"type": "object", "properties": {
    "diagnosis": {"type": "string", "description": "السبب المرجح في جملتين"},
    "advice": {"type": "string", "description": "الإجراء المقترح للمالك إن لزم"}}}


async def run_fix(incident_id: str, fix: str, data: dict[str, Any]) -> tuple[str, str]:
    """Execute a playbook for an incident → (status, detail)."""
    fn = PLAYBOOKS.get(fix)
    if fn is None:
        return "needs_owner", "لا توجد خطة إصلاح آلية"
    with db.session() as s:
        inc = s.get(Incident, incident_id)
        inc.status, inc.attempts = "fixing", (inc.attempts or 0) + 1
    try:
        detail = await fn(data)
        status = "fixed"
    except _NeedsOwner as exc:
        detail, status = str(exc), "needs_owner"
    except Exception as exc:
        detail, status = f"فشل الإصلاح: {exc.__class__.__name__}", "failed"
    with db.session() as s:
        inc = s.get(Incident, incident_id)
        incidents.close(s, inc, status, detail)
        if status == "fixed":
            events.record(s, "guardian.fixed", f"الحارس أصلح: {inc.title} — {detail}", actor="guardian",
                          ref_kind="incident", ref_id=inc.id)
    return status, detail


@skill("guardian.sweep")
async def sweep(ctx: Ctx) -> dict[str, Any]:
    findings: list[Finding] = []
    with db.session() as s:
        for fn in CHECKS:
            try:
                findings.extend(fn(s))
            except Exception as exc:
                findings.append(Finding("check", f"check:{fn.__name__}", "warning", f"تعذر تنفيذ فحص {fn.__name__}",
                                        exc.__class__.__name__))
        decision = policy.decide(s, "guardian", "auto_fix")
        seen = {f.fingerprint for f in findings}
        # Auto-resolve open incidents whose cause is gone.
        for inc in s.scalars(select(Incident).where(Incident.status.in_(("open", "needs_owner", "failed")))).all():
            if inc.fingerprint not in seen and inc.check not in ("runtime",):
                incidents.close(s, inc, "fixed", "زال السبب")
        work: list[tuple[str, Finding, bool]] = []
        for f in findings:
            inc, created = incidents.open_incident(s, check=f.check, fingerprint=f.fingerprint, severity=f.severity,
                                                   title=f.title, detail=f.detail, fix_action=f.fix)
            work.append((inc.id, f, created))
    fixed: list[str] = []
    owner: list[str] = []
    internal: list[str] = []
    for inc_id, f, created in work:
        with db.session() as s:
            inc = s.get(Incident, inc_id)
            attempts, status, notified = inc.attempts or 0, inc.status, inc.notified
            recurring = int(s.scalar(select(func.count()).select_from(Incident).where(
                Incident.fingerprint == f.fingerprint, Incident.created_at >= utcnow() - timedelta(hours=24))) or 0)
            if recurring >= RECURRING and f.fix and status == "open":
                inc.status, inc.fix_detail = "needs_owner", "مشكلة متكررة — توقف الإصلاح الآلي"
                status = "needs_owner"
                if not notified:
                    owner.append(f"{f.title} — تتكرر ({recurring} مرات خلال 24 ساعة)")
                    inc.notified = True
        if f.fix and status in ("open", "failed") and attempts < MAX_FIX_ATTEMPTS:
            if decision == "auto":
                st, detail = await run_fix(inc_id, f.fix, f.data)
                (fixed if st == "fixed" else owner).append(f"{f.title} — {detail}")
            elif decision == "approve" and created:
                with db.session() as s:
                    approvals.request(s, "fix", ref_id=inc_id, agent_id="guardian",
                                      title=f"إصلاح مقترح: {FIX_LABELS.get(f.fix, f.fix)}", summary=f.title,
                                      payload={"fix": f.fix, "data": f.data})
        elif not f.fix and not notified and f.severity in ("warning", "critical"):
            owner.append(f"{f.title} — {f.detail}")
            if f.check == "failed_task" and "خطأ داخلي" in f.detail:
                internal.append(f.detail)
            with db.session() as s:
                inc = s.get(Incident, inc_id)
                if inc.status == "open":
                    inc.status = "needs_owner" if f.severity == "critical" else "open"
                inc.notified = True
    if internal:
        ctx.progress("يشخّص سبب الأعطال")
        result = await ctx.ai(prompt=f"أعطال داخلية حديثة:\n{internal[:5]}\nشخّص السبب المرجح باختصار.",
                              schema=DIAG_SCHEMA, max_tokens=500,
                              simulate=lambda: {"diagnosis": "تعثر داخلي متكرر في نفس المهارة",
                                                "advice": "سيعيد الحارس المحاولة؛ إن تكرر راجع سجل المهمة"})
        owner.append("تشخيص الحارس: " + str((result.data or {}).get("diagnosis", "")))
    if fixed:
        await notify.owner_alert("fix", f"الحارس أصلح {len(fixed)} مشكلة تلقائيًا", "\n".join(f"• {x}" for x in fixed),
                                 level="success", link="/guardian")
    if owner:
        await notify.owner_alert("incident", "تنبيه من الحارس", "\n".join(f"• {x}" for x in owner[:6]),
                                 level="warning", link="/guardian", urgent=any("مفتاح" in x for x in owner))
    healthy = not findings
    with db.session() as s:
        row = s.get(Setting, "guardian_last")
        snapshot = {"at": db.iso(utcnow()), "findings": len(findings), "fixed": len(fixed), "healthy": healthy}
        if row is None:
            s.add(Setting(key="guardian_last", value=snapshot))
        else:
            row.value = snapshot
    if healthy:
        return {"summary": "النظام سليم", "quiet": True}
    return {"summary": f"{len(findings)} ملاحظة — أصلح {len(fixed)}" + (f"، {len(owner)} تحتاجك" if owner else ""),
            "fixed": fixed}


@approvals.resolver("fix")
def _resolve_fix(s: Any, a: Approval, approved: bool) -> None:
    inc = s.get(Incident, a.ref_id)
    if inc is None:
        return
    if approved:
        enqueue(s, kind="guardian.apply_fix", title=f"تنفيذ إصلاح: {inc.title}",
                input={"incident_id": inc.id, "fix": a.payload.get("fix"), "data": a.payload.get("data", {})},
                created_by=a.decided_by or "owner", origin="user", priority=1)
    else:
        incidents.close(s, inc, "ignored", "رفض المالك الإصلاح")


@skill("guardian.apply_fix")
async def apply_fix(ctx: Ctx) -> dict[str, Any]:
    status, detail = await run_fix(ctx.input["incident_id"], ctx.input.get("fix", ""), ctx.input.get("data", {}))
    return {"summary": f"{'أُصلح' if status == 'fixed' else 'لم يكتمل الإصلاح'}: {detail}"}
