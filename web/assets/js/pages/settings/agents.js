// الإعدادات › الوكلاء: per-agent switches, model, thinking depth, extra instructions, routines and permissions.
import { html, cls, useMemo } from '../../lib/h.js';
import { api, useApi } from '../../lib/api.js';
import { useLive } from '../../lib/live.js';
import { setQuery } from '../../lib/router.js';
import { can } from '../../lib/store.js';
import { num, usd, ago, label, EFFORT, AGENT_STATUS } from '../../lib/format.js';
import { Icon, Badge, StatusBadge, Card, Stat, AgentMark, Seg, Toggle, Skeleton, Loader, ErrorBox } from '../../ui/core.js';
import {
  useCachedApi, useForm, check, same, without, hasKeys, SettingsForm, Head, ReadOnly, TextField, SwitchRow, PermControl,
  GoLink, confirmLeave, AGENT_GROUPS, AGENT_ORDER, HHMM,
} from './kit.js';

const DECIDERS = new Set(['ceo', 'campaigns']);
const WEEKDAY = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد']; // Python weekday(): 0 = Monday
const MIN_EVERY = 5;
const MAX_EVERY = 1440;
const ROUTINES = {
  plan_day: ['تخطيط محتوى اليوم', 'يضع القائد خطة اليوم ويوزّع مهامها على الفريق.'],
  optimize: ['مراجعة الحملات والليمت', 'يراجع مدير الحملات أداء الحملات النشطة ويعدّل الميزانيات والليمت.'],
  propose: ['اقتراح حملات الأسبوع', 'يقترح مدير الحملات حملات الأسبوع القادم لتعتمدها.'],
  distribute: ['جدولة المحتوى المعتمد', 'يوزّع المنسّق المحتوى المعتمد على القنوات في أنسب الأوقات.'],
  report: ['التقرير اليومي', 'يجمع المنسّق أرقام اليوم ويرسل لك تقرير الإنجاز.'],
  sweep: ['فحص النظام', 'يفحص الحارس المحرك والربط والمهام، ويصلح ما يستطيع.'],
  engage: ['متابعة التعليقات والرسائل', 'يقرأ الوكيل التعليقات والرسائل الجديدة ويجهّز الردود.'],
  metrics: ['تحديث المؤشرات', 'يسحب الوكيل أرقام الوصول والتفاعل من المنصة.'],
  analyze: ['تحليل الأداء', 'يحلل الوكيل ما نجح وما لم ينجح ويرفع توصياته.'],
};
const EFFORT_HINT = {
  low: 'سريع ومنخفض التكلفة، يناسب المهام المتكررة كالفحص والمتابعة.',
  medium: 'توازن بين السرعة والجودة، يناسب أغلب العمل اليومي.',
  high: 'تفكير أعمق للتخطيط والكتابة المتقنة.',
  xhigh: 'لأصعب القرارات. الأبطأ والأعلى تكلفة.',
};
const SCALARS = ['enabled', 'paused', 'model', 'effort', 'instructions'];

const shortModel = (lbl = '') => lbl.replace(/^Claude\s+/i, '');
const pick = (a) => ({ enabled: a.enabled, paused: a.paused, model: a.model, effort: a.effort,
  instructions: a.instructions || '', routines: a.routines || {}, permissions: a.permissions || {} });

/** Only what changed, so a save never rewrites fields the owner did not touch. */
function changes(draft, saved) {
  const out = Object.fromEntries(SCALARS.filter((k) => draft[k] !== saved[k]).map((k) => [k, draft[k]]));
  const routines = Object.fromEntries(Object.entries(draft.routines).filter(([k, v]) => !same(v, saved.routines[k])));
  const permissions = Object.fromEntries(Object.entries(draft.permissions).filter(([k, v]) => v !== saved.permissions[k]));
  return { ...out, ...(hasKeys(routines) && { routines }), ...(hasKeys(permissions) && { permissions }) };
}

function validate(d) {
  return Object.fromEntries(Object.entries(d.routines).flatMap(([name, cfg]) => {
    if ('every_min' in cfg) {
      const n = Number(cfg.every_min);
      if (cfg.every_min === '' || !Number.isInteger(n) || n < MIN_EVERY || n > MAX_EVERY) {
        return [[`routines.${name}`, `أدخل عددًا صحيحًا من ${MIN_EVERY} إلى ${num(MAX_EVERY)} دقيقة`]];
      }
    }
    if ('at' in cfg && !HHMM.test(cfg.at || '')) return [[`routines.${name}`, 'اختر وقتًا صحيحًا']];
    return [];
  }));
}

// ---------------------------------------------------------------- list

function AgentList({ agents, current, onPick }) {
  const byId = Object.fromEntries((agents || []).map((a) => [a.id, a]));
  return html`<nav class="card st-alist" aria-label="الوكلاء">${AGENT_GROUPS.map((g) => html`<div class="st-agroup" key=${g.id}>
    <span class="st-agroup-label">${g.label}</span>
    ${g.ids.map((id) => {
      const a = byId[id];
      if (!agents) return html`<div class="st-aitem" key=${id}><${Skeleton} h=${28} /></div>`;
      if (!a) return null;
      const status = a.paused ? 'paused' : a.status;
      return html`<button type="button" key=${id} class=${cls('st-aitem', id === current && 'on', !a.enabled && 'off')}
        aria-current=${id === current ? 'true' : undefined} onClick=${() => onPick(id)}>
        <${AgentMark} id=${id} size="sm" />
        <span class="st-aitem-txt"><b class="ellipsis">${a.name}</b>
          <span class="tiny faint ellipsis">${a.enabled ? shortModel(a.model_label) : 'معطّل'}</span></span>
        <span class=${cls('status-dot', status)} title=${label(AGENT_STATUS, status)} /></button>`;
    })}</div>`)}</nav>`;
}

// ---------------------------------------------------------------- editor pieces

function Hero({ agent, summary }) {
  const live = { ...agent, ...summary }; // the list summary carries live status and the last saved model/effort
  const status = live.paused ? 'paused' : live.status;
  const today = summary?.today || {};
  const total = Object.values(today).reduce((a, b) => a + b, 0);
  const usage = agent.usage_7d || {};
  return html`<div class="card pad st-ahero">
    <${AgentMark} id=${agent.id} size="lg" />
    <div class="grow">
      <h2>${agent.name}</h2><p class="small muted">${agent.title}</p>
      <div class="row wrap gap-6 mt-8"><${StatusBadge} map=${AGENT_STATUS} value=${status} />
        ${!live.enabled && html`<${Badge} tone="bad">معطّل</${Badge}>`}
        <${Badge} tone="accent" icon="cpu">${live.model_label}</${Badge}><${Badge}>تفكير ${EFFORT[live.effort] || live.effort}</${Badge}></div>
      ${live.status_note && html`<p class="tiny faint mt-8">${live.status_note}</p>`}
    </div>
    <div class="st-ahero-stats">
      <${Stat} label="مهام اليوم" value=${num(total)} hint=${total ? `${num(today.done || 0)} منجزة` : 'لم يبدأ بعد'} icon="activity" />
      <${Stat} label="تكلفة 7 أيام" value=${usd(usage.cost_usd || 0)} hint=${`${num(usage.calls || 0)} استدعاء`} icon="coins" />
      <${Stat} label="آخر تشغيل" value=${agent.last_run_at ? ago(agent.last_run_at) : 'لم يعمل'} icon="clock" />
    </div>
  </div>`;
}

function ModelPicker({ models, value, onChange, agentId }) {
  const preferred = models.find((m) => m.id.includes(DECIDERS.has(agentId) ? 'opus' : 'sonnet'))?.id;
  return html`<div class="st-models" role="radiogroup" aria-label="النموذج">${models.map((m) => {
    const on = m.id === value;
    return html`<button type="button" role="radio" key=${m.id} aria-checked=${on} class=${cls('st-model', on && 'on')} onClick=${() => onChange(m.id)}>
      <span class="row between"><b>${m.label}</b><span class="st-radio" aria-hidden="true">${on && html`<${Icon} name="check" size="13" />`}</span></span>
      <span class="small muted">${m.role}</span>
      <span class="st-price"><span><b class="num">$${m.input}</b> إدخال</span><span><b class="num">$${m.output}</b> إخراج</span>
        <span class="tiny faint">لكل مليون رمز</span></span>
      ${m.id === preferred && html`<span class="st-model-tag"><${Badge} tone="outline" icon="star">الافتراضي لهذا الوكيل</${Badge}></span>`}
    </button>`;
  })}</div>`;
}

function When({ name, cfg, onChange, reportTime }) {
  if ('every_min' in cfg) {
    return html`<label class="st-when"><span>كل</span>
      <input class="input ltr st-num" type="number" inputMode="numeric" min=${MIN_EVERY} max=${MAX_EVERY} step="5" value=${cfg.every_min}
        aria-label=${`${ROUTINES[name]?.[0] || name}: كل كم دقيقة`}
        onInput=${(e) => onChange({ every_min: e.currentTarget.value === '' ? '' : Number(e.currentTarget.value) })} />
      <span>دقيقة</span></label>`;
  }
  if (name === 'report') {
    return html`<span class="st-when"><span>يوميًا الساعة</span><b class="num ltr">${reportTime || '21:00'}</b>
      <${GoLink} href="/settings/notifications" class="tiny">تغيير</${GoLink}></span>`;
  }
  if ('at' in cfg) {
    const day = 'weekday' in cfg ? `كل ${WEEKDAY[cfg.weekday] || ''}` : 'يوميًا';
    return html`<label class="st-when"><span>${day} الساعة</span>
      <input class="input ltr st-time" type="time" value=${cfg.at} aria-label=${`${ROUTINES[name]?.[0] || name}: الوقت`}
        onInput=${(e) => onChange({ at: e.currentTarget.value })} /></label>`;
  }
  return null;
}

function Routines({ routines, onChange, errors, reportTime }) {
  const names = Object.keys(routines);
  if (!names.length) {
    return html`<p class="muted small">لا جدول ثابت لهذا الوكيل. يعمل حين يكلّفه القائد أو تطلب منه مباشرة.</p>`;
  }
  return html`<div class="st-routines">${names.map((name) => {
    const cfg = routines[name];
    const [title, text] = ROUTINES[name] || [name, ''];
    const err = errors[`routines.${name}`];
    return html`<div class=${cls('st-routine', !cfg.enabled && 'off')} key=${name}>
      <${Toggle} checked=${cfg.enabled !== false} label=${title} onChange=${(v) => onChange(name, { enabled: v })} />
      <div class="grow"><b>${title}</b><p>${text}</p>${err && html`<span class="error" role="alert">${err}</span>`}</div>
      <${When} name=${name} cfg=${cfg} reportTime=${reportTime} onChange=${(patch) => onChange(name, patch)} />
    </div>`;
  })}</div>`;
}

// ---------------------------------------------------------------- editor

function AgentForm({ agent, summary, meta, onSaved }) {
  const initial = useMemo(() => pick(agent), [agent]);
  const f = useForm(initial);
  const d = f.draft;
  const editable = can('agents');
  const owner = can('autonomy'); // the server accepts permission changes from the owner only
  const catalog = meta.permissions || agent.permission_catalog || {};
  const models = meta.models || [];
  const setRoutine = (name, patch) => {
    f.set('routines', { ...d.routines, [name]: { ...d.routines[name], ...patch } });
    f.setErrors((e) => without(e, `routines.${name}`));
  };
  const submit = () => {
    if (!check(f, validate(d))) return;
    const body = changes(d, f.saved);
    f.save(async () => {
      const a = await api.patch(`/agents/${agent.id}`, body);
      onSaved(a);
      return pick(a);
    }, `حُفظت إعدادات ${agent.name}`);
  };
  return html`<${Hero} agent=${agent} summary=${summary} />
    <${SettingsForm} form=${f} onSubmit=${submit} canEdit=${editable}>
      <${Card} title="التشغيل" icon="power">
        <${SwitchRow} title="مفعّل" checked=${d.enabled} onChange=${(v) => f.set('enabled', v)}
          text="الوكيل المعطّل لا يستقبل مهام ولا يشغّل جداوله حتى تعيد تفعيله." />
        <${SwitchRow} title="إيقاف مؤقت" checked=${d.paused} onChange=${(v) => f.set('paused', v)}
          text="يوقف المهام والجداول مؤقتًا مع الإبقاء على كل إعداداته، وتستأنفه متى شئت." />
      </${Card}>

      <${Card} title="النموذج وعمق التفكير" icon="brain">
        ${models.length ? html`<${ModelPicker} models=${models} value=${d.model} agentId=${agent.id} onChange=${(v) => f.set('model', v)} />`
          : html`<${Skeleton} h=${120} />`}
        <div class="notice mt-12"><${Icon} name="lightbulb" size="17" /><div class="grow">القائد ومدير الحملات يعملان افتراضيًا على
          Opus لأن قراراتهما توجّه الشبكة كلها: خطة اليوم والحملات والميزانيات. بقية الوكلاء على Sonnet لأنه أسرع وبنصف
          التكلفة، وممتاز في كتابة المحتوى العربي والتفاعل.</div></div>
        <div class="st-effort mt-16">
          <div class="grow"><b class="small">عمق التفكير</b>
            <p class="help">${EFFORT_HINT[d.effort] || ''} التفكير الأعمق أدق، لكنه أبطأ وأعلى تكلفة.</p></div>
          <${Seg} options=${Object.entries(EFFORT).map(([value, text]) => ({ value, label: text }))} value=${d.effort}
            onChange=${(v) => f.set('effort', v)} accent label="عمق التفكير" />
        </div>
      </${Card}>

      <${Card} title="تعليمات إضافية" icon="edit">
        <${TextField} area rows=${5} counter maxLength=${4000} label="تعليماتك لهذا الوكيل" ...${f.bind('instructions')}
          error=${f.errors.instructions}
          placeholder="مثال: ركّز هذا الشهر على عروض العودة للمدارس، ولا تقارن أسعارنا بأحد."
          help="تُضاف إلى ملف الوكيل في كل مهمة بعد ملف العلامة. اكتبها بوضوح وإيجاز." />
      </${Card}>

      <${Card} title="الجدول الزمني" icon="calendar">
        <${Routines} routines=${d.routines} onChange=${setRoutine} errors=${f.errors} reportTime=${meta.sections?.notify?.report_time} />
        ${Object.keys(d.routines).length > 0 && html`<p class="tiny faint mt-12">الأوقات بتوقيت المنطقة الزمنية المحددة في
          «عام والذكاء الاصطناعي»، ولا تعمل الجداول والوكيل معطّل أو موقوف.</p>`}
      </${Card}>

      <${Card} title="صلاحيات هذا الوكيل" icon="shield"
        actions=${!owner && html`<span class="tiny faint row gap-4"><${Icon} name="lock" size="13" />يغيّرها المالك فقط</span>`}>
        <div class="st-perms">${agent.permission_keys.map((k) => html`<div class="st-perm" key=${k}>
          <div class="grow"><b>${catalog[k]?.label || k}</b>${catalog[k]?.hint && html`<p>${catalog[k].hint}</p>`}</div>
          <${PermControl} value=${d.permissions[k]} label=${catalog[k]?.label || k} disabled=${!owner}
            onChange=${(v) => f.set('permissions', { ...d.permissions, [k]: v })} />
        </div>`)}</div>
        <p class="tiny faint mt-12">تغيير مستوى الاستقلالية العام يعيد ضبط هذه القيم.
          <${GoLink} href="/settings/permissions">الاستقلالية والصلاحيات</${GoLink}></p>
      </${Card}>
    </${SettingsForm}>`;
}

function EditorSkeleton() {
  return html`<div class="col gap-16"><div class="card pad"><${Skeleton} h=${84} /></div>
    ${[110, 220, 140].map((h) => html`<div class="card pad"><${Skeleton} h=${h} /></div>`)}</div>`;
}

function AgentEditor({ id, summary, meta, onSaved }) {
  const st = useApi(`/agents/${id}`, [id]);
  return html`<div class="st-aeditor"><${Loader} state=${st} skeleton=${html`<${EditorSkeleton} />`}>${(a) => html`
    <${AgentForm} agent=${a} summary=${summary} meta=${meta} onSaved=${onSaved} />`}</${Loader}></div>`;
}

export default function AgentsTab({ query }) {
  const net = useCachedApi('/network');
  const meta = useCachedApi('/settings');
  const agents = net.data?.agents || null;
  const id = AGENT_ORDER.includes(query.agent) ? query.agent : 'ceo';
  useLive('agent', (ev) => net.setData((n) => n && ({
    ...n, agents: n.agents.map((a) => (a.id === ev.id ? { ...a, status: ev.status, status_note: ev.note } : a)),
  })));
  const pickAgent = async (next) => {
    if (next !== id && await confirmLeave()) setQuery({ agent: next });
  };
  const onSaved = (a) => net.setData((n) => n && ({ ...n, agents: n.agents.map((x) => (x.id === a.id ? { ...x, ...a } : x)) }));
  const ready = agents && meta.data;
  return html`<${Head} title="الوكلاء" text="اضبط كل وكيل على حدة: النموذج الذي يفكر به، وعمق تفكيره، وتعليماتك له، ومواعيد عمله، وما يفعله وحده." />
    ${!can('agents') && html`<${ReadOnly} cap="agents" />`}
    ${net.error && !agents ? html`<${ErrorBox} error=${net.error} retry=${net.reload} />` : html`<div class="st-agents">
      <${AgentList} agents=${agents} current=${id} onPick=${pickAgent} />
      ${ready ? html`<${AgentEditor} key=${id} id=${id} summary=${agents.find((a) => a.id === id)} meta=${meta.data} onSaved=${onSaved} />`
        : meta.error ? html`<${ErrorBox} error=${meta.error} retry=${meta.reload} />` : html`<${EditorSkeleton} />`}
    </div>`}`;
}

