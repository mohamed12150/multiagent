# Qhub Smart Marketing — Frontend guide (read fully before writing a page)

Arabic-first, RTL, no-build **Preact + htm**. Every page is one ES module under `web/assets/js/pages/` that
default-exports a component `({ params, query }) => html\`…\``, plus one stylesheet under `web/assets/css/pages/`
(already linked from `web/index.html`). The shell (side rail, top bar, toasts, confirm host) is already rendered
around the page; the page renders only its content. Reference implementation: `pages/network.js` and
`css/pages/network.css` — match their quality, density and idioms.

## Imports (relative to `web/assets/js/pages/`)

```js
import { html, cls, useState, useEffect, useMemo, useRef, useCallback } from '../lib/h.js';
import { api, useApi } from '../lib/api.js';            // api.get/post/put/patch/del/raw; useApi(path, deps)
import { useLive } from '../lib/live.js';               // useLive('task'|'feed'|'agent'|'approvals'|'inbox'|'metrics'|'incident'|'notification', fn)
import { Link, navigate, setQuery } from '../lib/router.js';
import { can, session, useStore } from '../lib/store.js'; // can('viewer'|'editor'|'manager'|'owner')
import * as F from '../lib/format.js';                  // num, compact, money, usd, ago, until, date, dateTime, time, localInput,
                                                         // CHANNELS, CHANNEL_LABEL, POST_STATUS, TASK_STATUS, AGENT_STATUS,
                                                         // CAMPAIGN_STATUS, OBJECTIVE, CONV_STATUS, CATEGORY, APPROVAL_KIND,
                                                         // PERM_VALUE, AUTONOMY, EFFORT, label(map,k), tone(map,k)
import { Icon, Button, Badge, StatusBadge, SimTag, Card, Empty, Skeleton, ErrorBox, Loader, Stat, Meter, Seg, Tabs,
         Toggle, Field, ChannelMark, AgentMark, Spark, Bars, Thumb, KeyVal, useClickAway, usePoll } from '../ui/core.js';
import { Drawer, Modal, toast, confirm } from '../ui/overlays.js';
```

Read `web/assets/js/ui/core.js`, `ui/overlays.js`, `lib/*.js` once — they are short. Do **not** edit shared files
(`lib/*`, `ui/*`, `layout/*`, `app.js`, `routes.js`, `index.html`, `css/tokens.css|base.css|components.css|shell.css`).
If you need a widget, build it inside your page module. Mention any shared need in your final report.

### Key components
- `Button({variant:'primary'|'ghost'|'danger'|'ok', size:'sm'|'xs', icon, iconEnd, loading})` — icon-only when no children.
- `Badge({tone:'accent'|'ok'|'warn'|'bad'|'live'|'outline', icon})`, `StatusBadge({map: F.POST_STATUS, value})`.
- `Card({title, icon, actions, pad=true})` — titled card. Plain surface: `<div class="card pad">`.
- `Loader({state, skeleton, children: (data, meta) => …})` with `state = useApi(path)` → handles loading/error.
- `Empty({icon, title, text, action})` — every list needs a composed empty state that says how to fill it.
- `Drawer({title, icon, onClose, footer, wide, head})`, `Modal({title, onClose, footer, wide})`.
- `toast(msg, 'ok'|'bad'|'warn', title?)`, `toast.error(err)`; `await confirm({title, text, ok, danger, input, placeholder})`.
- `Seg({options:[{value,label}], value, onChange, size:'sm', accent})`, `Tabs({tabs:[{id,label,icon,count}], value, onChange})`.
- `Field({label, help, error})` wraps native `<input class="input">`, `<textarea class="textarea">`, `<select class="select">`.
- `Toggle({checked, onChange, label})`, `Meter({value, max, tone})`, `Stat({label, value, delta, hint, icon})`.
- `ChannelMark({ch, size:'sm'|'lg'})`, `AgentMark({id})`, `Thumb({asset, onClick})` (library asset tile).
- `Spark({values})` sparkline, `Bars({data:[{label, value, short}]})` (CSS for `.bars` lives in network.css; it is global).
- `Icon({name, size})` — names in `lib/icons.js` (e.g. orbit, megaphone, kanban, image, video, message, chart, shield,
  sliders, send, check, checkCircle, x, plus, edit, trash, refresh, play, pause, calendar, clock, upload, download,
  eye, heart, star, filter, search, target, wand, workflow, crown, gauge, key, plug, link, mail, phone, user, users,
  bell, alert, info, coins, wallet, lightbulb, trend, activity, sparkles, file, copy, tiktok, instagram, xlogo,
  whatsapp, linkedin, beaker, cpu, globe, lock, webhook, history, inbox, grid, list, flag, rocket, bot, command).

### CSS
Tokens in `css/tokens.css` (both themes): `--bg --surface --surface-2 --surface-3 --line --line-2 --text --text-2
--text-3 --accent --accent-soft --accent-text --live --ok --warn --bad (+ -soft, -text) --c-<channel>
--r-card(18) --r-ctl(10) --r-pill --shadow-1 --shadow-2 --ease --t-fast --t-med --mono`.
Utility classes in base/components: `row col grow between wrap top gap-6 gap-16 mt-8 mt-16 mt-24 grid grid-2 grid-3
grid-4 muted faint small tiny strong ellipsis clamp-2 clamp-3 pre ltr num mono card pad tight well notice(.warn .bad .ok)
chip(.on) count list>.item(.click) table table-wrap kv thumb sim tabs seg badge`.
Page CSS: prefix every class with the page's short prefix (`cp-` campaigns, `ct-` content, `lb-` library, `chp-`
channels, `ib-` inbox, `rp-` reports, `gd-` guardian, `st-` settings) so pages never collide. Use tokens, never raw
colours (channel colours via `--c-tiktok` etc.). Shape rule: cards 18px, controls 10px, pills full. Both themes must
work (only tokens → automatic). Mobile: at ≤ 980px multi-column layouts collapse to one column; no horizontal page
scroll at 390px. Respect reduced motion (transitions only via tokens; no infinite animations except `.status-dot.working`).

## Product rules
- All visible copy in clear Arabic (Saudi-friendly, professional). Numbers with `F.num/compact` (Latin digits).
  Do not use the em-dash character in new UI copy; use commas, periods or colons.
- Every page: loading skeleton shaped like the content, composed empty state, inline error with retry, toasts for
  actions. Disable or hide actions the role cannot do (`can('editor')` to create/edit, `can('manager')` to approve,
  delete, change limits/connections; `can('owner')` for users and autonomy).
- Anything produced in sandbox mode shows `<SimTag />` (post.sandbox, report.simulated, task.output.simulated,
  connection.mode === 'sandbox').
- Live updates: subscribe with `useLive` and reload quietly (`state.reload(true)`), debounced if frequent.
- Long-running work is a task: endpoints that start work return a task object; toast «بدأ الوكيل …» and let live
  events refresh the page. Never block the UI waiting for agents.
- URL is state for tabs/filters: read `query`, write with `setQuery({tab: 'x'})`.
- No new dependencies, no CDN, no inline `<style>`, no `innerHTML`. CSP is `script-src 'self'`.

## API (envelope `{ok, data, meta}` is unwrapped by `api`; `api.raw` keeps `meta`)
Shapes come from `qsm/api/serial.py`; routes from `qsm/api/*.py` — read them for exact fields.
- Network: `GET /network`, `GET /agents/{id}`, `PATCH /agents/{id}` `{enabled,paused,model,effort,instructions,permissions,routines}`,
  `POST /agents/{id}/run {kind}`, `POST /command {text}`, `GET /tasks?agent=&status=&origin=`, `GET /tasks/{id}`,
  `POST /tasks/{id}/cancel|retry`, `GET /feed`.
- Approvals: `GET /approvals?status=pending&kind=` (meta.counts), `POST /approvals/{id}/decide {approve, note, text?}`.
- Campaigns: `GET /campaigns?status=`, `GET /campaigns/{id}` (+posts, results), `POST /campaigns` `{name, objective,
  channels[], audience, offer, budget_total, daily_budget_cap, posts_per_day, start_date, end_date, kpis, pillars[], launch}`,
  `PATCH /campaigns/{id}` `{status, budget_total, daily_budget_cap, posts_per_day, end_date, audience, offer}`,
  `POST /campaigns/{id}/decide {approve, note}`, `POST /campaigns/propose {focus}` → task.
  Competitors: `GET/POST /competitors`, `PATCH/DELETE /competitors/{id}` `{name, website, handles:{channel:handle}, notes}`,
  `POST /competitors/analyze` → task. Limits: `GET /limits` (snapshot + `changes[]`), `PUT /limits` (full Limits object,
  see `qsm/settings.py` class Limits/Raise).
- Content: `GET /posts?status=a,b&channel=&campaign=&q=` (meta.counts), `GET /posts/calendar?start=YYYY-MM-DD&days=7`,
  `GET /posts/{id}` (+approval_id), `POST /posts` `{channel, format, title, caption, script, hashtags[], cta, asset_ids[],
  campaign_id, submit}`, `PATCH /posts/{id}`, `POST /posts/{id}/submit|approve|reject {note}`, `POST /posts/{id}/schedule
  {at:"YYYY-MM-DDTHH:MM" Riyadh local}`, `POST /posts/{id}/unschedule|publish-now`, `DELETE /posts/{id}`,
  `POST /posts/generate {channel, brief, count, campaign_id}` → task. Formats per channel: tiktok video|photo,
  instagram reel|post|carousel|story, x post|thread, linkedin post|article, whatsapp broadcast.
- Library: `GET /library?kind=&status=&folder=&q=` (meta.folders, meta.counts), `POST /library` multipart `files[]`
  + `folder` (meta.errors), `PATCH /library/{id} {title, description, tags[], folder}`, `POST /library/{id}/review
  {approve, note}`, `DELETE /library/{id}`; media at asset.url / asset.thumb.
- Channels: `GET /channels/{ch}`; run with `POST /agents/{ch}/run {kind:'channel.analyze'|'channel.engage'|'channel.metrics'|'channel.publish'}`.
- Inbox: `GET /inbox?status=&channel=&category=` (meta.counts), `GET /inbox/{id}` (+messages), `POST /inbox/{id}/reply
  {text}`, `POST /inbox/{id}/ai-reply`, `PATCH /inbox/{id} {status}`, `GET /contacts?channel=&opted_in=&stage=`,
  `PATCH /contacts/{id} {name, stage, notes, opted_in, opt_source}` (opting in requires `opt_source`).
- Reports: `GET /reports`, `GET /reports/{id}` (+whatsapp_text), `GET /reports/{id}/email` (HTML for an iframe),
  `POST /reports/generate` → task, `POST /reports/{id}/send`.
- Guardian: `GET /guardian` `{incidents[], last, components[], fix_labels}`, `POST /guardian/sweep` → task,
  `POST /guardian/incidents/{id}/fix|ignore`. AI usage: `GET /usage?days=`.
- Settings: `GET /settings` `{sections:{brand,limits,notify,autonomy,general,ai}, models, permissions, presets}`,
  `PUT /settings/{brand|notify|general|ai}` (full section object), `POST /settings/autonomy {level}`,
  `GET /connections`, `PUT /connections/{provider} {config:{}, secrets:{}, mode:'sandbox'|'live'}`,
  `POST /connections/{provider}/test` → `{ok, detail, connection}`, `DELETE /connections/{provider}`, `GET /webhooks`,
  `GET/POST /users`, `PATCH /users/{id} {role, active, name}`, `POST /auth/password {current, new}`.

## Verify
`"/Users/niefalbagmai/Downloads/QHub AGI/qhub-platform/.tools/node/bin/node" --check <file>` on every JS file you
write (syntax only). Check htm templates by eye: every `<${X}>` closes with `</${X}>`, attributes use `${}` without
quotes, no stray backticks. Never start or stop servers, never touch ports 8765/8821/8822 or any data folder.
