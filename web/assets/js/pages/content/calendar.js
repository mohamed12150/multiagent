// The week calendar (Sunday to Saturday, Riyadh days): what goes out when, coloured by channel.
import { html, cls, useEffect, useMemo } from '../../lib/h.js';
import { useApi } from '../../lib/api.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Skeleton, Loader } from '../../ui/core.js';
import {
  addDays, weekStart, todayYmd, riyadhDay, weekdayName, dayNumber, monthShort, dayMonth,
} from './shared.js';

const DAYS = 7;
const when = (p) => p.published_at || p.scheduled_at;
const STATE_ICON = { published: 'checkCircle', failed: 'alert', publishing: 'send' };

function matches(p, channel, q) {
  if (channel && p.channel !== channel) return false;
  if (!q) return true;
  const needle = q.toLowerCase();
  return `${p.title} ${p.caption}`.toLowerCase().includes(needle);
}

function EventChip({ post: p, onOpen }) {
  const suggested = p.status === 'approved';
  const label = p.title || (p.caption || '').split('\n')[0] || 'منشور';
  const state = suggested ? 'وقت مقترح بانتظار الجدولة' : F.label(F.POST_STATUS, p.status);
  return html`<button type="button" class=${cls('ct-ev', `ct-c-${p.channel}`, `is-${p.status}`)} onClick=${() => onOpen(p.id)}
      title=${`${p.channel_label} · ${state}\n${label}`}>
    <span class="ct-ev-top"><${Icon} name=${F.CHANNEL_ICON[p.channel]} size="13" class="ct-ev-ch" />
      <span class="num">${F.time(when(p))}</span>
      ${STATE_ICON[p.status] && html`<${Icon} name=${STATE_ICON[p.status]} size="13" class="ct-ev-state" />`}
      ${suggested && html`<span class="ct-ev-tag">مقترح</span>`}</span>
    <span class="ct-ev-title clamp-2">${label}</span>
  </button>`;
}

function CalendarSkeleton({ days }) {
  return html`<div class="ct-cal" aria-busy="true">${days.map((d, i) => html`<section class="ct-day" key=${d}>
    <header class="ct-day-head"><${Skeleton} h=${12} w="54px" /></header>
    <div class="ct-day-body">${Array.from({ length: (i % 3) + 1 }, (_, j) => html`<div class="skeleton ct-ev-sk" key=${j} />`)}</div>
  </section>`)}</div>`;
}

export function Calendar({ week, channel, q, tick, onOpen, onWeek }) {
  const st = useApi(`/posts/calendar?start=${week}&days=${DAYS}`);
  useEffect(() => { if (tick) st.reload(true); }, [tick]);
  const today = todayYmd();
  const thisWeek = weekStart(today);
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(week, i)), [week]);
  const end = days[DAYS - 1];

  return html`<div class="ct-cal-wrap">
    <div class="ct-cal-nav">
      <div class="row gap-6">
        <${Button} size="sm" icon="chevronRight" aria-label="الأسبوع السابق" title="الأسبوع السابق" onClick=${() => onWeek(addDays(week, -DAYS))} />
        <${Button} size="sm" disabled=${week === thisWeek} onClick=${() => onWeek(null)}>هذا الأسبوع</${Button}>
        <${Button} size="sm" icon="chevronLeft" aria-label="الأسبوع التالي" title="الأسبوع التالي" onClick=${() => onWeek(addDays(week, DAYS))} />
      </div>
      <h2 class="ct-cal-range">${dayMonth(week)} إلى ${dayMonth(end)}</h2>
      <div class="ct-legend">
        <span><i class="ct-leg-solid" />مجدول</span><span><i class="ct-leg-dash" />وقت مقترح</span>
        <span><${Icon} name="checkCircle" size="13" />منشور</span>
      </div>
    </div>
    <${Loader} state=${st} skeleton=${html`<${CalendarSkeleton} days=${days} />`}>${(rows) => {
      const visible = rows.filter((p) => matches(p, channel, q));
      const byDay = new Map(days.map((d) => [d, []]));
      visible.forEach((p) => byDay.get(riyadhDay(when(p)))?.push(p));
      byDay.forEach((list) => list.sort((a, b) => Date.parse(when(a)) - Date.parse(when(b))));
      return html`
        ${!visible.length && html`<div class="notice mt-12"><${Icon} name="calendar" size="18" /><div class="grow">
          <b>${rows.length ? 'لا منشورات تطابق الفلاتر هذا الأسبوع' : 'لا منشورات في هذا الأسبوع'}</b>
          ${rows.length ? 'غيّر القناة أو امسح البحث لترى الباقي.' : 'المحتوى المعتمد يجدوله المنسّق تلقائيًا في أفضل وقت، أو جدوله يدويًا من نافذة المنشور.'}</div></div>`}
        <div class="ct-cal">${days.map((d) => {
          const list = byDay.get(d);
          return html`<section class=${cls('ct-day', d === today && 'today', d < today && 'past')} key=${d}
              aria-label=${`${weekdayName(d)} ${dayMonth(d)}`}>
            <header class="ct-day-head">
              <span class="ct-day-name">${weekdayName(d)}</span>
              <span class="ct-day-date"><b class="num">${dayNumber(d)}</b> ${monthShort(d)}</span>
              ${d === today && html`<span class="ct-today">اليوم</span>`}
              ${list.length > 0 && html`<span class="ct-day-n num">${list.length}</span>`}
            </header>
            <div class="ct-day-body">${list.length ? list.map((p) => html`<${EventChip} key=${p.id} post=${p} onOpen=${onOpen} />`)
              : html`<p class="ct-day-empty">لا منشورات</p>`}</div>
          </section>`;
        })}</div>`;
    }}</${Loader}>
  </div>`;
}
