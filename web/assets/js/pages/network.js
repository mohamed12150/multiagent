// الشبكة الحية — the home page: the orbit map, the command desk to القائد, today's pulse and the live feed.
import { html, cls, useState, useEffect, useRef, useCallback } from '../lib/h.js';
import { api, useApi } from '../lib/api.js';
import { useLive } from '../lib/live.js';
import { navigate } from '../lib/router.js';
import { session, useStore, can } from '../lib/store.js';
import {
  num, compact, usd, ago, longToday, greeting, CHANNELS, CHANNEL_LABEL, TASK_STATUS, AGENT_STATUS, PERM_VALUE, EFFORT,
} from '../lib/format.js';
import { Icon, Button, Badge, StatusBadge, Card, Stat, Meter, AgentMark, ChannelMark, Empty, Skeleton, SimTag, Toggle, Loader, useDebounced } from '../ui/core.js';
import { Drawer, toast } from '../ui/overlays.js';
import { OrbitMap, usePulses } from '../ui/orbit.js';

const SUGGESTIONS = [
  'اقترح حملة للجمعة البيضاء ترفع المبيعات',
  'جهّز منشورات الأسبوع لإنستقرام وتيك توك',
  'حلّل المنافسين وقل لي وين نتفوق',
  'رد على كل الرسائل المعلقة',
  'أرسل لي تقرير اليوم',
  'افحص النظام وأصلح أي خطأ',
];
const COLOR = { created: 'var(--accent)', done: 'var(--ok)', failed: 'var(--bad)', started: 'var(--live)', retry: 'var(--warn)' };


// ---------------------------------------------------------------- command desk

function CommandDesk({ onSent }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const area = useRef(null);
  const send = async (value) => {
    const order = (value ?? text).trim();
    if (order.length < 2 || busy) return;
    setBusy(true);
    try {
      const task = await api.post('/command', { text: order });
      setText('');
      toast('وصل أمرك للقائد — سيوزّعه على الفريق الآن');
      onSent?.(task);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const grow = (e) => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; };
  if (!can('editor')) return null;
  return html`<div class="command">
    <div class="command-row">
      <textarea ref=${area} rows="1" value=${text} placeholder="أعطِ القائد أمرًا… مثل: جهّز حملة لعيد الفطر بميزانية 3000 ريال"
        aria-label="أمر للقائد" onInput=${(e) => { setText(e.currentTarget.value); grow(e); }}
        onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
      <${Button} variant="primary" class="send" icon="send" loading=${busy} onClick=${() => send()} disabled=${text.trim().length < 2}>أرسل</${Button}>
    </div>
    <div class="chips">${SUGGESTIONS.map((sug) => html`<button class="chip" onClick=${() => send(sug)}>${sug}</button>`)}</div>
  </div>`;
}

// ---------------------------------------------------------------- agent drawer

function AgentDrawer({ id, onClose }) {
  const st = useApi(`/agents/${id}`, [id]);
  const [busy, setBusy] = useState('');
  useLive('task', (d) => { if (d.task?.agent_id === id) st.reload(true); });
  const run = async (kind) => {
    setBusy(kind);
    try { await api.post(`/agents/${id}/run`, { kind }); toast('بدأ الوكيل المهمة'); st.reload(true); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const pause = async (paused) => {
    try { await api.patch(`/agents/${id}`, { paused }); st.reload(true); toast(paused ? 'أُوقف الوكيل مؤقتًا' : 'استؤنف عمل الوكيل'); } catch (e) { toast.error(e); }
  };
  const a = st.data;
  return html`<${Drawer} title=${a?.name || 'الوكيل'} onClose=${onClose} icon=${html`<${AgentMark} id=${id} size="sm" />`}
    footer=${a && html`<${Button} icon="sliders" onClick=${() => navigate(`/settings/agents?agent=${id}`)}>إعدادات الوكيل</${Button}>
      ${a.channel && html`<${Button} variant="ghost" iconEnd="arrowLeft" onClick=${() => navigate(`/channels/${a.channel}`)}>صفحة القناة</${Button}>`}`}>
    <${Loader} state=${st}>${(ag) => html`
      <div class="agent-hero"><${AgentMark} id=${id} size="lg" /><div class="grow">
        <p class="muted">${ag.title}</p>
        <div class="row wrap mt-8 gap-6"><${StatusBadge} map=${AGENT_STATUS} value=${ag.paused ? 'paused' : ag.status} />
          <${Badge} tone="accent" icon="cpu">${ag.model_label}</${Badge}><${Badge}>تفكير ${EFFORT[ag.effort] || ag.effort}</${Badge}></div>
      </div></div>
      ${ag.status_note && html`<div class="notice mt-8"><${Icon} name="activity" size="17" /><div class="grow">${ag.status_note}</div></div>`}
      ${can('manager') && html`<div class="row between mt-16 well"><span>إيقاف مؤقت للوكيل</span><${Toggle} checked=${ag.paused} label="إيقاف مؤقت" onChange=${pause} /></div>`}
      ${ag.runnable.length > 0 && can('editor') && html`<h3 class="mt-24">تشغيل الآن</h3><div class="row wrap mt-8 gap-6">${ag.runnable.map((r) => html`
        <${Button} size="sm" icon="play" loading=${busy === r.kind} onClick=${() => run(r.kind)}>${r.label}</${Button}>`)}</div>`}
      <h3 class="mt-24">الصلاحيات</h3>
      <div class="mt-8">${Object.entries(ag.permission_catalog).map(([k, meta]) => html`<div class="perm-row">
        <span><b class="small">${meta.label}</b><span class="tiny faint" style="display:block">${meta.hint}</span></span>
        <${Badge} tone=${ag.permissions[k] === 'auto' ? 'ok' : ag.permissions[k] === 'off' ? 'bad' : 'warn'}>${PERM_VALUE[ag.permissions[k]] || '—'}</${Badge}></div>`)}</div>
      ${ag.insights?.summary && html`<h3 class="mt-24">ما تعلّمه</h3><p class="muted mt-8">${ag.insights.summary}</p>`}
      <h3 class="mt-24">آخر المهام</h3>
      <div class="mt-8">${ag.tasks.length ? ag.tasks.slice(0, 12).map((t) => html`<div class="task-line">
        <${StatusBadge} map=${TASK_STATUS} value=${t.status} />
        <div class="grow"><b class="small">${t.title}</b>${(t.summary || t.error) && html`<p class="small muted clamp-2">${t.error || t.summary}</p>`}</div>
        <span class="tiny faint">${ago(t.created_at)}</span></div>`) : html`<p class="muted small">لم ينفّذ مهام بعد.</p>`}</div>
      <p class="tiny faint mt-16">تكلفة الذكاء الاصطناعي (7 أيام): ${usd(ag.usage_7d?.cost_usd || 0)} · ${num(ag.usage_7d?.calls || 0)} استدعاء</p>
    `}</${Loader}>
  </${Drawer}>`;
}

// ---------------------------------------------------------------- commands

function CommandDrawer({ id, onClose }) {
  const st = useApi(`/tasks/${id}`, [id]);
  useLive('task', (d) => { if (d.task?.id === id || d.task?.parent_id === id) st.reload(true); });
  return html`<${Drawer} title="تنفيذ الأمر" onClose=${onClose} icon=${html`<${AgentMark} id="ceo" size="sm" />`}>
    <${Loader} state=${st}>${(t) => html`
      <div class="well"><span class="tiny faint">أمرك</span><p class="strong mt-4">${t.input?.text || t.title}</p></div>
      <div class="row mt-16 gap-6"><${StatusBadge} map=${TASK_STATUS} value=${t.status} />${t.output?.simulated && html`<${SimTag} />`}
        <span class="tiny faint">${ago(t.created_at)}</span></div>
      ${t.summary && html`<p class="pre mt-12">${t.summary}</p>`}
      ${t.error && html`<div class="notice bad mt-12"><${Icon} name="alert" size="17" /><div class="grow">${t.error}</div></div>`}
      <h3 class="mt-24">توزيع المهام</h3>
      <div class="mt-8">${t.children.length ? t.children.map((c) => html`<div class="task-line">
        <${AgentMark} id=${c.agent_id} size="sm" /><div class="grow"><b class="small">${c.title}</b>
        ${(c.summary || c.error) && html`<p class="small muted">${c.error || c.summary}</p>`}</div><${StatusBadge} map=${TASK_STATUS} value=${c.status} /></div>`)
        : html`<p class="muted small">${t.status === 'done' ? 'أجاب القائد مباشرة دون تكليف.' : 'القائد يحلل الأمر الآن…'}</p>`}</div>`}</${Loader}>
  </${Drawer}>`;
}

function Commands({ refreshKey, onOpen }) {
  const st = useApi('/tasks?origin=command&limit=6', [refreshKey]);
  const [children, setChildren] = useState({});
  const reload = useDebounced(() => st.reload(true), 800);
  useLive('task', (d) => { if (d.task?.origin === 'command' || d.task?.parent_id) reload(); });
  useEffect(() => {
    (st.data || []).forEach((t) => { if (!children[t.id] || t.status !== 'done') api.get(`/tasks/${t.id}`).then((x) => setChildren((c) => ({ ...c, [t.id]: x.children }))).catch(() => {}); });
  }, [st.data]);
  return html`<${Card} title="أوامرك الأخيرة" icon="command">
    <${Loader} state=${st} skeleton=${html`<${Skeleton} lines=${3} h=${40} />`}>${(rows) => (rows.length ? rows.map((t) => html`
      <div class="cmd" key=${t.id} onClick=${() => onOpen(t.id)}>
        <${AgentMark} id="ceo" size="sm" />
        <div class="grow"><div class="row between"><b class="ellipsis">${t.title}</b><span class="tiny faint">${ago(t.created_at)}</span></div>
          ${t.summary && html`<p class="small muted clamp-2">${t.summary.split('\n')[0]}</p>`}
          <div class="team">${(children[t.id] || []).map((c) => html`<span class=${cls('tm', c.status)} title=${`${c.title} — ${TASK_STATUS[c.status]?.[0] || ''}`}>
            <${AgentMark} id=${c.agent_id} size="sm" /></span>`)}</div>
        </div><${StatusBadge} map=${TASK_STATUS} value=${t.status} />
      </div>`) : html`<${Empty} icon="command" title="لم تعطِ القائد أوامر بعد" text="اكتب أمرك في المكتب أعلاه أو اختر اقتراحًا جاهزًا؛ سيوزّعه القائد على الوكلاء المناسبين." />`)}</${Loader}>
  </${Card}>`;
}

// ---------------------------------------------------------------- today's pulse

function Pulse({ net }) {
  const k = net.kpis;
  const t = k.totals;
  const lim = net.limits;
  const cap = lim.limits.daily_ad_spend_cap;
  return html`<${Card} title="نبض اليوم" icon="activity" actions=${!net.ai_live && html`<${SimTag} />`}>
    <div class="pulse-grid">
      <${Stat} label="منشورات" value=${num(t.posts)} icon="send" />
      <${Stat} label="الوصول" value=${compact(t.reach)} icon="eye" />
      <${Stat} label="التفاعل" value=${compact(t.engagement)} hint=${`${t.engagement_rate}٪ معدل`} icon="heart" />
      <${Stat} label="ردود على العملاء" value=${num(k.conversations.replies)} hint=${`${num(k.conversations.leads)} فرصة بيع`} icon="message" />
    </div>
    <div class="mt-16">
      <div class="row between small"><span class="muted">صرف الترويج اليوم</span>
        <span><span class="num">${num(lim.spend_today)}</span> من <span class="num">${num(cap)}</span> ر.س</span></div>
      <div class="mt-4"><${Meter} value=${lim.spend_today} max=${cap || 1} /></div>
    </div>
    <h3 class="mt-16 small muted">سعة النشر اليوم (بدون حملات)</h3>
    <div class="mt-4">${CHANNELS.map((ch) => { const o = lim.organic[ch]; return html`<div class="cap-row" key=${ch}>
      <${ChannelMark} ch=${ch} size="sm" /><${Meter} value=${o.used} max=${o.limit || 1} tone=${o.used >= o.limit && o.limit ? 'ok' : ''} />
      <span class="num ltr">${o.used}/${o.limit}</span></div>`; })}</div>
    <p class="tiny faint mt-12">تكلفة الذكاء الاصطناعي اليوم: ${usd(net.ai_cost_today)}</p>
  </${Card}>`;
}

// ---------------------------------------------------------------- live feed

const actorId = (actor) => (actor?.startsWith('user:') ? 'owner' : actor);

function Feed({ fire }) {
  const st = useApi('/feed?limit=40');
  const [fresh, setFresh] = useState(new Set());
  const me = useStore(session).user;
  useLive('feed', (ev) => {
    st.setData((rows) => [ev, ...(rows || []).filter((r) => r.id !== ev.id)].slice(0, 60));
    setFresh((f) => new Set([...f, ev.id]));
  });
  return html`<${Card} title="البث المباشر" icon="activity" pad=${false}>
    <div class="card-body"><${Loader} state=${st} skeleton=${html`<${Skeleton} lines=${6} h=${30} />`}>${(rows) => (rows.length
      ? html`<div class="feed">${rows.map((e) => { const who = actorId(e.actor); return html`<div class=${cls('feed-item', fresh.has(e.id) && 'fresh')} key=${e.id}>
          ${who === 'owner' ? html`<span class="mark"><${Icon} name="user" size="14" /></span>` : who && who !== 'system' ? html`<${AgentMark} id=${who} size="sm" />` : html`<span class="mark"><${Icon} name="cpu" size="14" /></span>`}
          <div class="grow"><p class="t">${e.title}</p><span class="tiny faint">${who === 'owner' ? (me?.name || 'أنت') : ''} ${ago(e.at)}</span></div></div>`; })}</div>`
      : html`<${Empty} icon="activity" title="الهدوء قبل الانطلاق" text="سيظهر هنا كل ما يفعله الوكلاء لحظة بلحظة." />`)}</${Loader}></div>
  </${Card}>`;
}

// ---------------------------------------------------------------- phones: the map becomes a roster

const ORDER = ['ceo', 'campaigns', 'content', 'coordinator', 'guardian', 'tiktok', 'instagram', 'x', 'whatsapp', 'linkedin'];

function Roster({ agents, onPick }) {
  const by = Object.fromEntries(agents.map((a) => [a.id, a]));
  return html`<div class="roster">${ORDER.filter((id) => by[id]).map((id) => { const a = by[id]; const st = a.paused ? 'paused' : a.status; return html`
    <button class=${cls('roster-item', `st-${st}`)} key=${id} onClick=${() => onPick(id)}>
      <${AgentMark} id=${id} size="sm" /><span class="grow"><b class="small ellipsis" style="display:block">${a.name}</b>
      <span class="tiny faint ellipsis" style="display:block">${a.status_note || AGENT_STATUS[st]?.[0] || ''}</span></span>
      <i class=${cls('status-dot', st)} /></button>`; })}</div>`;
}

// ---------------------------------------------------------------- page

export default function NetworkPage() {
  const st = useApi('/network');
  const { user } = useStore(session);
  const [picked, setPicked] = useState(null);
  const [command, setCommand] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { pulses, pings, fire } = usePulses();
  const reload = useDebounced(() => st.reload(true), 2500);

  useLive('agent', (d) => st.setData((n) => n && ({ ...n, agents: n.agents.map((a) => (a.id === d.id ? { ...a, status: d.status, status_note: d.note } : a)) })));
  useLive('task', (d) => {
    const t = d.task || {};
    if (d.event === 'created') fire(d.from, t.agent_id, COLOR.created);
    else if (d.event === 'done') fire(t.agent_id, d.to, COLOR.done);
    else if (d.event === 'started') fire(t.agent_id, t.agent_id, COLOR.started);
    else if (d.event === 'failed') fire(t.agent_id, t.agent_id, COLOR.failed);
    if (d.event === 'done' || d.event === 'failed') reload();
  });
  useLive('metrics', reload);
  useEffect(() => { const id = setInterval(() => { if (!document.hidden) st.reload(true); }, 60000); return () => clearInterval(id); }, []);

  const net = st.data;
  const working = net?.agents.filter((a) => a.status === 'working').length || 0;
  return html`
    <div class="hello">
      <div class="grow"><h2>${greeting()}، ${user?.name?.split(' ')[0] || ''}</h2><p>${longToday()} · ${net ? (working ? `${working} وكلاء يعملون الآن` : 'الفريق جاهز وينتظر أمرك') : '…'}</p></div>
      ${net && !net.ai_live && html`<${Button} size="sm" icon="key" onClick=${() => navigate('/settings/connections?provider=anthropic')}>أضف مفتاح Claude لتشغيل العقول الحقيقية</${Button}>`}
    </div>
    <div class="net">
      <div class="net-main">
        <div class="map-card">
          <div class="map-top"><h2>الخريطة الحية</h2>
            <div class="legend"><span><i class="status-dot working" />يعمل</span><span><i class="status-dot waiting" />بانتظار</span><span><i class="status-dot error" />تعثّر</span></div></div>
          ${net && html`<${Roster} agents=${net.agents} onPick=${setPicked} />`}
          ${net ? html`<${OrbitMap} agents=${net.agents} pulses=${pulses} pings=${pings} selected=${picked} onPick=${setPicked} ownerLabel=${user?.name?.split(' ')[0] || 'أنت'} />`
            : html`<div style="aspect-ratio:1000/690;display:grid;place-items:center"><${Skeleton} w="220px" h=${14} /></div>`}
          <${CommandDesk} onSent=${(task) => { fire(`user:${user.id}`, 'ceo', COLOR.created); setRefreshKey((k) => k + 1); setCommand(task.id); }} />
        </div>
        <${Commands} refreshKey=${refreshKey} onOpen=${setCommand} />
      </div>
      <div class="net-side">
        ${net ? html`<${Pulse} net=${net} />` : html`<${Card} title="نبض اليوم"><${Skeleton} lines=${5} h=${22} /></${Card}>`}
        <${Feed} fire=${fire} />
      </div>
    </div>
    ${picked && html`<${AgentDrawer} id=${picked} onClose=${() => setPicked(null)} />`}
    ${command && html`<${CommandDrawer} id=${command} onClose=${() => setCommand(null)} />`}`;
}
