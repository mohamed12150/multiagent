"""Team capabilities: what each signed-in person may do.

A role is a starting preset (owner, manager, editor, viewer); the owner — or anyone holding `users` — can then tick
exactly which capabilities a member has. Every write route asks for one capability; reading the platform only needs
an active account. The owner always holds everything and cannot be restricted."""
from __future__ import annotations

from typing import Any

CAPABILITIES: dict[str, dict[str, str]] = {
    "command": {"label": "أوامر القائد وتشغيل الوكلاء",
                "hint": "إعطاء أوامر للقائد، تشغيل مهارة لأي وكيل، إلغاء المهام وإعادتها", "group": "التشغيل"},
    "content": {"label": "كتابة المحتوى وجدولته",
                "hint": "طلب محتوى من صانع المحتوى، التعديل، الإرسال للاعتماد والجدولة", "group": "المحتوى"},
    "library": {"label": "رفع التصاميم وإدارة المكتبة", "hint": "رفع الصور والمقاطع وتعديل وصفها ومجلداتها",
                "group": "المحتوى"},
    "approve": {"label": "الاعتماد", "hint": "اعتماد المحتوى والتصاميم والردود والحملات، النشر الفوري والحذف",
                "group": "الاعتماد"},
    "proposals": {"label": "مقترحات الحملات والمنافسون", "hint": "طلب مقترح حملة، إضافة المنافسين وتعديلهم وطلب تحليلهم",
                  "group": "الحملات"},
    "campaigns": {"label": "إدارة الحملات", "hint": "إنشاء الحملات وتعديل ميزانياتها وحالتها، حذف المنافسين",
                  "group": "الحملات"},
    "inbox": {"label": "التفاعل مع العملاء", "hint": "الرد على العملاء، طلب رد من صانع المحتوى، إدارة جهات الاتصال",
              "group": "العملاء"},
    "reports": {"label": "التقارير", "hint": "إصدار تقرير اليوم وإعادة إرساله", "group": "التشغيل"},
    "agents": {"label": "إعدادات الوكلاء والحارس",
               "hint": "النموذج وعمق التفكير والجدول، الإيقاف المؤقت، إصلاحات الحارس", "group": "الإدارة"},
    "settings": {"label": "ملف العلامة والذكاء الاصطناعي", "hint": "تعديل ملف العلامة وإعدادات البحث في الويب",
                 "group": "الإدارة"},
    "connections": {"label": "الربط والمفاتيح", "hint": "ربط Claude والقنوات والبريد واختبارها", "group": "الإدارة"},
    "autonomy": {"label": "الاستقلالية والصلاحيات والليمت",
                 "hint": "مستوى الاستقلالية، مصفوفة الصلاحيات، الليمت وأهداف القائد", "group": "صلاحيات المالك"},
    "notify": {"label": "الإشعارات والإعدادات العامة", "hint": "أين تصل التقارير، المنطقة الزمنية، الرابط العام",
               "group": "صلاحيات المالك"},
    "users": {"label": "إدارة المستخدمين", "hint": "إضافة الأعضاء ومنحهم الصلاحيات وتعطيلهم",
              "group": "صلاحيات المالك"},
}
ALL = frozenset(CAPABILITIES)
# Capabilities only the owner can hand out: they change who controls the network itself.
OWNER_GRANTED = frozenset({"autonomy", "notify", "users"})

PRESETS: dict[str, frozenset[str]] = {
    "owner": ALL,
    "manager": ALL - {"autonomy", "notify", "users"},
    "editor": frozenset({"command", "content", "library", "proposals", "inbox", "reports"}),
    "viewer": frozenset(),
}
ROLE_LABELS = {"owner": "المالك", "manager": "مدير", "editor": "محرر", "viewer": "مشاهد"}


def effective(user: Any) -> frozenset[str]:
    """The capabilities a user really has (owner → all; custom list if set; otherwise the role preset)."""
    if user is None or not getattr(user, "active", False):
        return frozenset()
    return granted(user)


def granted(user: Any) -> frozenset[str]:
    """What an account carries whether or not it is active — the measure of how powerful it is to manage."""
    if user.role == "owner":
        return ALL
    custom = getattr(user, "permissions", None)
    if isinstance(custom, list):
        return frozenset(c for c in custom if c in ALL)
    return PRESETS.get(user.role, frozenset())


def has(user: Any, cap: str) -> bool:
    return cap in effective(user)


def clean(caps: list[str] | None) -> list[str] | None:
    """Normalise a submitted list (unknown keys dropped, stable order); None keeps the role preset."""
    if caps is None:
        return None
    wanted = set(caps)
    return [c for c in CAPABILITIES if c in wanted]


def catalog() -> dict[str, Any]:
    return {"capabilities": CAPABILITIES, "presets": {k: sorted(v) for k, v in PRESETS.items()},
            "roles": ROLE_LABELS, "owner_granted": sorted(OWNER_GRANTED)}
