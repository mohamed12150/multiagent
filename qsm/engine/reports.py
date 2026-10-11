"""Renders a report for WhatsApp (plain text, the owner reads it on the phone) and email (RTL HTML, inline CSS)."""
from __future__ import annotations

from html import escape
from typing import Any

from ..models import Report

LABELS = {"tiktok": "تيك توك", "instagram": "إنستقرام", "x": "إكس", "whatsapp": "واتساب", "linkedin": "لينكدإن"}


def _n(v: Any) -> str:
    try:
        return f"{int(v):,}"
    except (TypeError, ValueError):
        return str(v)


def whatsapp_text(report: Report, base_url: str = "") -> str:
    d = report.data or {}
    t = d.get("totals", {})
    conv = d.get("conversations", {})
    sec = report.sections or {}
    lines = [f"📊 *{report.title}*", "", report.headline, "",
             f"• المنشورات: {_n(t.get('posts', 0))}", f"• الوصول: {_n(t.get('reach', 0))}",
             f"• التفاعل: {_n(t.get('engagement', 0))} ({t.get('engagement_rate', 0)}٪)",
             f"• الردود على العملاء: {_n(conv.get('replies', 0))} · فرص بيع: {_n(conv.get('leads', 0))}"]
    if sec.get("highlights"):
        lines += ["", "✅ *الإنجازات*"] + [f"- {h}" for h in sec["highlights"][:4]]
    if sec.get("issues"):
        lines += ["", "⚠️ *تحتاج انتباهك*"] + [f"- {h}" for h in sec["issues"][:3]]
    if sec.get("tomorrow"):
        lines += ["", "🗓️ *غدًا*"] + [f"- {h}" for h in sec["tomorrow"][:3]]
    if base_url:
        lines += ["", f"التقرير كاملًا: {base_url}/reports/{report.id}"]
    return "\n".join(lines)[:4000]


def _list(title: str, items: list[str], color: str) -> str:
    if not items:
        return ""
    lis = "".join(f'<li style="margin:4px 0">{escape(str(i))}</li>' for i in items)
    return (f'<h3 style="margin:22px 0 8px;font-size:15px;color:{color}">{escape(title)}</h3>'
            f'<ul style="margin:0;padding-inline-start:20px;color:#334155;font-size:14px;line-height:1.7">{lis}</ul>')


def email_html(report: Report, base_url: str = "") -> str:
    d = report.data or {}
    t = d.get("totals", {})
    conv = d.get("conversations", {})
    sec = report.sections or {}
    cards = [("المنشورات", t.get("posts", 0)), ("الوصول", t.get("reach", 0)), ("التفاعل", t.get("engagement", 0)),
             ("الردود", conv.get("replies", 0)), ("فرص البيع", conv.get("leads", 0))]
    kpi = "".join(
        f'<td style="padding:12px;background:#f5f6fb;border-radius:10px;text-align:center">'
        f'<div style="font-size:20px;font-weight:700;color:#202e3a">{_n(v)}</div>'
        f'<div style="font-size:12px;color:#64748b">{escape(k)}</div></td><td style="width:8px"></td>' for k, v in cards)
    rows = "".join(
        f'<tr><td style="padding:8px;border-bottom:1px solid #eef0f6">{escape(LABELS.get(ch, ch))}</td>'
        f'<td style="padding:8px;border-bottom:1px solid #eef0f6">{_n(v.get("posts", 0))}</td>'
        f'<td style="padding:8px;border-bottom:1px solid #eef0f6">{_n(v.get("reach", 0))}</td>'
        f'<td style="padding:8px;border-bottom:1px solid #eef0f6">{_n(v.get("engagement", 0))}</td>'
        f'<td style="padding:8px;border-bottom:1px solid #eef0f6">{v.get("engagement_rate", 0)}٪</td></tr>'
        for ch, v in (d.get("channels") or {}).items())
    link = (f'<p style="margin-top:24px"><a href="{escape(base_url)}/reports/{escape(report.id)}" '
            f'style="background:#6b6bf8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">'
            f'افتح التقرير في المنصة</a></p>') if base_url else ""
    return f"""<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#eef0f6;font-family:Tahoma,Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;padding:24px">
<div style="background:#0f1729;color:#fff;border-radius:14px 14px 0 0;padding:22px 24px">
<div style="font-size:12px;opacity:.7">Qhub Smart Marketing · المنسّق</div>
<h1 style="margin:6px 0 0;font-size:20px">{escape(report.title)}</h1></div>
<div style="background:#fff;border-radius:0 0 14px 14px;padding:24px">
<p style="font-size:16px;font-weight:700;color:#202e3a;margin:0 0 8px">{escape(report.headline)}</p>
<p style="font-size:14px;color:#475569;line-height:1.8;margin:0 0 18px">{escape(report.summary)}</p>
<table role="presentation" style="width:100%;border-collapse:separate"><tr>{kpi}</tr></table>
<h3 style="margin:22px 0 8px;font-size:15px;color:#202e3a">أداء القنوات</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;color:#334155">
<tr style="color:#64748b"><th style="text-align:right;padding:8px">القناة</th><th style="text-align:right;padding:8px">منشورات</th>
<th style="text-align:right;padding:8px">وصول</th><th style="text-align:right;padding:8px">تفاعل</th><th style="text-align:right;padding:8px">المعدل</th></tr>{rows}</table>
{_list("الإنجازات", sec.get("highlights", []), "#17a673")}
{_list("تحتاج انتباهك", sec.get("issues", []), "#d98a1c")}
{_list("التوصيات", sec.get("recommendations", []), "#6b6bf8")}
{_list("خطة الغد", sec.get("tomorrow", []), "#202e3a")}
{link}</div></div></body></html>"""
