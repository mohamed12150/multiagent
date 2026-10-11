// الحارس: watches the whole system, fixes what a safe playbook can fix alone, and tells the owner about the rest.
import { html, cls, useState, useEffect, useRef, useCallback } from '../lib/h.js';
import { api, useApi } from '../lib/api.js';
import { useLive } from '../lib/live.js';
import { Link, setQuery } from '../lib/router.js';
import { can } from '../lib/store.js';
import * as F from '../lib/format.js';
import {
  Icon, Button, Badge, StatusBadge, SimTag, Card, Empty, Skeleton, Loader, Seg, Stat, AgentMark, ChannelMark, usePoll, useDebounced } from '../ui/core.js';
import { toast, confirm } from '../ui/overlays.js';

const SEVERITY = { info: ['معلومة', 'accent'], warning: ['تحذير', 'warn'], critical: ['حرج', 'bad'] };
const INC_STATUS = {
  open: ['مفتوحة', 'accent'], fixing: ['يصلحها الآن', 'live'], needs_owner: ['تحتاج تدخلك', 'bad'], failed: ['تعذر الإصلاح', 'bad'],
  fixed: ['أُصلحت', 'ok'], ignored: ['تم تجاهلها', ''],
};
const OPEN = ['open', 'needs_owner', 'failed', 'fixing'];
const STATUS_RANK = { needs_owner: 0, failed: 1, fixing: 2, open: 3 };
const SEV_RANK = { critical: 0, warning: 1, info: 2 };
const CONNECTIONS = { href: '/settings/connections', cta: 'افتح الربط' };
const OWNER_HINT = {
  connection: { text: 'رفضت المنصة الربط. أعد ربط الحساب من الإعدادات › الربط، ثم اضغط «نفّذ الإصلاح».', ...CONNECTIONS },
  token: { text: 'رمز الوصول ينتهي قريبًا ولم يتجدد تلقائيًا. أضف رمزًا جديدًا من الإعدادات › الربط.', ...CONNECTIONS },
  ai_key: { text: 'الوكلاء متوقفون عن التفكير. حدّث مفتاح Claude من الإعدادات › الربط.', href: '/settings/connections', cta: 'حدّث المفتاح' },
  ai_budget: { text: 'اكتمل سقف إنفاق الذكاء الاصطناعي اليومي. تُستأنف المهام غدًا، أو ارفع السقف من الليمت.', href: '/campaigns?tab=limits', cta: 'إدارة الليمت' },
  disk: { text: 'نظّف الحارس ما يستطيع وما زالت المساحة منخفضة. وسّع التخزين على الخادم.' },
  failed_post: { text: 'تعذر النشر لأن الربط مع القناة مرفوض. أعد الربط ثم نفّذ الإصلاح.', ...CONNECTIONS },
  report_delivery: { text: 'فشل إرسال التقرير مجددًا. راجع إعدادات واتساب والبريد للتقارير.', href: '/settings', cta: 'افتح الإعدادات' },
};
const DEFAULT_HINT = { text: 'لا يستطيع الحارس حل هذه المشكلة وحده. راجع التفاصيل، ثم نفّذ الإصلاح بعد معالجة السبب أو تجاهلها إن لم تعد مهمة.' };
const COMPONENT_ICON = { runtime: 'cpu', scheduler: 'clock', ai: 'brain', disk: 'database', tasks: 'activity' };
const AGENT_NAME = F.AGENT_NAME;
const RANGES = [{ value: '1', label: 'اليوم' }, { value: '7', label: '7 أيام' }];
const TABS = ['open', 'resolved'];
const GUARD_TASKS = ['guardian.sweep', 'guardian.apply_fix'];
const SWEEP_TIMEOUT_MS = 120000;
const USAGE_POLL_MS = 120000;
const RELOAD_MS = 900;

const at = (iso) => (iso ? new Date(iso.endsWith('Z') ? iso : `${iso}Z`).getTime() : 0);
const rank = (i) => (STATUS_RANK[i.status] ?? 4) * 3 + (SEV_RANK[i.severity] ?? 2);

function notesLabel(n) {
  if (n === 1) return 'ملاحظة واحدة تحتاج انتباهك';
  if (n === 2) return 'ملاحظتان تحتاجان انتباهك';
  if (n <= 10) return `${n} ملاحظات تحتاج انتباهك`;
  return `${n} ملاحظة تحتاج انتباهك`;
}


// ---------------------------------------------------------------- hero

function Hero({ data, openCount, needsOwner, sweeping, onSweep }) {
  const last = data.last;
  const healthy = openCount === 0;
  const tone = healthy ? 'ok' : needsOwner ? 'bad' : 'warn';
  const sub = healthy ? 'يراقب الحارس محرك المهام والمجدول والقنوات والتخزين، ويصلح ما يستطيع وحده ثم يبلغك بما فعل.'
    : needsOwner ? `${needsOwner === 1 ? 'واحدة' : F.num(needsOwner)} منها تحتاج قرارك${needsOwner < openCount ? '، والباقي يتابعه الحارس' : ''}.`
      : 'يتابعها الحارس الآن ويصلح ما تسمح به خطط الإصلاح.';
  return html`<section class=${cls('gd-hero', tone)}>
    <span class="gd-shield"><${Icon} name=${healthy ? 'shield' : 'alert'} size="30" /></span>
    <div class="grow">
      <h2>${healthy ? 'النظام سليم' : notesLabel(openCount)}</h2>
      <p class="muted mt-4">${sub}</p>
      <div class="gd-last">${last ? html`
        <span title=${F.dateTime(last.at)}><${Icon} name="clock" size="14" />آخر فحص ${F.ago(last.at)}</span>
        <span><${Icon} name="search" size="14" />${F.num(last.findings)} ملاحظة</span>
        <span><${Icon} name="wand" size="14" />أصلح ${F.num(last.fixed)}</span>` : html`<span>لم يُجرِ الحارس فحصًا شاملًا بعد</span>`}</div>
    </div>
    ${can('editor') && html`<${Button} variant="primary" icon="refresh" loading=${sweeping} onClick=${onSweep}>${sweeping ? 'يفحص الآن' : 'افحص الآن'}</${Button}>`}
  </section>`;
}

// ---------------------------------------------------------------- components

function ComponentMark({ c }) {
  const provider = c.id.startsWith('conn:') ? c.id.slice(5) : '';
  if (F.CHANNEL_LABEL[provider]) return html`<${ChannelMark} ch=${provider} size="sm" />`;
  return html`<span class="mark sm"><${Icon} name=${COMPONENT_ICON[c.id] || 'plug'} size="14" /></span>`;
}

function Components({ items }) {
  const bad = items.filter((c) => !c.ok).length;
  return html`<${Card} title="مكونات النظام" icon="server"
    actions=${bad ? html`<${Badge} tone="bad">${F.num(bad)} تحتاج متابعة</${Badge}>` : html`<${Badge} tone="ok" icon="check">كلها تعمل</${Badge}>`}>
    <div class="gd-comps">${items.map((c) => { const provider = c.id.startsWith('conn:') ? c.id.slice(5) : ''; return html`
      <div class=${cls('gd-comp', c.ok ? 'ok' : 'bad')} key=${c.id}>
        <${ComponentMark} c=${c} />
        <div class="grow">
          <div class="row between gap-6"><b class=${cls('small ellipsis', provider && !F.CHANNEL_LABEL[provider] && 'ltr')}>${F.CHANNEL_LABEL[provider] || c.label}</b>
            <span class=${cls('gd-dot', c.ok ? 'ok' : 'bad')} title=${c.ok ? 'يعمل' : 'متعطل'} /></div>
          <p class="tiny faint clamp-2">${c.detail}</p>
        </div>
      </div>`; })}</div>
  </${Card}>`;
}

// ---------------------------------------------------------------- incidents

function OwnerAction({ inc }) {
  const hint = OWNER_HINT[inc.check] || DEFAULT_HINT;
  return html`<div class="notice bad gd-owner"><${Icon} name="hand" size="18" />
    <div class="grow"><b>ما المطلوب منك</b>${hint.text}
      ${hint.href && can('manager') && html` <${Link} href=${hint.href} class="strong">${hint.cta}</${Link}>`}</div></div>`;
}

function Incident({ inc, labels, onChanged }) {
  const [busy, setBusy] = useState('');
  const open = OPEN.includes(inc.status);
  const fixLabel = inc.fix_action ? labels[inc.fix_action] || inc.fix_action : '';
  const canFix = inc.fix_action && !['fixed', 'fixing'].includes(inc.status);
  const fix = async () => {
    setBusy('fix');
    try { await api.post(`/guardian/incidents/${inc.id}/fix`); toast(`بدأ الحارس تنفيذ: ${fixLabel}`); onChanged(); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const ignore = async () => {
    const yes = await confirm({ title: 'تجاهل هذه الملاحظة؟', ok: 'تجاهلها',
      text: 'ستنتقل إلى المحلولة ولن يحاول الحارس إصلاحها. إن عاد السبب فسيفتح ملاحظة جديدة.' });
    if (!yes) return;
    setBusy('ignore');
    try { await api.post(`/guardian/incidents/${inc.id}/ignore`); toast('نُقلت الملاحظة إلى المحلولة'); onChanged(); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  return html`<article class=${cls('gd-inc', `sev-${inc.severity}`, `st-${inc.status}`)}>
    <div class="gd-inc-head">
      <${StatusBadge} map=${SEVERITY} value=${inc.severity} />
      <${StatusBadge} map=${INC_STATUS} value=${inc.status} />
      <span class="tiny faint gd-when" title=${F.dateTime(inc.created_at)}>${F.ago(inc.created_at)}</span>
    </div>
    <h3>${inc.title}</h3>
    ${inc.detail && html`<p class="small muted pre gd-detail">${inc.detail}</p>`}
    ${inc.status === 'needs_owner' && html`<${OwnerAction} inc=${inc} />`}
    ${inc.fix_detail && html`<p class="small gd-fixd"><${Icon} name="tool" size="14" /><span>${inc.fix_detail}</span></p>`}
    <div class="gd-facts">
      ${fixLabel ? html`<span><${Icon} name="wand" size="13" />خطة الإصلاح: ${fixLabel}</span>` : html`<span><${Icon} name="user" size="13" />لا توجد خطة آلية</span>`}
      ${inc.attempts > 0 && html`<span><${Icon} name="refresh" size="13" />المحاولات: <b class="num">${F.num(inc.attempts)}</b></span>`}
      <span><${Icon} name="clock" size="13" />رُصدت ${F.dateTime(inc.created_at)}</span>
      ${inc.resolved_at && html`<span><${Icon} name="checkCircle" size="13" />حُلّت ${F.dateTime(inc.resolved_at)}</span>`}
    </div>
    ${can('manager') && (canFix || (open && inc.status !== 'fixing')) && html`<div class="row wrap gap-6 mt-12">
      ${canFix && html`<${Button} size="sm" variant="primary" icon="wand" loading=${busy === 'fix'} disabled=${!!busy} onClick=${fix}>نفّذ الإصلاح</${Button}>`}
      ${open && inc.status !== 'fixing' && html`<${Button} size="sm" variant="ghost" icon="eyeOff" loading=${busy === 'ignore'} disabled=${!!busy} onClick=${ignore}>تجاهل</${Button}>`}
    </div>`}
  </article>`;
}

function Incidents({ data, tab, onChanged }) {
  const open = data.incidents.filter((i) => OPEN.includes(i.status));
  const done = data.incidents.filter((i) => !OPEN.includes(i.status));
  const rows = tab === 'resolved' ? done : [...open].sort((a, b) => rank(a) - rank(b) || at(b.created_at) - at(a.created_at));
  const options = [
    { value: 'open', label: html`مفتوحة<span class="gd-n">${F.num(open.length)}</span>` },
    { value: 'resolved', label: html`محلولة<span class="gd-n">${F.num(done.length)}</span>` },
  ];
  return html`<${Card} title="الملاحظات" icon="flag"
    actions=${html`<${Seg} size="sm" label="حالة الملاحظات" value=${tab} options=${options} onChange=${(v) => setQuery({ tab: v === 'open' ? null : v })} />`}>
    ${rows.length ? html`<div class="gd-incs">${rows.map((i) => html`<${Incident} key=${i.id} inc=${i} labels=${data.fix_labels} onChanged=${onChanged} />`)}</div>`
      : tab === 'resolved'
        ? html`<${Empty} icon="history" title="لا ملاحظات محلولة بعد" text="ما يصلحه الحارس أو تتجاهله يظهر هنا مع وقت الحل وما فعله." />`
        : html`<${Empty} icon="checkCircle" title="لا ملاحظات مفتوحة" text="كل شيء يعمل كما يجب. يفحص الحارس النظام دوريًا، ويفتح ملاحظة فور اكتشاف أي خلل." />`}
  </${Card}>`;
}

// ---------------------------------------------------------------- side cards

function Usage() {
  const day = useApi('/usage?days=1');
  const week = useApi('/usage?days=7');
  const [range, setRange] = useState('1');
  usePoll(() => { day.reload(true); week.reload(true); }, USAGE_POLL_MS);
  const st = range === '1' ? day : week;
  return html`<${Card} title="استهلاك الذكاء الاصطناعي" icon="cpu"
    actions=${html`<${Seg} size="sm" label="الفترة" value=${range} options=${RANGES} onChange=${setRange} />`}>
    <${Loader} state=${st} skeleton=${html`<${Skeleton} lines=${4} h=${18} />`}>${(u) => {
      const rows = Object.entries(u.by_agent || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.cost_usd - a.cost_usd);
      const max = Math.max(...rows.map((r) => r.cost_usd), 0.0001);
      return html`
        <div class="gd-utop">
          <${Stat} label="التكلفة" value=${F.usd(u.cost_usd)} />
          <${Stat} label="الاستدعاءات" value=${F.num(u.calls)} />
          <span class="gd-ai">${u.live ? html`<${Badge} tone="live" icon="zap">Claude متصل</${Badge}>` : html`<${SimTag} />`}</span>
        </div>
        ${rows.length ? html`<div class="gd-urows mt-16">${rows.map((r) => html`<div class="gd-urow" key=${r.id}>
            <${AgentMark} id=${r.id} size="sm" />
            <div class="grow"><div class="row between gap-6"><b class="small ellipsis">${AGENT_NAME[r.id] || r.id}</b><span class="num small">${F.usd(r.cost_usd)}</span></div>
              <div class="gd-ubar"><i style=${{ width: `${Math.max(2, (r.cost_usd / max) * 100)}%` }} /></div>
              <span class="tiny faint">${F.num(r.calls)} استدعاء</span></div></div>`)}</div>`
          : html`<p class="small faint mt-16">لم يستخدم الوكلاء الذكاء الاصطناعي في هذه الفترة.</p>`}
        ${!u.live && html`<div class="notice warn mt-16"><${Icon} name="key" size="17" /><div class="grow">الوكلاء يعملون الآن بعقول محاكاة.
          ${can('manager') ? html` <${Link} href="/settings/connections" class="strong">أضف مفتاح Claude</${Link}> لتشغيل العقول الحقيقية.` : ' يضيف المدير مفتاح Claude من الإعدادات.'}</div></div>`}`;
    }}</${Loader}>
  </${Card}>`;
}

function Playbooks({ labels }) {
  return html`<${Card} title="ما يصلحه الحارس وحده" icon="wand">
    <p class="small muted">لكل خلل معروف خطة إصلاح آمنة، ينفذها الحارس ثم يخبرك بما فعل.</p>
    <div class="gd-plays mt-12">${Object.entries(labels).map(([k, v]) => html`<span class="gd-play" key=${k}><${Icon} name="check" size="13" />${v}</span>`)}</div>
    <div class="notice mt-16"><${Icon} name="sliders" size="17" /><div class="grow">صلاحية «الإصلاح التلقائي» في الإعدادات › الصلاحيات تقرر طريقة عمله: يصلح وحده فورًا، أو يطلب اعتمادك أولًا من مكتب الاعتماد، أو يكتفي بإبلاغك.
      ${can('manager') && html` <${Link} href="/settings/agents?agent=guardian" class="strong">صلاحيات الحارس</${Link}>`}</div></div>
    <p class="tiny faint mt-12">ما لا تحله خطة آلية، مثل رمز وصول ملغى، يُعلَّم «تحتاج تدخلك» ويصلك تنبيه عاجل مرة واحدة.</p>
  </${Card}>`;
}

// ---------------------------------------------------------------- page

function PageSkeleton() {
  return html`<div class="gd-hero"><${Skeleton} w="64px" h=${64} /><div class="grow"><${Skeleton} lines=${3} h=${16} /></div></div>
    <div class="gd-grid"><div class="gd-main"><div class="card pad"><${Skeleton} lines=${3} h=${48} /></div>
      <div class="card pad"><${Skeleton} lines=${4} h=${70} /></div></div>
      <div class="gd-side"><div class="card pad"><${Skeleton} lines=${5} h=${18} /></div></div></div>`;
}

export default function GuardianPage({ query = {} }) {
  const tab = TABS.includes(query.tab) ? query.tab : 'open';
  const st = useApi('/guardian');
  const [sweeping, setSweeping] = useState(false);
  const timer = useRef(0);
  const mine = useRef('');
  const reload = useDebounced(() => st.reload(true), RELOAD_MS);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLive('incident', reload);
  useLive('task', (d) => {
    const t = d.task || {};
    if (!GUARD_TASKS.includes(t.kind)) return;
    if (t.kind === 'guardian.sweep' && ['created', 'started'].includes(d.event)) setSweeping(true);
    if (['done', 'failed', 'waiting', 'cancelled'].includes(d.event)) {
      if (t.kind === 'guardian.sweep') {
        setSweeping(false);
        clearTimeout(timer.current);
        if (t.id && t.id === mine.current) {
          mine.current = '';
          if (d.event === 'done') toast(t.summary || 'انتهى الفحص', 'ok', 'الحارس أنهى الفحص');
          if (d.event === 'failed') toast(t.error || 'تعذر إكمال الفحص', 'bad', 'تعثّر الفحص');
        }
      }
      reload();
    }
  });
  const sweep = async () => {
    setSweeping(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSweeping(false), SWEEP_TIMEOUT_MS);
    try {
      const task = await api.post('/guardian/sweep');
      mine.current = task?.id || '';
      toast('بدأ الحارس فحصًا شاملًا للنظام، وستصلك النتيجة هنا');
    } catch (e) { setSweeping(false); toast.error(e); }
  };
  return html`<div class="gd">
    <${Loader} state=${st} skeleton=${html`<${PageSkeleton} />`}>${(data) => {
      const open = data.incidents.filter((i) => OPEN.includes(i.status));
      const needsOwner = open.filter((i) => i.status === 'needs_owner').length;
      return html`
        <${Hero} data=${data} openCount=${open.length} needsOwner=${needsOwner} sweeping=${sweeping} onSweep=${sweep} />
        <div class="gd-grid">
          <div class="gd-main">
            <${Components} items=${data.components} />
            <${Incidents} data=${data} tab=${tab} onChanged=${reload} />
          </div>
          <div class="gd-side">
            <${Usage} />
            <${Playbooks} labels=${data.fix_labels} />
          </div>
        </div>`;
    }}</${Loader}>
  </div>`;
}
