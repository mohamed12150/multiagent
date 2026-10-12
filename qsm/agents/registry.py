"""The ten agents of the live network: who they are, which model they think with, what they may do alone.

Model choice: the two seats that decide (القائد، مدير الحملات) run on Claude Opus 5.5; the eight seats that write,
operate and react run on Claude Sonnet 5.5 — faster, half the price, and strong at Arabic copy.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..ai.models import OPUS, SONNET
from ..models import CHANNELS

CHANNEL_LABELS = {"tiktok": "تيك توك", "instagram": "إنستقرام", "x": "إكس", "whatsapp": "واتساب",
                  "linkedin": "لينكدإن"}

PERMISSIONS: dict[str, dict[str, str]] = {
    "delegate": {"label": "توزيع المهام على الوكلاء", "hint": "القائد يوزّع الأوامر على الفريق"},
    "intervene": {"label": "التدخل المستقل في الحملات", "hint": "يوقف الضعيف ويعيد توزيع الميزانية ويرفع سعة الرابح، ضمن الليمت"},
    "web_research": {"label": "البحث في الويب", "hint": "تحليل المنافسين والسوق من مصادر حيّة"},
    "launch_campaign": {"label": "إطلاق الحملات", "hint": "تحويل المقترح إلى حملة نشطة"},
    "spend": {"label": "صرف ميزانية الترويج", "hint": "ضمن الليمت اليومي والشهري دائمًا"},
    "raise_limits": {"label": "رفع الليمت", "hint": "ضمن السقف الذي تحدده في الإعدادات"},
    "create_content": {"label": "إنشاء المحتوى", "hint": "كتابة السكربت والمنشورات من المكتبة"},
    "use_library": {"label": "استخدام المكتبة", "hint": "سحب الصور والمقاطع المعتمدة فقط"},
    "reply": {"label": "الرد على العملاء", "hint": "الشكاوى تُحوَّل لك دائمًا"},
    "publish": {"label": "النشر دون اعتماد", "hint": "تلقائي = لا يحتاج المحتوى اعتمادك قبل النشر"},
    "broadcast": {"label": "الرسائل الجماعية", "hint": "للمشتركين الموافقين فقط"},
    "schedule": {"label": "جدولة النشر", "hint": "اختيار القناة والوقت الأنسب"},
    "send_reports": {"label": "إرسال التقارير", "hint": "واتساب والبريد"},
    "auto_fix": {"label": "الإصلاح التلقائي", "hint": "تنفيذ خطط الإصلاح المعتمدة دون تدخلك"},
}
VALUES = ("auto", "approve", "off")

# Autonomy presets rewrite the whole matrix in one click (Settings › الصلاحيات).
PRESETS: dict[str, dict[str, str]] = {
    "manual": {p: "approve" for p in PERMISSIONS} | {"delegate": "auto", "web_research": "auto",
                                                      "use_library": "auto", "create_content": "auto"},
    "assisted": {p: "auto" for p in PERMISSIONS} | {"publish": "approve", "launch_campaign": "approve",
                                                     "spend": "approve", "broadcast": "approve"},
    "autopilot": {p: "auto" for p in PERMISSIONS} | {"broadcast": "approve"},
}


@dataclass(frozen=True)
class AgentSpec:
    id: str
    name: str
    title: str
    tier: int
    model: str
    effort: str
    permissions: tuple[str, ...]
    skills: tuple[str, ...]
    routines: dict[str, Any] = field(default_factory=dict)
    channel: str | None = None
    persona: str = ""


def _channel_spec(ch: str) -> AgentSpec:
    label = CHANNEL_LABELS[ch]
    skills = ("channel.publish", "channel.engage", "channel.metrics", "channel.analyze")
    perms: tuple[str, ...] = ("publish", "spend")
    if ch == "whatsapp":
        perms = ("publish", "broadcast")  # WhatsApp "publishing" is a broadcast to opted-in subscribers
    return AgentSpec(
        id=ch, name=f"وكيل {label}", title=f"يراقب ويحلل وينشر ويتفاعل على {label}", tier=2, model=SONNET,
        effort="medium", channel=ch, permissions=perms, skills=skills,
        routines={"engage": {"enabled": True, "every_min": 15}, "metrics": {"enabled": True, "every_min": 60},
                  "analyze": {"enabled": True, "at": "07:00"}},
        persona=f"أنت خبير منصة {label}: تعرف خوارزميتها وأفضل أوقاتها وصيغها الرابحة في السوق السعودي، "
                "وتحوّل الأرقام إلى قرارات نشر واضحة.")


SPECS: tuple[AgentSpec, ...] = (
    AgentSpec(id="ceo", name="القائد", title="الرئيس التنفيذي للشبكة — يقرر ويتدخل ويوزّع المهام ويتابع النتائج",
              tier=0, model=OPUS, effort="high", permissions=("delegate", "intervene", "web_research"),
              skills=("ceo.command", "ceo.plan_day", "ceo.steer"),
              routines={"plan_day": {"enabled": True, "at": "08:00"}, "steer": {"enabled": True, "every_min": 180}},
              persona="أنت الرئيس التنفيذي لشبكة التسويق وصاحب القرار فيها: تفكر بالنتيجة التجارية أولًا "
                      "(العملاء المحتملون والمبيعات)، تقيس كل شيء مقابل الأهداف الشهرية، وتتدخل بنفسك عندما تتأخر "
                      "النتائج: توقف ما يستنزف الميزانية، وتنقل الموارد إلى ما يحقق العائد، وتطلب المحتوى والتحليل "
                      "من الوكيل الأنسب. لا تتردد في القرار، ولا تتخذ قرارًا بلا رقم يبرره."),
    AgentSpec(id="campaigns", name="مدير الحملات",
              title="يحلل السوق والمنافسين، يقترح الحملات، ويدير الميزانيات والليمت", tier=1, model=OPUS,
              effort="high", permissions=("web_research", "launch_campaign", "spend", "raise_limits"),
              skills=("campaigns.propose", "campaigns.analyze_competitors", "campaigns.optimize"),
              routines={"optimize": {"enabled": True, "at": "10:00"},
                        "propose": {"enabled": True, "weekday": 6, "at": "09:00"}},
              persona="أنت مدير حملات أداء: تبني كل اقتراح على بيانات (أداء القنوات، المنافسين، الموسم والمناسبات "
                      "السعودية)، وتحدد ميزانية وهدفًا قابلًا للقياس، وتوقف ما لا يحقق العائد."),
    AgentSpec(id="content", name="صانع المحتوى",
              title="يختار من المكتبة، يكتب السكربت والمحتوى، ويرد على العملاء باحتراف", tier=1, model=SONNET,
              effort="high", permissions=("create_content", "use_library", "reply"),
              skills=("content.create_post", "content.revise", "content.reply", "content.send_reply",
                      "content.describe_asset"),
              persona="أنت كاتب محتوى وسكربتات سعودي محترف وصوت العلامة مع العملاء: جمل قصيرة، خطّاف قوي في أول "
                      "ثانيتين، دعوة واضحة لاتخاذ إجراء، وردود دافئة دقيقة لا تعد بما لا تملكه الشركة."),
    AgentSpec(id="coordinator", name="المنسّق",
              title="يستقبل بيانات الوكلاء، يختار النشر المناسب، ويصدر التقرير اليومي", tier=1, model=SONNET,
              effort="medium", permissions=("schedule", "send_reports"),
              skills=("coordinator.distribute", "coordinator.daily_report"),
              routines={"distribute": {"enabled": True, "every_min": 30}, "report": {"enabled": True}},
              persona="أنت منسق العمليات: تجمع أرقام كل الوكلاء بدقة، تمنع تكرار المحتوى بين القنوات، تختار الوقت "
                      "الأنسب لكل منشور، وتكتب تقريرًا يومي مختصرًا صادقًا بالأرقام."),
    AgentSpec(id="guardian", name="الحارس", title="يراقب النظام بالكامل، يكتشف الأخطاء ويصلحها ويُبلغك",
              tier=1, model=SONNET, effort="low", permissions=("auto_fix",), skills=("guardian.sweep", "guardian.apply_fix"),
              routines={"sweep": {"enabled": True, "every_min": 5}},
              persona="أنت مهندس موثوقية: تشخّص السبب الجذري بإيجاز وتقترح أصغر إصلاح آمن."),
    *(_channel_spec(ch) for ch in CHANNELS),
)

BY_ID: dict[str, AgentSpec] = {a.id: a for a in SPECS}
SKILL_OWNER: dict[str, str] = {sk: a.id for a in SPECS if a.tier < 2 for sk in a.skills}
DELEGATABLE = ("campaigns.propose", "campaigns.analyze_competitors", "campaigns.optimize", "content.create_post",
               "coordinator.distribute", "coordinator.daily_report", "channel.analyze", "channel.engage",
               "guardian.sweep")


def default_permissions(spec: AgentSpec, level: str = "assisted") -> dict[str, str]:
    preset = PRESETS[level]
    return {p: preset[p] for p in spec.permissions}


def owner_of(kind: str, channel: str | None = None) -> str:
    """The agent that runs a skill (channel skills belong to the channel's agent)."""
    if kind.startswith("channel."):
        if channel not in CHANNELS:
            raise ValueError(f"channel skill {kind} needs a channel")
        return str(channel)
    if kind not in SKILL_OWNER:
        raise ValueError(f"unknown skill {kind}")
    return SKILL_OWNER[kind]
