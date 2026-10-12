// القنوات: one page per channel. Its agent, connection, today's room, KPIs, the 14-day trend, what the agent
// learned, the queue and what was published recently.
import { html, cls, useState, useEffect, useRef, useCallback } from '../lib/h.js';
import { api, useApi } from '../lib/api.js';
import { useLive } from '../lib/live.js';
import { Link } from '../lib/router.js';
import { can } from '../lib/store.js';
import * as F from '../lib/format.js';
import {
  Icon, Button, Badge, StatusBadge, SimTag, Card, Empty, Skeleton, Loader, Stat, Meter, Seg, ChannelMark, Spark, Bars, useDebounced } from '../ui/core.js';
import { toast } from '../ui/overlays.js';

export const title = (params) => F.CHANNEL_LABEL[params?.ch] || 'القنوات';

const RUNS = [
  { kind: 'channel.analyze', label: 'حلّل الآن', icon: 'brain', ok: 'بدأ الوكيل تحليل أداء القناة' },
  { kind: 'channel.engage', label: 'اجلب الرسائل', icon: 'inbox', ok: 'بدأ الوكيل جلب التعليقات والرسائل الجديدة' },
  { kind: 'channel.metrics', label: 'حدّث المؤشرات', icon: 'refresh', ok: 'بدأ الوكيل تحديث المؤشرات والمتابعين' },
  { kind: 'channel.publish', label: 'انشر المستحق', icon: 'send', ok: 'بدأ الوكيل نشر ما حان موعده' },
];
const CONN_STATUS = {
  connected: ['متصل', 'ok'], error: ['انقطع الربط', 'bad'], paused: ['الربط موقوف', ''], not_configured: ['غير مهيأ', 'warn'],
};
const METRICS = [
  { value: 'reach', label: 'الوصول' },
  { value: 'engagement', label: 'التفاعل' },
];
const RELOAD_MS = 1200;

/** 20 → «8 م», 9 → «9 ص», 0 → «12 ص» (Riyadh hours from the agent). */
export function hourLabel(h) {
  const n = ((+h % 24) + 24) % 24;
  return `${n % 12 || 12} ${n < 12 ? 'ص' : 'م'}`;
}

const clip = (s, n) => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const titleOf = (p) => p.title || clip(p.caption, 80) || 'منشور بدون عنوان';


// ---------------------------------------------------------------- switcher & hero

function Switcher({ current }) {
  return html`<nav class="chp-switch" aria-label="القنوات">${F.CHANNELS.map((c) => html`
    <${Link} key=${c} href=${`/channels/${c}`} class=${cls('chp-tab', `chp-c-${c}`, c === current && 'on')}
      aria-current=${c === current ? 'page' : undefined}>
      <${ChannelMark} ch=${c} size="sm" /><span>${F.CHANNEL_LABEL[c]}</span></${Link}>`)}</nav>`;
}

function Connection({ conn }) {
  const acct = conn.account || {};
  const sandbox = conn.mode !== 'live';
  return html`<div class="chp-fact">
    <span class="chp-k">الربط بالحساب</span>
    <div class="row wrap gap-6">
      ${sandbox ? html`<${SimTag} title="القناة تعمل على بيانات محاكاة حتى تربط حسابك الحقيقي" />`
        : html`<${StatusBadge} map=${CONN_STATUS} value=${conn.status} />`}
      ${acct.handle && html`<span class="small ltr chp-handle">${acct.handle}</span>`}
    </div>
    ${acct.followers != null && !sandbox && html`<span class="tiny faint">${F.compact(acct.followers)} متابع على الحساب</span>`}
    ${sandbox && (can('connections')
      ? html`<${Link} href="/settings/connections" class="small strong row gap-6"><${Icon} name="plug" size="14" />اربط الحساب</${Link}>`
      : html`<span class="tiny faint">يربط الحساب من يملك صلاحية «الربط والمفاتيح»</span>`)}
    ${!sandbox && conn.status === 'error' && can('connections') && html`<${Link} href="/settings/connections" class="small strong">أعد الربط</${Link}>`}
  </div>`;
}

function Room({ room }) {
  const full = room.limit > 0 && room.used >= room.limit;
  return html`<div class="chp-fact">
    <div class="row between"><span class="chp-k">سعة النشر اليوم</span><span class="num small">${F.num(room.used)}/${F.num(room.limit)}</span></div>
    <${Meter} value=${room.used} max=${room.limit || 1} tone=${full ? 'ok' : ''} />
    <span class="tiny faint">${room.limit ? (full ? 'اكتملت منشورات اليوم العضوية' : `يتبقى ${F.num(room.limit - room.used)} منشور عضوي اليوم`) : 'النشر العضوي موقوف لهذه القناة'}</span>
    <${Link} href="/campaigns?tab=limits" class="tiny">إدارة الليمت</${Link}>
  </div>`;
}

function Hero({ d, ch, onRan }) {
  const a = d.agent;
  const [busy, setBusy] = useState('');
  const run = async (r) => {
    if (busy) return;
    setBusy(r.kind);
    try { await api.post(`/agents/${ch}/run`, { kind: r.kind }); toast(r.ok); onRan?.(); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  return html`<section class=${cls('chp-hero', `chp-c-${ch}`)}>
    <div class="chp-id">
      <span class="chp-bigmark"><${ChannelMark} ch=${ch} size="lg" /></span>
      <div class="grow">
        <h2>${a.name}</h2>
        <p class="muted small">${a.title}</p>
        <div class="row wrap gap-6 mt-8">
          <${StatusBadge} map=${F.AGENT_STATUS} value=${a.paused ? 'paused' : a.status} />
          <${Badge} tone="outline" icon="cpu">${a.model_label}</${Badge}>
          ${!a.enabled && html`<${Badge} tone="bad">الوكيل معطّل</${Badge}>`}
        </div>
        ${a.status_note && html`<p class="small faint mt-8 clamp-2">${a.status_note}</p>`}
      </div>
    </div>
    <div class="chp-facts"><${Connection} conn=${d.connection} /><${Room} room=${d.room} /></div>
    ${can('command') && html`<div class="chp-actions">${RUNS.map((r) => html`<${Button} key=${r.kind} size="sm" icon=${r.icon}
      variant=${r.kind === 'channel.analyze' ? 'primary' : ''} loading=${busy === r.kind} disabled=${!!busy}
      onClick=${() => run(r)}>${r.label}</${Button}>`)}</div>`}
  </section>`;
}

// ---------------------------------------------------------------- KPIs

function Kpis({ d, ch }) {
  const w = d.week;
  const m = d.month;
  const days = Object.entries(d.followers_history || {}).sort(([x], [y]) => x.localeCompare(y));
  const hist = days.map(([, v]) => +v || 0);
  const delta = hist.length > 1 ? hist[hist.length - 1] - hist[0] : null;
  return html`<section class="card chp-kpis">
    <div class="chp-kpi chp-followers">
      <${Stat} label="المتابعون" icon="users" value=${F.compact(w.followers)} delta=${delta || null}
        hint=${hist.length > 1 ? `التغير منذ ${F.date(`${days[0][0]}T12:00:00`)}` : 'حدّث المؤشرات لبدء سجل المتابعين'} />
      ${hist.length > 1 && html`<${Spark} values=${hist} width=${112} height=${40} color=${`var(--c-${ch})`} />`}
    </div>
    <div class="chp-kpi"><${Stat} label="منشورات الأسبوع" icon="send" value=${F.num(w.posts)} hint="آخر 7 أيام" /></div>
    <div class="chp-kpi"><${Stat} label="الوصول" icon="eye" value=${F.compact(w.reach)} hint="آخر 7 أيام" /></div>
    <div class="chp-kpi"><${Stat} label="معدل التفاعل" icon="heart" value=${`${w.engagement_rate}٪`} hint=${`${F.compact(w.engagement)} تفاعل هذا الأسبوع`} /></div>
    <div class="chp-kpi"><${Stat} label="تفاعل الشهر" icon="activity" value=${F.compact(m.engagement)} hint=${`${F.num(m.posts)} منشور خلال 30 يومًا`} /></div>
    <${Link} href=${`/inbox?channel=${ch}`} class="chp-kpi chp-kpi-link">
      <${Stat} label="محادثات مفتوحة" icon="message" value=${F.num(d.open_conversations)} hint="افتح صندوق التفاعل" /></${Link}>
    ${ch === 'whatsapp' && html`<div class="chp-kpi"><${Stat} label="المشتركون الموافقون" icon="checkCircle" value=${F.num(d.subscribers)} hint="وافقوا على الرسائل التسويقية" /></div>`}
  </section>
  ${ch === 'whatsapp' && html`<div class="notice ok chp-consent"><${Icon} name="lock" size="18" />
    <div class="grow"><b>واتساب بموافقة مسبقة فقط</b>
      لا يرسل الوكيل أي رسالة تسويقية لمن لم يوافق صراحة. الرسائل الجماعية تخرج بين 9 ص و10 م فقط، وبعد مرور 24 ساعة على آخر رسالة من العميل لا يُرسل إلا قالب معتمد من واتساب.
      <${Link} href="/inbox?channel=whatsapp" class="strong chp-consent-link">راجع موافقات العملاء</${Link}></div></div>`}`;
}

// ---------------------------------------------------------------- trend & learning

function Trend({ series, ch }) {
  const [metric, setMetric] = useState('reach');
  const data = (series || []).map((p) => ({
    label: F.date(`${p.day}T12:00:00`), value: +p[metric] || 0, short: String(+p.day.slice(8, 10)),
  }));
  const total = data.reduce((sum, x) => sum + x.value, 0);
  const posts = (series || []).reduce((sum, x) => sum + (x.posts || 0), 0);
  return html`<${Card} title="آخر 14 يومًا" icon="chart"
    actions=${html`<${Seg} size="sm" label="المؤشر" value=${metric} onChange=${setMetric} options=${METRICS} />`}>
    <div class="row between wrap"><span class="small muted">${metric === 'reach' ? 'إجمالي الوصول' : 'إجمالي التفاعل'} من ${F.num(posts)} منشور</span>
      <b class="num chp-total">${F.compact(total)}</b></div>
    ${total ? html`<div class="chp-bars mt-12"><${Bars} data=${data} height=${160} color=${`var(--c-${ch})`} /></div>`
      : html`<${Empty} icon="chart" title="لا أرقام بعد في هذه الفترة" text="تظهر الأعمدة هنا بعد أول منشور على القناة، وتتحدث كلما جلب الوكيل المؤشرات." />`}
  </${Card}>`;
}

function Chips({ items, empty, render }) {
  return items?.length ? html`<div class="row wrap gap-6 mt-8">${items.map(render)}</div>` : html`<p class="small faint mt-8">${empty}</p>`;
}

function Ideas({ ideas, ch }) {
  const [busy, setBusy] = useState(-1);
  const [sent, setSent] = useState(() => new Set());
  const toPost = async (idea, i) => {
    setBusy(i);
    try {
      await api.post('/posts/generate', { channel: ch, brief: idea, count: 1 });
      setSent((s) => new Set([...s, i]));
      toast('بدأ صانع المحتوى كتابة المنشور، وستجده في المحتوى بانتظار مراجعتك');
    } catch (e) { toast.error(e); } finally { setBusy(-1); }
  };
  if (!ideas?.length) return html`<p class="small faint mt-8">لا أفكار مقترحة في آخر تحليل.</p>`;
  return html`<div class="chp-ideas mt-8">${ideas.map((idea, i) => html`<div class="chp-idea" key=${i}>
    <${Icon} name="sparkles" size="15" class="chp-idea-ico" /><p class="grow small">${idea}</p>
    ${can('command') && (sent.has(i) ? html`<${Badge} tone="ok" icon="check">قيد الكتابة</${Badge}>`
      : html`<${Button} size="xs" icon="wand" loading=${busy === i} disabled=${busy !== -1} onClick=${() => toPost(idea, i)}>حوّلها لمنشور</${Button}>`)}
  </div>`)}</div>`;
}

function Learned({ agent, ch }) {
  const ins = agent.insights || {};
  if (!ins.analyzed_at) {
    return html`<${Card} title="ما تعلّمه الوكيل" icon="lightbulb"><${Empty} icon="lightbulb" title="لم يحلل الوكيل القناة بعد"
      text="اضغط «حلّل الآن» في الأعلى ليقرأ الوكيل أداء آخر 3 أسابيع ويستخرج أفضل الأوقات والصيغ وأفكارًا جاهزة للنشر." /></${Card}>`;
  }
  return html`<${Card} title="ما تعلّمه الوكيل" icon="lightbulb"
    actions=${html`<span class="row gap-6">${ins.simulated && html`<${SimTag} />`}<span class="tiny faint" title=${F.dateTime(ins.analyzed_at)}>${F.ago(ins.analyzed_at)}</span></span>`}>
    ${ins.summary && html`<p class="chp-summary">${ins.summary}</p>`}
    <div class="chp-learn-grid mt-16">
      <div><span class="label">أفضل أوقات النشر</span>
        <${Chips} items=${ins.best_hours} empty="لم تتضح بعد" render=${(h) => html`<span class="chp-pill" key=${h}><${Icon} name="clock" size="13" />${hourLabel(h)}</span>`} /></div>
      <div><span class="label">أفضل الصيغ</span>
        <${Chips} items=${ins.best_formats} empty="لم تتضح بعد" render=${(f) => html`<span class="chp-pill" key=${f}><${Icon} name="layers" size="13" />${F.formatLabel(f)}</span>`} /></div>
    </div>
    ${ins.recommendations?.length > 0 && html`<span class="label chp-sub">توصيات</span>
      <ul class="chp-recs">${ins.recommendations.map((r, i) => html`<li key=${i}><${Icon} name="check" size="14" /><span>${r}</span></li>`)}</ul>`}
    <span class="label chp-sub">أفكار محتوى</span>
    <${Ideas} ideas=${ins.ideas} ch=${ch} />
  </${Card}>`;
}

// ---------------------------------------------------------------- lists

function Queue({ posts }) {
  return html`<${Card} title="في الطابور" icon="calendar" actions=${html`<${Link} href="/content" class="small">كل المحتوى</${Link}>`}>
    ${posts.length ? html`<div class="list">${posts.map((p) => html`<${Link} key=${p.id} href=${`/content?post=${p.id}`} class="item click chp-row">
      <${StatusBadge} map=${F.POST_STATUS} value=${p.status} />
      <div class="grow"><b class="small ellipsis chp-line">${titleOf(p)}</b>
        <span class="tiny faint">${F.formatLabel(p.format)} · ${p.scheduled_human || 'بلا موعد بعد'}</span></div>
      <${Icon} name="chevronLeft" size="16" class="faint" /></${Link}>`)}</div>`
      : html`<${Empty} icon="calendar" title="الطابور فارغ" text="المنشورات التي تنتظر اعتمادك أو المجدولة لهذه القناة تظهر هنا. اطلب محتوى جديدًا من صفحة المحتوى أو حوّل فكرة مقترحة لمنشور." />`}
  </${Card}>`;
}

function Metric({ icon, label, value }) {
  return html`<span title=${label}><${Icon} name=${icon} size="13" />${F.compact(value || 0)}</span>`;
}

function Published({ posts }) {
  return html`<${Card} title="نُشر مؤخرًا" icon="checkCircle">
    ${posts.length ? html`<div class="list">${posts.map((p) => { const m = p.metrics || {}; return html`<div class="item chp-row" key=${p.id}>
      <${Link} href=${`/content?post=${p.id}`} class="grow chp-pub">
        <b class="small ellipsis chp-line">${titleOf(p)}</b>
        <span class="tiny faint">${F.formatLabel(p.format)} · ${F.ago(p.published_at)}</span>
        <div class="chp-metrics">
          <${Metric} icon="eye" label="الوصول" value=${m.reach || m.views} />
          <${Metric} icon="heart" label="الإعجابات" value=${m.likes} />
          <${Metric} icon="message" label="التعليقات" value=${m.comments} />
          <${Metric} icon="send" label="المشاركات" value=${m.shares} />
          <span class="chp-rate" title="معدل التفاعل">${p.engagement_rate}٪</span>
        </div>
      </${Link}>
      <div class="chp-pub-side">${p.sandbox && html`<${SimTag} />`}
        ${p.external_url && html`<a class="btn ghost sm icon" href=${p.external_url} target="_blank" rel="noopener noreferrer"
          aria-label="افتح المنشور على المنصة" title="افتح المنشور على المنصة"><${Icon} name="arrowUpRight" size="16" /></a>`}</div>
    </div>`; })}</div>`
      : html`<${Empty} icon="send" title="لم يُنشر شيء بعد" text="بعد أن تعتمد المحتوى ويحين موعده ينشره الوكيل ضمن الليمت، ثم تظهر أرقامه هنا." />`}
  </${Card}>`;
}

// ---------------------------------------------------------------- page

function PageSkeleton() {
  return html`<div class="chp-hero"><div class="chp-id"><${Skeleton} w="56px" h=${56} /><div class="grow"><${Skeleton} lines=${3} h=${14} /></div></div>
    <div class="chp-facts"><${Skeleton} lines=${3} h=${12} /><${Skeleton} lines=${3} h=${12} /></div></div>
    <div class="card pad chp-kpis-skel"><${Skeleton} lines=${2} h=${26} /></div>
    <div class="chp-grid"><div class="card pad"><${Skeleton} h=${180} /></div><div class="card pad"><${Skeleton} lines=${6} h=${16} /></div></div>`;
}

export default function ChannelPage({ params }) {
  const ch = params?.ch;
  const known = F.CHANNELS.includes(ch);
  const st = useApi(known ? `/channels/${ch}` : null, [ch]);
  const reload = useDebounced(() => st.reload(true), RELOAD_MS);
  useLive('task', (d) => {
    const t = d.task || {};
    if ((t.agent_id === ch || t.input?.channel === ch) && ['done', 'failed', 'waiting'].includes(d.event)) reload();
  });
  useLive('metrics', (d) => { if (!d?.channel || d.channel === ch) reload(); });
  useLive('agent', (d) => {
    if (d.id === ch) st.setData((x) => x && ({ ...x, agent: { ...x.agent, status: d.status, status_note: d.note } }));
  });
  if (!known) {
    return html`<div class="chp"><${Switcher} current=${ch} />
      <${Empty} icon="compass" title="القناة غير معروفة" text="اختر إحدى القنوات الخمس من الأعلى." /></div>`;
  }
  return html`<div class="chp">
    <${Switcher} current=${ch} />
    <${Loader} state=${st} skeleton=${html`<${PageSkeleton} />`}>${(d) => html`
      <${Hero} d=${d} ch=${ch} onRan=${reload} />
      <${Kpis} d=${d} ch=${ch} />
      <div class="chp-grid">
        <${Trend} series=${d.series} ch=${ch} />
        <${Learned} agent=${d.agent} ch=${ch} />
      </div>
      <div class="chp-grid">
        <${Queue} posts=${d.queue} />
        <${Published} posts=${d.published} />
      </div>`}</${Loader}>
  </div>`;
}
