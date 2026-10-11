"""What each connection needs, in the owner's words — Settings › الربط renders straight from this."""
from __future__ import annotations

import ipaddress
import re
from typing import Any

Field = dict[str, Any]


def f(key: str, label: str, *, secret: bool = False, placeholder: str = "", help: str = "",
      default: str = "", required: bool = True) -> Field:
    return {"key": key, "label": label, "secret": secret, "placeholder": placeholder, "help": help,
            "default": default, "required": required}


PROVIDERS: dict[str, dict[str, Any]] = {
    "anthropic": {
        "label": "Claude (Anthropic)", "group": "ai", "color": "#d97757",
        "about": "عقل الشبكة: Opus 5.5 للقائد ومدير الحملات، و Sonnet 5.5 لبقية الوكلاء.",
        "docs": "https://platform.claude.com/settings/keys",
        "fields": [f("api_key", "مفتاح API", secret=True, placeholder="sk-ant-…",
                     help="من لوحة Anthropic › API Keys. بدون المفتاح يعمل الوكلاء في وضع المحاكاة.")],
    },
    "instagram": {
        "label": "إنستقرام", "group": "channel", "color": "#e1306c",
        "about": "نشر الصور والريلز والكاروسيل، قراءة التعليقات والرد عليها، ومؤشرات الأداء — عبر Instagram Graph API.",
        "docs": "https://developers.facebook.com/docs/instagram-platform",
        "fields": [
            f("ig_user_id", "معرّف حساب إنستقرام للأعمال", placeholder="17841400000000000"),
            f("page_id", "معرّف صفحة فيسبوك المرتبطة", required=False, help="للرسائل الخاصة"),
            f("access_token", "رمز الوصول طويل الأمد", secret=True,
              help="صلاحيات: instagram_basic, instagram_content_publish, instagram_manage_comments, "
                   "instagram_manage_insights, pages_show_list"),
            f("app_secret", "App Secret", secret=True, required=False, help="للتحقق من توقيع الويب هوك"),
            f("graph_version", "إصدار Graph API", default="v24.0", required=False),
        ],
        "webhook": True,
    },
    "tiktok": {
        "label": "تيك توك", "group": "channel", "color": "#25f4ee",
        "about": "رفع الفيديوهات ونشرها مباشرة ومتابعة المشاهدات والتفاعل — عبر TikTok Content Posting API.",
        "docs": "https://developers.tiktok.com/doc/content-posting-api-get-started",
        "fields": [
            f("client_key", "Client Key"),
            f("client_secret", "Client Secret", secret=True),
            f("access_token", "رمز وصول المستخدم", secret=True,
              help="صلاحيات: user.info.basic, video.publish, video.list"),
            f("refresh_token", "رمز التجديد", secret=True, required=False, help="يجدد الحارس الرمز تلقائيًا"),
        ],
    },
    "x": {
        "label": "إكس (تويتر)", "group": "channel", "color": "#a1a1aa",
        "about": "نشر التغريدات والسلاسل مع الصور، متابعة الإشارات والرد عليها — عبر X API v2.",
        "docs": "https://docs.x.com/x-api",
        "fields": [
            f("client_id", "OAuth 2.0 Client ID"),
            f("client_secret", "Client Secret", secret=True, required=False),
            f("access_token", "رمز وصول المستخدم", secret=True,
              help="صلاحيات: tweet.read tweet.write users.read media.write offline.access"),
            f("refresh_token", "رمز التجديد", secret=True, required=False),
        ],
    },
    "whatsapp": {
        "label": "واتساب للأعمال", "group": "channel", "color": "#25d366",
        "about": "استقبال رسائل العملاء والرد عليها، والرسائل الجماعية للمشتركين الموافقين فقط، وتقارير المالك — "
                 "عبر WhatsApp Cloud API.",
        "docs": "https://developers.facebook.com/docs/whatsapp/cloud-api",
        "fields": [
            f("phone_number_id", "معرّف رقم الهاتف", placeholder="1234567890"),
            f("waba_id", "معرّف حساب واتساب للأعمال", required=False),
            f("access_token", "رمز مستخدم النظام الدائم", secret=True,
              help="صلاحيات: whatsapp_business_messaging, whatsapp_business_management"),
            f("app_secret", "App Secret", secret=True, required=False, help="للتحقق من توقيع الويب هوك"),
            f("broadcast_template", "قالب الرسائل الجماعية المعتمد", required=False,
              help="اسم قالب تسويقي معتمد من Meta — بدونه تُرسل الرسالة الجماعية لمن راسلنا خلال 24 ساعة فقط"),
            f("graph_version", "إصدار Graph API", default="v24.0", required=False),
        ],
        "webhook": True,
    },
    "linkedin": {
        "label": "لينكدإن", "group": "channel", "color": "#0a66c2",
        "about": "نشر المنشورات والصور على صفحة الشركة، ومتابعة التعليقات والرد عليها — عبر LinkedIn Posts API.",
        "docs": "https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api",
        "fields": [
            f("author_urn", "معرّف الناشر", placeholder="urn:li:organization:12345678",
              help="صفحة الشركة (organization) أو حساب شخصي (person)"),
            f("access_token", "رمز الوصول", secret=True,
              help="صلاحيات: w_organization_social, r_organization_social (أو w_member_social)"),
            f("api_version", "إصدار الواجهة (YYYYMM)", default="202509", required=False),
        ],
    },
    "email": {
        "label": "البريد الإلكتروني (SMTP)", "group": "delivery", "color": "#6b6bf8",
        "about": "إرسال التقرير اليومي وإشعارات الإصلاح إلى بريدك.",
        "docs": "",
        "fields": [
            f("smtp_host", "خادم SMTP", placeholder="smtp.office365.com"),
            f("smtp_port", "المنفذ", default="587"),
            f("security", "التشفير", default="starttls", help="starttls أو ssl"),
            f("username", "اسم المستخدم"),
            f("password", "كلمة المرور / كلمة مرور التطبيق", secret=True),
            f("from_address", "عنوان المرسل", placeholder="marketing@company.sa"),
            f("from_name", "اسم المرسل", default="Qhub Smart Marketing", required=False),
        ],
    },
}

# Values that end up inside request URLs or headers are shape-checked (no path or header tricks).
PATTERNS: dict[str, re.Pattern[str]] = {
    "graph_version": re.compile(r"^v\d{1,2}\.\d$"), "api_version": re.compile(r"^\d{6}$"),
    "ig_user_id": re.compile(r"^\d{5,25}$"), "page_id": re.compile(r"^\d{5,25}$"),
    "phone_number_id": re.compile(r"^\d{5,25}$"), "waba_id": re.compile(r"^\d{5,25}$"),
    "author_urn": re.compile(r"^urn:li:(organization|person):[A-Za-z0-9_-]{1,40}$"),
    "smtp_port": re.compile(r"^\d{2,5}$"), "security": re.compile(r"^(starttls|ssl)$"),
    "smtp_host": re.compile(r"^[A-Za-z0-9.-]{3,253}$"), "broadcast_template": re.compile(r"^[a-z0-9_]{1,512}$"),
}


def private_host(host: str) -> bool:
    """Loopback, private, link-local or bare local names — never a legitimate SMTP relay for this app."""
    h = host.strip().lower().rstrip(".")
    if h in ("localhost",) or h.endswith((".local", ".localhost", ".internal")) or "." not in h:
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_unspecified


def valid_value(key: str, value: str) -> bool:
    pattern = PATTERNS.get(key)
    return bool(pattern.fullmatch(value)) if pattern else "\n" not in value and "\r" not in value


ORDER = ("anthropic", "instagram", "tiktok", "x", "whatsapp", "linkedin", "email")


def secret_fields(provider: str) -> set[str]:
    return {fl["key"] for fl in PROVIDERS[provider]["fields"] if fl["secret"]}


def plain_fields(provider: str) -> set[str]:
    return {fl["key"] for fl in PROVIDERS[provider]["fields"] if not fl["secret"]}


def required_fields(provider: str) -> set[str]:
    return {fl["key"] for fl in PROVIDERS[provider]["fields"] if fl["required"]}


def defaults(provider: str) -> dict[str, str]:
    return {fl["key"]: fl["default"] for fl in PROVIDERS[provider]["fields"] if fl["default"]}
