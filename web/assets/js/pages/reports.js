// التقارير: the coordinator's daily reports as a timeline (/reports) and one report in full (/reports/:id).
import { html, cls, useState } from '../lib/h.js';
import { api, useApi } from '../lib/api.js';
import { useLive } from '../lib/live.js';
import { Link } from '../lib/router.js';
import { can } from '../lib/store.js';
import * as F from '../lib/format.js';
import { Icon, Button, SimTag, Empty, Skeleton, Loader, Bars, Stat, useDebounced } from '../ui/core.js';
import { toast } from '../ui/overlays.js';
import { ReportDetail } from './reports/detail.js';
import { DeliveryChips, dayParts, latestPerDay, todayIso, yesterdayIso } from './reports/parts.js';

const ENDED = new Set(['done', 'failed', 'waiting']);

export function title(params) {
  return params?.id ? 'التقرير' : 'التقارير';
}

function Trend({ rows }) {
  const days = latestPerDay(rows);
  if (days.length < 2) return null;
  const week = days.slice(0, 7);
  const sum = (k) => week.reduce((a, r) => a + (+r.totals?.[k] || 0), 0);
  const series = days.slice(0, 14).reverse();
  const span = `آخر ${week.length === 2 ? 'يومين' : `${F.num(week.length)} أيام`}`;
  return html`<div class="card pad rp-trend">
    <${Stat} label="المنشورات" icon="send" value=${F.num(sum('posts'))} hint=${span} />
    <${Stat} label="الوصول" icon="eye" value=${F.compact(sum('reach'))} hint=${span} />
    <${Stat} label="التفاعل" icon="heart" value=${F.compact(sum('engagement'))} hint=${span} />
    <div class="rp-trend-chart"><div class="row between tiny faint"><span>التفاعل اليومي</span><span>${dayParts(series[0].day).d} ${dayParts(series[0].day).month}
      إلى ${dayParts(series[series.length - 1].day).d} ${dayParts(series[series.length - 1].day).month}</span></div>
      <${Bars} height=${76} data=${series.map((r) => ({ label: `${dayParts(r.day).d} ${dayParts(r.day).month}`, value: +r.totals?.engagement || 0,
        short: dayParts(r.day).d }))} /></div>
  </div>`;
}

function Item({ r, today, yesterday, older }) {
  const t = r.totals || {};
  const p = dayParts(r.day);
  const when = r.day === today ? 'اليوم' : r.day === yesterday ? 'أمس' : p.weekday;
  return html`<${Link} href=${`/reports/${encodeURIComponent(r.id)}`} class=${cls('rp-item', r.day === today && 'today')}>
    <div class="rp-date" aria-hidden="true"><b class="num">${p.d}</b><span>${p.month}</span></div>
    <div class="rp-body">
      <div class="row between gap-6 wrap"><span class="tiny faint">${when} · صدر ${F.time(r.created_at)}${r.kind && r.kind !== 'daily' ? ' · تقرير خاص' : ''}</span>
        <span class="row gap-6">${older && html`<span class="rp-older">إصدار أقدم لنفس اليوم</span>`}${r.simulated && html`<${SimTag} />`}</span></div>
      <h3 class="rp-item-head clamp-2">${r.headline || r.title}</h3>
      <div class="rp-totals"><span><${Icon} name="send" size="13" />المنشورات <b class="num">${F.num(t.posts || 0)}</b></span>
        <span><${Icon} name="eye" size="13" />الوصول <b class="num">${F.compact(t.reach)}</b></span>
        <span><${Icon} name="heart" size="13" />التفاعل <b class="num">${F.compact(t.engagement)}</b></span>
        ${t.engagement_rate ? html`<span>المعدل <b class="num">${F.dec(t.engagement_rate, 2)}٪</b></span>` : null}</div>
      <${DeliveryChips} list=${r.deliveries} />
    </div>
    <span class="rp-go" aria-hidden="true"><${Icon} name="chevronLeft" size="18" /></span>
  </${Link}>`;
}

function Generating() {
  const p = dayParts(todayIso());
  return html`<div class="rp-item today rp-ghost" aria-live="polite">
    <div class="rp-date" aria-hidden="true"><b class="num">${p.d}</b><span>${p.month}</span></div>
    <div class="rp-body"><div class="row gap-6"><span class="status-dot working" /><b class="small">المنسّق يكتب تقرير اليوم الآن</b></div>
      <p class="tiny faint">يجمع أرقام الوكلاء والقنوات بدقة، وسيظهر التقرير هنا فور اكتماله.</p><${Skeleton} lines=${2} h=${12} /></div>
  </div>`;
}

function Timeline({ rows, generating }) {
  const today = todayIso();
  const yesterday = yesterdayIso();
  const out = [];
  const seen = new Set();
  let month = '';
  rows.forEach((r) => {
    const m = dayParts(r.day).monthYear;
    if (m !== month) { month = m; out.push(html`<h3 class="rp-month" key=${`m-${m}`}>${m}</h3>`); }
    out.push(html`<${Item} key=${r.id} r=${r} today=${today} yesterday=${yesterday} older=${seen.has(r.day)} />`);
    seen.add(r.day);
  });
  return html`<div class="rp-timeline">${generating && html`<${Generating} />`}${out}</div>`;
}

function ListSkeleton() {
  return html`<div class="card pad rp-trend">${[0, 1, 2].map((i) => html`<${Skeleton} key=${i} lines=${2} h=${18} />`)}<${Skeleton} h=${76} /></div>
    <div class="rp-timeline">${[0, 1, 2, 3].map((i) => html`<div class="rp-item rp-ghost" key=${i}><div class="rp-date"><${Skeleton} w="28px" h=${22} /></div>
      <div class="rp-body"><${Skeleton} lines=${3} h=${14} /></div></div>`)}</div>`;
}

function ReportsList() {
  const st = useApi('/reports?limit=90');
  const [generating, setGenerating] = useState(null);
  const [busy, setBusy] = useState(false);
  const reload = useDebounced(() => st.reload(true), 600);

  useLive('task', (d) => {
    const t = d.task || {};
    if (t.kind !== 'coordinator.daily_report') return;
    if (d.event === 'created' || d.event === 'started' || d.event === 'retry') { if (!generating) setGenerating(t.id); return; }
    if (!ENDED.has(d.event)) return;
    if (t.id === generating) {
      setGenerating(null);
      if (d.event === 'failed') toast(t.error || 'تعذر إصدار التقرير، حاول مجددًا', 'bad', 'المنسّق');
    }
    reload();
  });

  const generate = async () => {
    setBusy(true);
    try {
      const t = await api.post('/reports/generate');
      setGenerating(t.id);
      toast('بدأ المنسّق كتابة تقرير اليوم، وسيظهر هنا خلال لحظات');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  return html`
    <div class="page-head rp-head">
      <div class="grow"><h2>تقارير المنسّق اليومية</h2>
        <p>يكتب المنسّق كل مساء تقريرًا بالأرقام الدقيقة ويرسله لك على واتساب والبريد. افتح أي يوم لتقرأه كاملًا.</p></div>
      ${can('editor') && html`<${Button} variant="primary" icon="file" loading=${busy} disabled=${!!generating} onClick=${generate}>أصدر تقرير اليوم الآن</${Button}>`}
    </div>
    <${Loader} state=${st} skeleton=${html`<${ListSkeleton} />`}>${(rows) => (rows.length || generating ? html`
      <${Trend} rows=${rows} />
      <${Timeline} rows=${rows} generating=${generating} />`
      : html`<div class="card"><${Empty} icon="chart" title="لا توجد تقارير بعد"
          text="يصدر المنسّق تقرير الإنجاز كل مساء تلقائيًا ويرسله لك على واتساب والبريد. ويمكنك إصدار تقرير اليوم الآن لترى أرقامك حتى هذه اللحظة."
          action=${can('editor') && html`<${Button} variant="primary" icon="file" loading=${busy} onClick=${generate}>أصدر تقرير اليوم الآن</${Button}>`} /></div>`)}
    </${Loader}>`;
}

export default function ReportsPage({ params }) {
  if (params?.id) return html`<${ReportDetail} id=${params.id} />`;
  return html`<${ReportsList} />`;
}
