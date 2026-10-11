"""Data model. One company, ten agents, five channels.

Status vocabularies live next to the columns that use them so every module reads the same words.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, new_id, utcnow

CHANNELS = ("tiktok", "instagram", "x", "whatsapp", "linkedin")
ROLES = ("owner", "manager", "editor", "viewer")
TASK_STATUSES = ("queued", "running", "waiting", "done", "failed", "cancelled")
POST_STATUSES = ("idea", "draft", "review", "approved", "scheduled", "publishing", "published", "failed", "rejected")
CAMPAIGN_STATUSES = ("proposed", "approved", "active", "paused", "completed", "rejected")
ASSET_STATUSES = ("pending", "approved", "rejected")
APPROVAL_STATUSES = ("pending", "approved", "rejected", "expired")
INCIDENT_STATUSES = ("open", "fixing", "fixed", "failed", "needs_owner", "ignored")


def _id() -> Mapped[str]:
    return mapped_column(String(32), primary_key=True, default=new_id)


def _created() -> Mapped[datetime]:
    return mapped_column(DateTime, default=utcnow, nullable=False)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = _id()
    email: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), default="")
    password_hash: Mapped[str] = mapped_column(String(300), nullable=False)
    role: Mapped[str] = mapped_column(String(16), default="viewer")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = _created()


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256 of the cookie token
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = _created()
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(300), default="")


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    updated_by: Mapped[str] = mapped_column(String(64), default="system")


class Secret(Base):
    __tablename__ = "secrets"
    id: Mapped[str] = _id()
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    hint: Mapped[str] = mapped_column(String(16), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Connection(Base):
    """One external service. `mode=sandbox` keeps the agent working on simulated data until keys are added."""
    __tablename__ = "connections"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # provider id
    mode: Mapped[str] = mapped_column(String(12), default="sandbox")  # sandbox | live
    status: Mapped[str] = mapped_column(String(20), default="not_configured")  # not_configured|connected|error|paused
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    account: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_error: Mapped[str] = mapped_column(Text, default="")
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Agent(Base):
    __tablename__ = "agents"
    id: Mapped[str] = mapped_column(String(24), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    title: Mapped[str] = mapped_column(String(160), default="")
    tier: Mapped[int] = mapped_column(Integer, default=1)  # 0 CEO · 1 department · 2 channel
    channel: Mapped[str | None] = mapped_column(String(16))
    model: Mapped[str] = mapped_column(String(48), nullable=False)
    effort: Mapped[str] = mapped_column(String(8), default="medium")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    instructions: Mapped[str] = mapped_column(Text, default="")
    permissions: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)
    routines: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="idle")  # idle|working|waiting|error|paused
    status_note: Mapped[str] = mapped_column(String(240), default="")
    current_task_id: Mapped[str | None] = mapped_column(String(32))
    insights: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (Index("ix_tasks_queue", "status", "run_after"),)
    id: Mapped[str] = _id()
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    parent_id: Mapped[str | None] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(48), nullable=False)
    title: Mapped[str] = mapped_column(String(240), default="")
    input: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    output: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    summary: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(12), default="queued")
    priority: Mapped[int] = mapped_column(Integer, default=5)  # lower runs first
    origin: Mapped[str] = mapped_column(String(16), default="routine")  # command|routine|event|guardian|user
    created_by: Mapped[str] = mapped_column(String(64), default="system")
    error: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    run_after: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    created_at: Mapped[datetime] = _created()
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)


class Approval(Base):
    """Anything an agent may not do alone waits here: content, replies, limit raises, campaigns, fixes."""
    __tablename__ = "approvals"
    id: Mapped[str] = _id()
    kind: Mapped[str] = mapped_column(String(24), index=True)  # post|reply|limit|campaign|broadcast|fix|asset
    ref_id: Mapped[str] = mapped_column(String(64), default="")
    agent_id: Mapped[str] = mapped_column(String(24), default="")
    title: Mapped[str] = mapped_column(String(240), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)
    decided_by: Mapped[str] = mapped_column(String(64), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = _created()
    decided_at: Mapped[datetime | None] = mapped_column(DateTime)


class Campaign(Base):
    __tablename__ = "campaigns"
    id: Mapped[str] = _id()
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    objective: Mapped[str] = mapped_column(String(32), default="awareness")  # awareness|engagement|leads|sales
    status: Mapped[str] = mapped_column(String(12), default="proposed", index=True)
    channels: Mapped[list[str]] = mapped_column(JSON, default=list)
    audience: Mapped[str] = mapped_column(Text, default="")
    offer: Mapped[str] = mapped_column(Text, default="")
    budget_total: Mapped[float] = mapped_column(Float, default=0.0)
    daily_budget_cap: Mapped[float] = mapped_column(Float, default=0.0)
    spent: Mapped[float] = mapped_column(Float, default=0.0)
    posts_per_day: Mapped[int] = mapped_column(Integer, default=2)
    start_date: Mapped[str] = mapped_column(String(10), default="")
    end_date: Mapped[str] = mapped_column(String(10), default="")
    kpis: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    results: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    proposal: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(64), default="campaigns")
    approved_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Competitor(Base):
    __tablename__ = "competitors"
    id: Mapped[str] = _id()
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    website: Mapped[str] = mapped_column(String(300), default="")
    handles: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)
    notes: Mapped[str] = mapped_column(Text, default="")
    analysis: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    analyzed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = _created()


class Asset(Base):
    """A library file. Designs are uploaded here and must be approved before agents may use them."""
    __tablename__ = "assets"
    id: Mapped[str] = _id()
    kind: Mapped[str] = mapped_column(String(8), default="image")  # image|video
    file_name: Mapped[str] = mapped_column(String(120), nullable=False)
    original_name: Mapped[str] = mapped_column(String(240), default="")
    mime: Mapped[str] = mapped_column(String(80), default="")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    duration_s: Mapped[float] = mapped_column(Float, default=0.0)
    has_thumb: Mapped[bool] = mapped_column(Boolean, default=False)
    title: Mapped[str] = mapped_column(String(200), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    folder: Mapped[str] = mapped_column(String(80), default="عام")
    status: Mapped[str] = mapped_column(String(10), default="pending", index=True)
    review_note: Mapped[str] = mapped_column(Text, default="")
    ai_described: Mapped[bool] = mapped_column(Boolean, default=False)
    uploaded_by: Mapped[str] = mapped_column(String(64), default="")
    used_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = _created()


class Post(Base):
    __tablename__ = "posts"
    __table_args__ = (Index("ix_posts_due", "status", "scheduled_at"),)
    id: Mapped[str] = _id()
    campaign_id: Mapped[str | None] = mapped_column(ForeignKey("campaigns.id", ondelete="SET NULL"), index=True)
    channel: Mapped[str] = mapped_column(String(16), index=True)
    format: Mapped[str] = mapped_column(String(16), default="post")
    status: Mapped[str] = mapped_column(String(12), default="draft", index=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    brief: Mapped[str] = mapped_column(Text, default="")
    caption: Mapped[str] = mapped_column(Text, default="")
    script: Mapped[str] = mapped_column(Text, default="")
    hashtags: Mapped[list[str]] = mapped_column(JSON, default=list)
    cta: Mapped[str] = mapped_column(String(200), default="")
    asset_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime)
    published_at: Mapped[datetime | None] = mapped_column(DateTime)
    external_id: Mapped[str] = mapped_column(String(120), default="")
    external_url: Mapped[str] = mapped_column(String(400), default="")
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    promoted_budget: Mapped[float] = mapped_column(Float, default=0.0)
    author_agent: Mapped[str] = mapped_column(String(24), default="content")
    version: Mapped[int] = mapped_column(Integer, default=1)
    review_note: Mapped[str] = mapped_column(Text, default="")
    approved_by: Mapped[str] = mapped_column(String(64), default="")
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    error: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Contact(Base):
    __tablename__ = "contacts"
    id: Mapped[str] = _id()
    channel: Mapped[str] = mapped_column(String(16), index=True)
    handle: Mapped[str] = mapped_column(String(160), default="")
    name: Mapped[str] = mapped_column(String(160), default="")
    phone: Mapped[str] = mapped_column(String(32), default="")
    email: Mapped[str] = mapped_column(String(200), default="")
    opted_in: Mapped[bool] = mapped_column(Boolean, default=False)
    opted_in_at: Mapped[datetime | None] = mapped_column(DateTime)
    opt_source: Mapped[str] = mapped_column(String(80), default="")
    stage: Mapped[str] = mapped_column(String(12), default="new")  # new|lead|customer
    lead_score: Mapped[int] = mapped_column(Integer, default=0)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    notes: Mapped[str] = mapped_column(Text, default="")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = _created()


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[str] = _id()
    channel: Mapped[str] = mapped_column(String(16), index=True)
    kind: Mapped[str] = mapped_column(String(12), default="dm")  # comment|dm|whatsapp
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="SET NULL"))
    post_id: Mapped[str | None] = mapped_column(String(32))
    external_ref: Mapped[str] = mapped_column(String(160), default="", index=True)
    status: Mapped[str] = mapped_column(String(12), default="open", index=True)  # open|pending|answered|escalated|closed
    category: Mapped[str] = mapped_column(String(16), default="")  # inquiry|lead|complaint|praise|spam|other
    sentiment: Mapped[str] = mapped_column(String(10), default="")  # positive|neutral|negative
    priority: Mapped[int] = mapped_column(Integer, default=3)
    unread: Mapped[int] = mapped_column(Integer, default=0)
    last_message_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    created_at: Mapped[datetime] = _created()


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[str] = _id()
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    direction: Mapped[str] = mapped_column(String(4), default="in")  # in|out
    author: Mapped[str] = mapped_column(String(64), default="contact")  # contact|<agent id>|user:<id>
    text: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(12), default="received")  # received|pending|sent|failed|discarded
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    external_id: Mapped[str] = mapped_column(String(160), default="")
    created_at: Mapped[datetime] = _created()


class Report(Base):
    __tablename__ = "reports"
    id: Mapped[str] = _id()
    day: Mapped[str] = mapped_column(String(10), index=True)
    kind: Mapped[str] = mapped_column(String(12), default="daily")
    title: Mapped[str] = mapped_column(String(200), default="")
    headline: Mapped[str] = mapped_column(Text, default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    sections: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    deliveries: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(64), default="coordinator")
    created_at: Mapped[datetime] = _created()


class Incident(Base):
    __tablename__ = "incidents"
    id: Mapped[str] = _id()
    check: Mapped[str] = mapped_column(String(40), index=True)
    fingerprint: Mapped[str] = mapped_column(String(160), index=True)
    severity: Mapped[str] = mapped_column(String(10), default="warning")  # info|warning|critical
    title: Mapped[str] = mapped_column(String(240), default="")
    detail: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(12), default="open", index=True)
    fix_action: Mapped[str] = mapped_column(String(60), default="")
    fix_detail: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    notified: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[str] = _id()
    level: Mapped[str] = mapped_column(String(10), default="info")  # info|success|warning|danger
    kind: Mapped[str] = mapped_column(String(24), default="general")
    title: Mapped[str] = mapped_column(String(240), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str] = mapped_column(String(200), default="")
    read: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    channels: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = _created()


class Event(Base):
    """The live activity feed and audit trail."""
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(64), default="system")
    kind: Mapped[str] = mapped_column(String(40), index=True)
    title: Mapped[str] = mapped_column(String(300), default="")
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    ref_kind: Mapped[str] = mapped_column(String(24), default="")
    ref_id: Mapped[str] = mapped_column(String(64), default="")


class LimitChange(Base):
    __tablename__ = "limit_changes"
    id: Mapped[str] = _id()
    key: Mapped[str] = mapped_column(String(80))
    old_value: Mapped[Any] = mapped_column(JSON)
    new_value: Mapped[Any] = mapped_column(JSON)
    by_actor: Mapped[str] = mapped_column(String(64), default="")
    reason: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(10), default="applied")  # applied|pending|rejected
    created_at: Mapped[datetime] = _created()


class UsageLog(Base):
    __tablename__ = "usage_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    agent_id: Mapped[str] = mapped_column(String(24), index=True)
    task_id: Mapped[str] = mapped_column(String(32), default="")
    model: Mapped[str] = mapped_column(String(48), default="")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, default=0)
    web_searches: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    simulated: Mapped[bool] = mapped_column(Boolean, default=False)
