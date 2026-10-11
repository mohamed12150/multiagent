# Architecture

## Shape

```
web/ (Preact + htm, no build)          qsm/ (FastAPI + SQLAlchemy, SQLite by default)
  pages/network.js  ── SSE /api/stream ── events.py (pub/sub + persisted feed)
  pages/*           ── REST /api/*     ── api/*.py ── engine/ (limits, policy, approvals, media, notify, scheduler)
                                                   └── agents/ (runtime + 10 agents' skills) ── ai/client.py (Claude)
                                                                                           └── connectors/ (5 channels + SMTP, sandbox)
```

## The task engine (`agents/runtime.py`)

Every unit of work is a persisted `Task` owned by one agent (`kind` = skill). A worker loop claims due tasks
(`status=queued`, `run_after <= now`, agent enabled and not paused) with an atomic update, runs the skill handler,
and publishes each transition (`created → started → done|failed|retry|waiting`) on the live stream with `from`/`to`
endpoints, which the network map draws as pulses. Transient failures retry with exponential backoff; an exhausted
AI budget parks the task until the next local day. A command from the owner is a `ceo.command` task: القائد returns
a validated plan, the runtime spawns child tasks, the command waits (`waiting`) and completes with a roll-up of its
children's outcomes.

## Skills

| Agent | Skills |
|---|---|
| ceo | `ceo.command`, `ceo.plan_day` |
| campaigns | `campaigns.propose`, `campaigns.analyze_competitors`, `campaigns.optimize` |
| content | `content.create_post`, `content.revise`, `content.reply`, `content.send_reply`, `content.describe_asset` |
| coordinator | `coordinator.distribute`, `coordinator.daily_report` |
| guardian | `guardian.sweep`, `guardian.apply_fix` |
| tiktok · instagram · x · whatsapp · linkedin | `channel.publish`, `channel.engage`, `channel.metrics`, `channel.analyze` |

The model writes language and judgement; **code computes every number** (`agents/state.py`), enforces every limit
(`engine/limits.py`) and every permission (`engine/policy.py`), and validates every model output (enums, ids that
must exist, counts clamped to the remaining room) before anything is written.

## Permissions and approvals

`policy.decide(agent, action)` → `auto | approve | off` from the agent's matrix (presets: manual, assisted,
autopilot). `approve` files an `Approval`; the owner decides in مكتب الاعتماد; a resolver registered per kind
(`post`, `asset`, `reply`, `campaign`, `limit`, `fix`) carries the decision out (e.g. approved post → coordinator
schedules it; post rejected with a note → content agent revises it).

## Limits

Organic posts per channel per day; campaign posts per day (min of the campaign's own and the global cap); daily and
monthly ad spend plus each campaign's daily cap and total budget; replies per hour; WhatsApp broadcasts per day; AI
spend per day. The coordinator only schedules into days with room; the channel agent re-checks at publish time. The
campaign manager may raise a limit alone when `raise_limits=auto`, authority is enabled, the step is within
`max_step_pct` and the value is under the ceiling; otherwise the change is a pending `LimitChange` + approval.

## Claude (`ai/client.py`)

Opus 5.5 (`claude-opus-5-5`) for القائد and مدير الحملات, Sonnet 5.5 (`claude-sonnet-5-5`) for the rest. Adaptive
thinking is always on (never disabled); depth is `output_config.effort`; `max_tokens` = visible budget + thinking
headroom. Structured outputs via `output_config.format` (json_schema, closed objects). Web research is a separate
first call with `web_search_20260209`, then the structured call receives the notes wrapped as untrusted data.
Server-side refusal fallbacks (`fallbacks="default"`, beta `server-side-fallback-2026-07-01`) are on by default
(Settings › AI). System prompts are split into a cached static block (charter, persona, brand) and a dynamic block.
Every call is metered (`usage_logs`) and the daily cap is checked before the call. Without a key, each skill's own
`simulate()` produces a realistic result marked simulated.

## Connectors

One contract (`connectors/base.py`): `test, account, publish, metrics, inbox, reply, send, refresh`. `build(provider)`
returns the live client only when the connection is `live`; otherwise the sandbox, so agents never branch on mode.
Live implementations follow the platforms' documented APIs: Instagram Graph (containers → publish, comments,
insights), TikTok Content Posting (FILE_UPLOAD chunks, status polling, creator privacy), X API v2 (chunked media
upload, threads, mentions, public metrics), WhatsApp Cloud API (text/template/media, webhook inbound), LinkedIn
Posts API (image upload, social metadata, comments), SMTP.

## The guardian

Checks (runtime/scheduler heartbeats, stuck and failed tasks, failed/stuck/late posts, connection errors, token
expiry, disk, backups, queue backlog, AI budget, stale approvals, missing or undelivered report) produce findings
with a playbook. Incidents are deduplicated by fingerprint, auto-resolved when the cause disappears, and a problem
that recurs three times in 24 hours stops being auto-fixed and goes to the owner. The scheduler watches the runtime
and the guardian watches the scheduler.

## Security

scrypt passwords, lockout after 5 failures, HttpOnly SameSite=Strict session cookie, CSRF header on every write,
role ladder owner > manager > editor > viewer, Fernet-encrypted vault (secrets never returned, 4-char hints),
magic-byte upload sniffing with size caps, signed time-limited public media links (approved files only), Meta webhook
HMAC verification, strict CSP (`script-src 'self'`), request size limits, untrusted-data wrapping for customer
messages and web results.
