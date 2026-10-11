// Shared pieces of the campaigns page: dates, vocabulary, small widgets, and the status / decision actions.
import { html, cls, useState, useEffect } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { can, session } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Button, ChannelMark, Meter } from '../../ui/core.js';
import { toast, confirm } from '../../ui/overlays.js';

// ---------------------------------------------------------------- dates (campaign dates are plain YYYY-MM-DD)

const DAY_MS = 864e5;
const RIYADH_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' });
const toUtc = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

export const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
export const todayIso = () => RIYADH_DAY.format(new Date());
export const addDays = (d, n) => new Date(toUtc(d) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a, b) => (isDay(a) && isDay(b) ? Math.round((toUtc(b) - toUtc(a)) / DAY_MS) : null);
export const dayLabel = (d) => (isDay(d) ? F.date(`${d}T09:00:00Z`) : '');

export function dateRange(start, end) {
  if (!isDay(start) && !isDay(end)) return 'بلا تواريخ محددة';
  if (!isDay(end)) return `من ${dayLabel(start)}`;
  if (!isDay(start)) return `حتى ${dayLabel(end)}`;
  return `${dayLabel(start)} إلى ${dayLabel(end)}`;
}

/** Arabic counted noun: countText(1, 'يوم واحد', 'يومان', 'أيام', 'يومًا') → يوم واحد · يومان · 5 أيام · 14 يومًا */
export function countText(n, one, two, few, many) {
  if (n === null || n === undefined) return '';
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${F.num(n)} ${few}`;
  return `${F.num(n)} ${many}`;
}

export const daysText = (n) => countText(n, 'يوم واحد', 'يومان', 'أيام', 'يومًا');

export const durationOf = (c) => { const n = daysBetween(c.start_date, c.end_date); return n === null ? null : n + 1; };

export function timeLeft(c) {
  if (c.status === 'completed') return 'انتهت';
  const left = daysBetween(todayIso(), c.end_date);
  if (left === null) return '';
  if (left < 0) return 'تجاوزت تاريخ الانتهاء';
  if (left === 0) return 'تنتهي اليوم';
  return `تنتهي بعد ${daysText(left)}`;
}

// ---------------------------------------------------------------- vocabulary

export const KPI = {
  reach: { label: 'الوصول', icon: 'eye', fmt: (v) => F.compact(v) },
  engagement_rate: { label: 'معدل التفاعل', icon: 'heart', fmt: (v) => `${F.dec(v, 1)}٪` },
  leads: { label: 'عملاء محتملون', icon: 'users', fmt: (v) => F.num(v) },
  sales: { label: 'مبيعات', icon: 'coins', fmt: (v) => F.num(v) },
};

export const LIVE_STATUSES = ['active', 'approved', 'paused', 'completed'];
export const STATUS_ORDER = { active: 0, approved: 1, paused: 2, completed: 3 };

export function actorLabel(a) {
  if (!a) return '';
  if (a.startsWith('user:')) return a === `user:${session.get().user?.id}` ? 'أنت' : 'أحد أعضاء الفريق';
  return F.AGENT_NAME[a] || a;
}

// ---------------------------------------------------------------- links (only http/https ever reach an href)

export function safeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return null;
  const full = /^https?:\/\//i.test(s) ? s : /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s) ? `https://${s}` : null;
  if (!full) return null;
  try {
    const url = new URL(full);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

export function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u || ''); }
}

export function Sources({ items, max = 6 }) {
  const list = (items || [])
    .map((s) => (typeof s === 'string' ? { url: s } : s || {}))
    .map((s) => ({ ...s, href: safeUrl(s.url) }))
    .filter((s) => s.href)
    .slice(0, max);
  if (!list.length) return null;
  return html`<div class="cp-sources">${list.map((s) => html`<a key=${s.href} href=${s.href} target="_blank" rel="noopener noreferrer"
    title=${s.title || s.href}><${Icon} name="link" size="13" /><span class="ellipsis">${s.title || hostOf(s.href)}</span>
    <span class="tiny faint ltr">${hostOf(s.href)}</span></a>`)}</div>`;
}

// ---------------------------------------------------------------- small widgets

export function Label({ icon, children, class: c }) {
  return html`<div class=${cls('cp-label', c)}>${icon && html`<${Icon} name=${icon} size="14" />`}${children}</div>`;
}

export function Pills({ items }) {
  if (!items?.length) return null;
  return html`<div class="cp-pills">${items.map((p, i) => html`<span class="cp-pill" key=${i}>${p}</span>`)}</div>`;
}

export function Channels({ list, labels = false }) {
  if (!list?.length) return null;
  return html`<div class="cp-chs">${list.map((ch) => (labels
    ? html`<span class="cp-ch" key=${ch}><${ChannelMark} ch=${ch} size="sm" />${F.CHANNEL_LABEL[ch] || ch}</span>`
    : html`<${ChannelMark} key=${ch} ch=${ch} size="sm" />`))}</div>`;
}

/** An amount in riyals: the number in the mono face, the currency in the text face (mono spaces Arabic letters apart). */
export function Money({ v }) {
  return html`<span class="cp-money"><span class="num">${F.num(v)}</span><span class="cp-cur">ر.س</span></span>`;
}

/** Spent vs total budget, with the daily cap underneath. Spending the whole budget is on plan once a campaign ends. */
export function BudgetMeter({ spent = 0, total = 0, cap, compact = false, ended = false }) {
  const pct = total ? Math.round((spent / total) * 100) : 0;
  const tone = total && spent > total ? 'bad' : ended ? 'ok' : pct >= 90 ? 'warn' : 'accent';
  return html`<div class="cp-budget">
    <div class="row between small"><span class="muted">${compact ? 'الصرف' : 'المصروف من الميزانية'}</span>
      <span class="cp-amount"><${Money} v=${spent} /><span class="faint">من</span>${total ? html`<${Money} v=${total} />` : html`<span class="faint">بلا سقف</span>`}</span></div>
    <${Meter} value=${spent} max=${total || 1} tone=${tone} />
    ${cap !== undefined && html`<div class="cp-budget-foot tiny faint"><span>${total ? `${pct}٪ مستهلك` : 'لم تُحدد ميزانية كلية'}</span>
      <span>السقف اليومي ${cap ? F.money(cap) : 'غير محدد'}</span></div>`}
  </div>`;
}

/** Numeric field with a unit; keeps the typed text while editing and reports clamped numbers. */
export function NumInput({ value, onChange, min = 0, max, step = 1, suffix, disabled, label, int = step === 1 }) {
  const [raw, setRaw] = useState(value === undefined || value === null ? '' : String(value));
  useEffect(() => { if (Number(raw) !== value) setRaw(value === undefined || value === null ? '' : String(value)); }, [value]);
  const clamp = (n) => {
    const v = Math.min(max ?? Infinity, Math.max(min, n));
    return int ? Math.round(v) : Math.round(v * 100) / 100;
  };
  const input = (e) => {
    const s = e.currentTarget.value;
    setRaw(s);
    const n = Number(s);
    if (s !== '' && Number.isFinite(n)) onChange(clamp(n));
  };
  return html`<label class=${cls('cp-num', disabled && 'off')}>
    <input type="number" inputmode=${int ? 'numeric' : 'decimal'} min=${min} max=${max} step=${step} value=${raw}
      disabled=${disabled} aria-label=${label} onInput=${input}
      onBlur=${() => setRaw(value === undefined || value === null ? '' : String(value))} />
    ${suffix && html`<span>${suffix}</span>`}
  </label>`;
}

// ---------------------------------------------------------------- status moves (mirror of TRANSITIONS in qsm/api/campaigns.py)

const COMPLETE = {
  to: 'completed', label: 'إنهاء', icon: 'flag', done: 'أُنهيت الحملة',
  confirm: (c) => ({ title: 'إنهاء الحملة؟', text: `ستتوقف «${c.name}» نهائيًا ولن تُنشر لها منشورات جديدة. لا يمكن إعادة تشغيلها بعد الإنهاء.`, ok: 'أنهِ الحملة', danger: true }),
};

export const STATUS_ACTIONS = {
  approved: [{
    to: 'active', label: 'أطلق الآن', icon: 'rocket', variant: 'primary', done: 'انطلقت الحملة وبدأ تجهيز منشورات الانطلاق',
    confirm: (c) => ({ title: 'إطلاق الحملة الآن؟', text: `ستنطلق «${c.name}» اليوم، ويبدأ صانع المحتوى بتجهيز منشورات الانطلاق على قنواتها.`, ok: 'أطلق الحملة' }),
  }],
  active: [{ to: 'paused', label: 'إيقاف مؤقت', icon: 'pause', done: 'أُوقفت الحملة مؤقتًا' }, COMPLETE],
  paused: [{ to: 'active', label: 'استئناف', icon: 'play', variant: 'primary', done: 'استؤنفت الحملة' }, COMPLETE],
};

export function StatusActions({ c, onDone, size = 'sm' }) {
  const [busy, setBusy] = useState('');
  const acts = STATUS_ACTIONS[c.status] || [];
  if (!can('manager') || !acts.length) return null;
  const run = async (a) => {
    if (a.confirm && !(await confirm(a.confirm(c)))) return;
    setBusy(a.to);
    try {
      const out = await api.patch(`/campaigns/${c.id}`, { status: a.to });
      toast(a.done, 'ok', c.name);
      onDone?.(out);
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  return html`<div class="cp-acts">${acts.map((a) => html`<${Button} key=${a.to} size=${size} variant=${a.variant || ''} icon=${a.icon}
    loading=${busy === a.to} disabled=${!!busy} onClick=${(e) => { e.stopPropagation(); run(a); }}>${a.label}</${Button}>`)}</div>`;
}

// ---------------------------------------------------------------- proposal decisions

export async function approveCampaign(c) {
  const yes = await confirm({
    title: 'اعتماد الحملة وإطلاقها؟',
    text: `ستنطلق «${c.name}» بميزانية ${c.budget_total ? F.money(c.budget_total) : 'غير محددة'} وسقف يومي ${c.daily_budget_cap ? F.money(c.daily_budget_cap) : 'غير محدد'}، ويبدأ صانع المحتوى بتجهيز منشورات الانطلاق.`,
    ok: 'اعتمد وأطلق',
  });
  if (!yes) return null;
  const out = await api.post(`/campaigns/${c.id}/decide`, { approve: true, note: '' });
  toast('اعتُمدت الحملة وانطلقت، وبدأ تجهيز منشورات الانطلاق', 'ok', c.name);
  return out;
}

export async function rejectCampaign(c) {
  const note = await confirm({
    title: 'رفض المقترح',
    text: 'اذكر سبب الرفض باختصار ليُحفظ مع القرار.',
    input: true, placeholder: 'مثال: الميزانية أعلى من المناسب هذا الشهر', ok: 'ارفض المقترح', danger: true,
  });
  if (note === false) return null;
  const out = await api.post(`/campaigns/${c.id}/decide`, { approve: false, note: String(note || '').trim().slice(0, 2000) });
  toast('رُفض المقترح وحُفظ سببك', 'warn', c.name);
  return out;
}

export function DecisionActions({ c, onDone, size = '' }) {
  const [busy, setBusy] = useState('');
  if (!can('manager')) return html`<span class="tiny faint">الاعتماد للمدير أو المالك</span>`;
  const run = async (kind) => {
    setBusy(kind);
    try {
      const out = kind === 'approve' ? await approveCampaign(c) : await rejectCampaign(c);
      if (out) onDone?.(out);
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  return html`<div class="cp-acts">
    <${Button} variant="ok" size=${size} icon="check" loading=${busy === 'approve'} disabled=${!!busy} onClick=${() => run('approve')}>اعتمد وأطلق</${Button}>
    <${Button} variant="danger" size=${size} icon="x" loading=${busy === 'reject'} disabled=${!!busy} onClick=${() => run('reject')}>ارفض</${Button}>
  </div>`;
}
