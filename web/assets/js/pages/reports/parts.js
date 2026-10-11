// Shared pieces of the reports page: report-day formatting and the delivery chips (WhatsApp / email).
import { html, cls } from '../../lib/h.js';
import { Icon } from '../../ui/core.js';

const LOCALE = 'ar-SA-u-nu-latn-ca-gregory';
const TZ = 'Asia/Riyadh';
const DAY_NUM = new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: TZ });
const MONTH = new Intl.DateTimeFormat(LOCALE, { month: 'long', timeZone: TZ });
const WEEKDAY = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', timeZone: TZ });
const MONTH_YEAR = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric', timeZone: TZ });
const LONG = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
const RIYADH_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });

const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const at = (d) => new Date(`${d}T09:00:00Z`);

export const todayIso = () => RIYADH_DAY.format(new Date());

export function dayParts(d) {
  if (!isDay(d)) return { d: '?', month: '', weekday: '', monthYear: '' };
  const x = at(d);
  return { d: DAY_NUM.format(x), month: MONTH.format(x), weekday: WEEKDAY.format(x), monthYear: MONTH_YEAR.format(x) };
}

export const longDay = (d) => (isDay(d) ? LONG.format(at(d)) : '');

export function yesterdayIso() {
  const t = todayIso();
  return new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10)) - 864e5).toISOString().slice(0, 10);
}

/** Latest report per day (the list is newest first, and a day can be regenerated). */
export function latestPerDay(rows) {
  const seen = new Set();
  return (rows || []).filter((r) => (seen.has(r.day) ? false : (seen.add(r.day), true)));
}

/** An amount in riyals: the number in the mono face, the currency in the text face. */
export function Money({ v }) {
  return html`<span class="rp-money"><span class="num">${new Intl.NumberFormat('en-US').format(Math.round(+v || 0))}</span><span class="rp-cur">ر.س</span></span>`;
}

// ---------------------------------------------------------------- deliveries

export const DELIVERY = { sent: ['أُرسل', 'ok'], sandbox: ['محاكاة', 'warn'], partial: ['وصل جزئيًا', 'warn'], failed: ['تعذّر', 'bad'], skipped: ['لم يُرسل', ''] };
export const DELIVERY_CH = { whatsapp: ['واتساب', 'whatsapp'], email: ['البريد', 'mail'] };

/** The most recent delivery batch per channel (resends append new batches). */
export function latestDeliveries(list) {
  const by = {};
  (list || []).forEach((d) => {
    const ch = d.channel || 'other';
    const stamp = d.at || '';
    if (!by[ch] || stamp > by[ch].at) by[ch] = { at: stamp, items: [d] };
    else if (stamp === by[ch].at) by[ch] = { ...by[ch], items: [...by[ch].items, d] };
  });
  return Object.entries(by).map(([ch, v]) => ({ ch, items: v.items }));
}

function overall(items) {
  const has = (s) => items.some((d) => d.status === s);
  if (has('failed')) return has('sent') || has('sandbox') ? 'partial' : 'failed';
  return ['sent', 'sandbox'].find(has) || 'skipped';
}

export function DeliveryChips({ list }) {
  const groups = latestDeliveries(list);
  if (!groups.length) return html`<span class="rp-dlv"><${Icon} name="send" size="12" />لم يُرسل بعد</span>`;
  return html`<div class="rp-dlvs">${groups.map(({ ch, items }) => {
    const st = overall(items);
    const [chLabel, icon] = DELIVERY_CH[ch] || [ch, 'send'];
    const detail = items.map((d) => [d.to, d.error].filter(Boolean).join(': ')).filter(Boolean).join('\n');
    return html`<span class=${cls('rp-dlv', st)} key=${ch} title=${detail || undefined}><${Icon} name=${icon} size="12" />
      ${chLabel}: ${DELIVERY[st][0]}${items.length > 1 ? html` <span class="num">(${items.length})</span>` : ''}</span>`;
  })}</div>`;
}
