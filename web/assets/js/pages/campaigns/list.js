// «الحملات» tab: an overview of running money and reach, then one rich strip per campaign.
import { html, cls } from '../../lib/h.js';
import { Link } from '../../lib/router.js';
import { can } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Badge, StatusBadge, SimTag, Empty, Skeleton, Stat, Meter, Seg } from '../../ui/core.js';
import {
  BudgetMeter, Money, Channels, StatusActions, LIVE_STATUSES, STATUS_ORDER, KPI, countText, dateRange, daysText, durationOf, timeLeft,
} from './shared.js';

const sum = (rows, fn) => rows.reduce((a, c) => a + (+fn(c) || 0), 0);

function Overview({ rows, proposals }) {
  const by = (s) => rows.filter((c) => c.status === s);
  const running = rows.filter((c) => c.status === 'active' || c.status === 'paused');
  const budget = sum(running, (c) => c.budget_total);
  const waiting = [by('paused').length && `${F.num(by('paused').length)} موقوفة`,
    by('approved').length && `${F.num(by('approved').length)} بانتظار الإطلاق`].filter(Boolean).join(' · ');
  return html`<div class="card pad cp-overview">
    <${Stat} label="حملات نشطة" icon="megaphone" value=${F.num(by('active').length)} hint=${waiting || 'لا حملات موقوفة'} />
    <${Stat} label="المصروف على الحملات الجارية" icon="wallet" value=${html`<${Money} v=${sum(running, (c) => c.spent)} />`}
      hint=${budget ? `من ميزانية ${F.money(budget)}` : 'لم تُحدد ميزانيات بعد'} />
    <${Stat} label="وصول الحملات" icon="eye" value=${F.compact(sum(running, (c) => c.results?.reach))}
      hint=${`المنشورات المنشورة: ${F.num(sum(running, (c) => c.results?.posts))}`} />
    <${Stat} label="مقترحات بانتظارك" icon="lightbulb" value=${F.num(proposals)} hint=${proposals ? 'تحتاج قرارك' : 'لا شيء معلّق'} />
  </div>`;
}

function KpiCell({ label, value, sub, progress }) {
  return html`<div class="cp-kpi"><span class="cp-kpi-k">${label}</span><b>${value}</b>
    ${sub ? html`<span class="cp-kpi-t">${sub}</span>` : null}
    ${progress !== null && progress !== undefined
      ? html`<${Meter} value=${Math.min(progress, 100)} max=${100} tone=${progress >= 100 ? 'ok' : 'accent'} />` : null}</div>`;
}

const ratio = (actual, target) => (target ? Math.round(((+actual || 0) / +target) * 100) : null);

function Results({ c }) {
  const r = c.results || {};
  const k = c.kpis || {};
  const days = durationOf(c);
  return html`<div class="cp-kpis">
    <${KpiCell} label="الوصول" value=${F.compact(r.reach)} sub=${k.reach ? `الهدف ${KPI.reach.fmt(k.reach)}` : ''} progress=${ratio(r.reach, k.reach)} />
    <${KpiCell} label="التفاعل" value=${KPI.engagement_rate.fmt(r.engagement_rate || 0)}
      sub=${k.engagement_rate ? `الهدف ${KPI.engagement_rate.fmt(k.engagement_rate)}` : ''} progress=${ratio(r.engagement_rate, k.engagement_rate)} />
    <${KpiCell} label="المنشورات" value=${F.num(r.posts)} sub=${`الإيقاع ${F.num(c.posts_per_day)} يوميًا`} />
    <${KpiCell} label="أيام التشغيل" value=${F.num(r.days_running)} sub=${days ? `من ${daysText(days)}` : 'مدة مفتوحة'}
      progress=${days ? ratio(r.days_running, days) : null} />
  </div>`;
}

function Waiting({ c }) {
  const k = c.kpis || {};
  const goals = Object.keys(KPI).filter((key) => k[key]).map((key) => `${KPI[key].label} ${KPI[key].fmt(k[key])}`);
  return html`<div class="cp-strip-wait">
    <span class="cp-wait-t"><${Icon} name="rocket" size="15" />${c.status === 'approved' ? 'معتمدة ولم تنطلق بعد' : 'لا نتائج بعد'}</span>
    <span class="tiny faint">${goals.length ? `المستهدف: ${goals.join(' · ')}` : `المنشورات اليومية عند الانطلاق: ${F.num(c.posts_per_day)}`}</span>
  </div>`;
}

function Strip({ c, onChanged }) {
  const launched = c.status !== 'approved' && c.results && c.results.days_running !== undefined;
  const left = c.status === 'active' ? timeLeft(c) : '';
  return html`<article class=${cls('cp-strip', `st-${c.status}`)}>
    <div class="cp-strip-id">
      <div class="row gap-6 wrap"><${StatusBadge} map=${F.CAMPAIGN_STATUS} value=${c.status} />
        <${Badge} tone="outline" icon="target">${F.OBJECTIVE[c.objective] || c.objective}</${Badge}>
        ${c.proposal?.simulated && html`<${SimTag} />`}</div>
      <${Link} href=${`/campaigns/${c.id}`} class="cp-strip-link"><h3 class="ellipsis">${c.name}</h3></${Link}>
      <div class="row gap-6 wrap"><${Channels} list=${c.channels} />
        <span class="cp-when"><${Icon} name="calendar" size="13" />${dateRange(c.start_date, c.end_date)}</span>
        ${left && html`<span class="cp-when">${left}</span>`}</div>
    </div>
    <${BudgetMeter} spent=${c.spent} total=${c.budget_total} cap=${c.daily_budget_cap} compact ended=${c.status === 'completed'} />
    ${launched ? html`<${Results} c=${c} />` : html`<${Waiting} c=${c} />`}
    <div class="cp-strip-actions"><${StatusActions} c=${c} onDone=${onChanged} />
      <span class="cp-go" aria-hidden="true"><${Icon} name="chevronLeft" size="18" /></span></div>
  </article>`;
}

export function StripsSkeleton() {
  return html`<div class="card pad cp-overview">${[0, 1, 2, 3].map((i) => html`<${Skeleton} key=${i} lines=${2} h=${18} />`)}</div>
    <div class="cp-strips mt-16">${[0, 1, 2].map((i) => html`<div class="cp-strip cp-ghost" key=${i}><${Skeleton} lines=${3} h=${16} />
      <${Skeleton} lines=${2} h=${14} /><${Skeleton} lines=${2} h=${20} /></div>`)}</div>`;
}

export function CampaignsTab({ rows, proposals, status, onStatus, onChanged, onPropose, onManual, onProposals }) {
  const list = rows.filter((c) => LIVE_STATUSES.includes(c.status));
  const count = (s) => list.filter((c) => c.status === s).length;
  const shown = (status ? list.filter((c) => c.status === status) : list)
    .slice().sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const options = [{ value: '', label: `الكل ${list.length}` },
    ...LIVE_STATUSES.map((s) => ({ value: s, label: `${F.label(F.CAMPAIGN_STATUS, s)} ${count(s)}` }))];
  return html`
    <${Overview} rows=${list} proposals=${proposals} />
    ${proposals > 0 && html`<div class="notice warn mt-16 cp-nudge"><${Icon} name="lightbulb" size="18" />
      <div class="grow"><b>${countText(proposals, 'مقترح واحد', 'مقترحان', 'مقترحات', 'مقترحًا')} من مدير الحملات بانتظار قرارك</b>
        راجع السبب والميزانية والمؤشرات، ثم اعتمد ما يناسبك.</div>
      <${Button} size="sm" iconEnd="arrowLeft" onClick=${onProposals}>راجع المقترحات</${Button}></div>`}
    ${list.length ? html`
      <div class="cp-toolbar"><${Seg} size="sm" label="تصفية حسب الحالة" options=${options} value=${status || ''} onChange=${onStatus} /></div>
      ${shown.length ? html`<div class="cp-strips">${shown.map((c) => html`<${Strip} key=${c.id} c=${c} onChanged=${onChanged} />`)}</div>`
        : html`<div class="card"><${Empty} icon="filter" title="لا توجد حملات بهذه الحالة" text="اختر حالة أخرى من الأعلى أو اعرض كل الحملات." /></div>`}`
      : html`<div class="card mt-16"><${Empty} icon="megaphone" title="لا توجد حملات جارية بعد"
          text="اطلب من مدير الحملات اقتراح حملة مبنية على أدائك ومنافسيك والمواسم القادمة، أو أنشئ حملة يدوية بميزانيتك وقنواتك."
          action=${html`<div class="row wrap gap-6 cp-center">
            ${can('proposals') && html`<${Button} variant="primary" icon="wand" onClick=${onPropose}>اقترح حملة</${Button}>`}
            ${can('campaigns') && html`<${Button} icon="plus" onClick=${onManual}>حملة يدوية</${Button}>`}</div>`} /></div>`}`;
}
