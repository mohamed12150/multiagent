// Campaign detail (/campaigns/:id): header and actions, results, the plan, editable budget and pace, and its posts.
import { html, cls, useState, useEffect } from '../../lib/h.js';
import { api, useApi } from '../../lib/api.js';
import { useLive } from '../../lib/live.js';
import { Link } from '../../lib/router.js';
import { can } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Badge, StatusBadge, SimTag, Card, Empty, Skeleton, Loader, Stat, Meter, Field, ChannelMark, Seg, useDebounced } from '../../ui/core.js';
import { toast } from '../../ui/overlays.js';
import {
  Channels, DecisionActions, StatusActions, Label, Money, Pills, Sources, NumInput, actorLabel, dateRange, daysText, durationOf, isDay,
  timeLeft,
} from './shared.js';
import { Goals } from './proposals.js';

function origin(c) {
  if (c.created_by === 'campaigns') return 'اقترحها مدير الحملات';
  if (c.created_by?.startsWith('user:')) return 'حملة يدوية';
  return `أنشأها ${actorLabel(c.created_by)}`;
}

function Hero({ c, onChanged }) {
  const p = c.proposal || {};
  const left = c.status === 'active' || c.status === 'paused' ? timeLeft(c) : '';
  return html`<section class="card cp-hero">
    <div class="grow">
      <div class="row gap-6 wrap"><${StatusBadge} map=${F.CAMPAIGN_STATUS} value=${c.status} />
        <${Badge} tone="outline" icon="target">${F.OBJECTIVE[c.objective] || c.objective}</${Badge}>${p.simulated && html`<${SimTag} />`}</div>
      <h2 class="cp-hero-name">${c.name}</h2>
      <div class="cp-hero-meta">
        <${Channels} list=${c.channels} labels />
        <span class="cp-when"><${Icon} name="calendar" size="14" />${dateRange(c.start_date, c.end_date)}</span>
        ${left && html`<span class="cp-when"><${Icon} name="clock" size="14" />${left}</span>`}
        <span class="cp-when"><${Icon} name="user" size="14" />${origin(c)}${c.approved_by ? ` · اعتمدها ${actorLabel(c.approved_by)}` : ''}</span>
      </div>
    </div>
    <div class="cp-hero-acts">${c.status === 'proposed' ? html`<${DecisionActions} c=${c} onDone=${onChanged} />`
      : html`<${StatusActions} c=${c} onDone=${onChanged} size="" />`}</div>
  </section>`;
}

function Results({ c }) {
  const r = c.results || {};
  const k = c.kpis || {};
  const days = durationOf(c);
  return html`<div class="card pad cp-stats">
    <${Stat} label="منشورات منشورة" icon="send" value=${F.num(r.posts)} hint=${`الإيقاع ${F.num(c.posts_per_day)} يوميًا`} />
    <${Stat} label="الوصول" icon="eye" value=${F.compact(r.reach)} hint=${k.reach ? `المستهدف ${F.compact(k.reach)}` : 'بلا مستهدف محدد'} />
    <${Stat} label="التفاعل" icon="heart" value=${F.compact(r.engagement)} hint="إعجاب وتعليق ومشاركة وحفظ" />
    <${Stat} label="معدل التفاعل" icon="activity" value=${`${F.dec(r.engagement_rate || 0, 1)}٪`}
      hint=${k.engagement_rate ? `المستهدف ${F.dec(k.engagement_rate, 1)}٪` : 'بلا مستهدف محدد'} />
    <div class="stat"><span class="k row gap-6"><${Icon} name="wallet" size="14" />المصروف</span><span class="v"><${Money} v=${c.spent} /></span>
      <${Meter} value=${c.spent} max=${c.budget_total || 1} /><span class="tiny faint">${c.budget_total ? `من ${F.money(c.budget_total)}` : 'بلا ميزانية كلية'}</span></div>
    <${Stat} label="أيام التشغيل" icon="clock" value=${F.num(r.days_running)} hint=${days ? `من ${daysText(days)}` : 'مدة مفتوحة'} />
  </div>`;
}

const pick = (c) => ({ budget_total: c.budget_total || 0, daily_budget_cap: c.daily_budget_cap || 0, posts_per_day: c.posts_per_day || 1,
  end_date: c.end_date || '' });

function Pace({ c, cap, onSaved }) {
  const [f, setF] = useState(() => pick(c));
  const [busy, setBusy] = useState(false);
  const serverKey = JSON.stringify(pick(c));
  useEffect(() => setF(pick(c)), [serverKey]);
  const editable = can('manager') && !['completed', 'rejected'].includes(c.status);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const errors = {};
  if (typeof cap === 'number' && f.daily_budget_cap > cap) errors.daily = `يتجاوز سقف الصرف اليومي العام (${F.money(cap)})`;
  if (f.budget_total && f.budget_total < c.spent) errors.budget = `أقل مما صُرف فعلًا (${F.money(c.spent)})`;
  if (f.end_date && isDay(c.start_date) && f.end_date < c.start_date) errors.end = 'قبل تاريخ بدء الحملة';
  const changed = Object.keys(f).filter((k) => f[k] !== pick(c)[k]);
  const save = async () => {
    setBusy(true);
    try {
      const out = await api.patch(`/campaigns/${c.id}`, Object.fromEntries(changed.map((k) => [k, f[k]])));
      toast('حُفظت ميزانية الحملة وإيقاعها', 'ok', c.name);
      onSaved(out);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const room = c.results?.room_today;
  return html`<${Card} title="الميزانية والإيقاع" icon="sliders">
    ${editable ? html`<div class="col gap-16">
      <div class="grid grid-2">
        <${Field} label="الميزانية الكلية" error=${errors.budget}><${NumInput} value=${f.budget_total} min=${0} step=${50} suffix="ر.س" label="الميزانية الكلية" onChange=${set('budget_total')} /></${Field}>
        <${Field} label="السقف اليومي" error=${errors.daily} help=${typeof cap === 'number' ? `الحد العام ${F.money(cap)}` : ''}>
          <${NumInput} value=${f.daily_budget_cap} min=${0} step=${10} suffix="ر.س" label="السقف اليومي" onChange=${set('daily_budget_cap')} /></${Field}>
        <${Field} label="منشورات يوميًا"><${NumInput} value=${f.posts_per_day} min=${1} max=${50} suffix="يوميًا" label="منشورات يوميًا" onChange=${set('posts_per_day')} /></${Field}>
        <${Field} label="تاريخ الانتهاء" error=${errors.end}><input class="input ltr" type="date" value=${f.end_date} min=${c.start_date || undefined}
          onInput=${(e) => { const v = e.currentTarget.value; setF((x) => ({ ...x, end_date: v })); }} /></${Field}>
      </div>
      <div class="row wrap gap-6"><${Button} variant="primary" size="sm" icon="check" loading=${busy} disabled=${!changed.length || Object.keys(errors).length > 0}
        onClick=${save}>احفظ التعديلات</${Button}>${changed.length > 0 && html`<${Button} variant="ghost" size="sm" onClick=${() => setF(pick(c))}>تراجع</${Button}>`}</div>
    </div>` : html`<dl class="kv">
      <dt>الميزانية الكلية</dt><dd>${c.budget_total ? html`<${Money} v=${c.budget_total} />` : 'غير محددة'}</dd>
      <dt>السقف اليومي</dt><dd>${c.daily_budget_cap ? html`<${Money} v=${c.daily_budget_cap} />` : 'غير محدد'}</dd>
      <dt>منشورات يوميًا</dt><dd class="num">${F.num(c.posts_per_day)}</dd>
      <dt>ينتهي</dt><dd>${isDay(c.end_date) ? dateRange('', c.end_date) : 'بلا تاريخ انتهاء'}</dd></dl>`}
    ${typeof room === 'number' && c.status === 'active' && html`<p class="tiny faint mt-12">سعة النشر المتبقية للحملة اليوم: ${F.num(room)}</p>`}
  </${Card}>`;
}

function Plan({ c }) {
  const p = c.proposal || {};
  const hasGoals = Object.values(c.kpis || {}).some((v) => v);
  return html`<${Card} title="خطة الحملة" icon="target"><div class="col gap-16">
    ${p.rationale && html`<div class="cp-why"><${Label} icon="lightbulb">لماذا هذه الحملة</${Label}><p>${p.rationale}</p></div>`}
    <div><${Label} icon="users">الجمهور</${Label}><p class="small">${c.audience || 'لم يُحدد'}</p></div>
    <div><${Label} icon="star">العرض</${Label}><p class="small">${c.offer || 'لم يُحدد'}</p></div>
    ${p.content_pillars?.length > 0 && html`<div><${Label} icon="layers">محاور المحتوى</${Label}><${Pills} items=${p.content_pillars} /></div>`}
    ${hasGoals && html`<div><${Label} icon="trend">المحقق من المستهدف</${Label}><${Goals} kpis=${c.kpis} results=${c.results} /></div>`}
    ${p.expected && html`<div class="cp-note ok"><${Label} icon="checkCircle">النتيجة المتوقعة</${Label}><p>${p.expected}</p></div>`}
    ${p.risks && html`<div class="cp-note warn"><${Label} icon="alert">المخاطر</${Label}><p>${p.risks}</p></div>`}
    ${(p.sources || []).length > 0 && html`<div><${Label} icon="globe">مصادر اعتمد عليها</${Label}><${Sources} items=${p.sources} /></div>`}
  </div></${Card}>`;
}

const POST_FILTERS = {
  all: () => true,
  published: (p) => p.status === 'published',
  scheduled: (p) => p.status === 'scheduled' || p.status === 'publishing',
  pipeline: (p) => !['published', 'scheduled', 'publishing'].includes(p.status),
};

function PostRow({ p }) {
  const when = p.published_at ? `نُشر ${F.dateTime(p.published_at)}` : p.scheduled_at ? `مجدول ${F.dateTime(p.scheduled_at)}` : `أُنشئ ${F.ago(p.created_at)}`;
  return html`<${Link} href=${`/content?post=${encodeURIComponent(p.id)}`} class="cp-post">
    <${ChannelMark} ch=${p.channel} />
    <div class="grow">
      <div class="row gap-6 wrap"><${StatusBadge} map=${F.POST_STATUS} value=${p.status} />${p.sandbox && html`<${SimTag} />`}
        <span class="tiny faint">${p.format ? `${F.formatLabel(p.format)} · ` : ''}${when}</span></div>
      <p class="small strong clamp-2 mt-4">${p.title || p.caption || p.brief || 'منشور بلا عنوان'}</p>
      ${p.title && p.caption && html`<p class="tiny muted ellipsis">${p.caption}</p>`}
    </div>
    ${p.status === 'published' && html`<div class="cp-post-m"><span title="التفاعل"><${Icon} name="heart" size="13" />${F.compact(p.engagement)}</span>
      <span title="الوصول"><${Icon} name="eye" size="13" />${F.compact(p.metrics?.reach)}</span></div>`}
  </${Link}>`;
}

function Posts({ posts }) {
  const [filter, setFilter] = useState('all');
  const n = (k) => posts.filter(POST_FILTERS[k]).length;
  const shown = posts.filter(POST_FILTERS[filter]);
  return html`<${Card} title="منشورات الحملة" icon="kanban" class="cp-posts-card" actions=${posts.length > 0 && html`<${Seg} size="sm" label="تصفية المنشورات" value=${filter} onChange=${setFilter}
      options=${[{ value: 'all', label: `الكل ${n('all')}` }, { value: 'published', label: `منشورة ${n('published')}` },
        { value: 'scheduled', label: `مجدولة ${n('scheduled')}` }, { value: 'pipeline', label: `قيد الإعداد ${n('pipeline')}` }]} />`}>
    ${!posts.length ? html`<${Empty} icon="kanban" title="لا منشورات لهذه الحملة بعد"
        text="عند إطلاق الحملة يجهّز صانع المحتوى منشورات الانطلاق تلقائيًا، ثم يحدد المنسّق مواعيد نشرها ضمن الليمت." />`
      : shown.length ? html`<div class="cp-posts">${shown.map((p) => html`<${PostRow} key=${p.id} p=${p} />`)}</div>`
        : html`<p class="muted small cp-gap">لا منشورات في هذا التصنيف.</p>`}
  </${Card}>`;
}

function DetailSkeleton() {
  return html`<div class="card pad"><${Skeleton} lines=${3} h=${20} /></div>
    <div class="card pad cp-stats mt-16">${[0, 1, 2, 3, 4, 5].map((i) => html`<${Skeleton} key=${i} lines=${2} h=${18} />`)}</div>
    <div class="cp-detail"><div class="card pad"><${Skeleton} lines=${5} h=${40} /></div><div class="card pad"><${Skeleton} lines=${6} h=${18} /></div></div>`;
}

export function CampaignDetail({ id }) {
  const st = useApi(`/campaigns/${encodeURIComponent(id)}`, [id]);
  const lim = useApi(can('manager') ? '/limits' : null);
  const reload = useDebounced(() => st.reload(true), 800);
  useLive('task', (d) => {
    const t = d.task || {};
    if (d.event !== 'done' && d.event !== 'failed') return;
    if (t.input?.campaign_id === id || /^(campaigns|coordinator|channel)\./.test(t.kind || '')) reload();
  });
  useLive('metrics', reload);
  useLive('approvals', reload);
  const merge = (out) => { st.setData((c) => (c ? { ...c, ...out, results: c.results, posts: c.posts } : c)); reload(); };

  return html`<${Link} href="/campaigns" class="cp-back"><${Icon} name="arrowRight" size="16" />كل الحملات</${Link}>
    <${Loader} state=${st} skeleton=${html`<${DetailSkeleton} />`}>${(c) => {
      const launched = c.results && c.results.days_running !== undefined && c.status !== 'proposed' && c.status !== 'approved';
      return html`
        <${Hero} c=${c} onChanged=${merge} />
        ${launched ? html`<${Results} c=${c} />` : html`<div class=${cls('notice mt-16', c.status === 'rejected' && 'bad')}><${Icon} name=${c.status === 'rejected' ? 'xCircle' : 'rocket'} size="18" />
          <div class="grow">${c.status === 'proposed' ? 'مقترح بانتظار قرارك. راجع الخطة والميزانية ثم اعتمده ليبدأ التنفيذ.'
            : c.status === 'rejected' ? 'رُفض هذا المقترح ولن يُنفّذ.'
              : 'الحملة معتمدة ولم تنطلق بعد. تظهر النتائج هنا بعد نشر أول منشور.'}</div></div>`}
        <div class="cp-detail">
          <div class="cp-detail-col"><${Posts} posts=${c.posts || []} /></div>
          <div class="cp-detail-col"><${Pace} c=${c} cap=${lim.data?.limits?.daily_ad_spend_cap} onSaved=${merge} /><${Plan} c=${c} /></div>
        </div>`;
    }}</${Loader}>`;
}
