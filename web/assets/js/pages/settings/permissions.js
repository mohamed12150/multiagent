// الإعدادات › الاستقلالية والصلاحيات: the autonomy level (rewrites every agent's matrix) and the full permission matrix,
// where each cell saves at once (optimistic, rolled back if the server refuses).
import { html, cls, useState } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { useLive } from '../../lib/live.js';
import { can, shell } from '../../lib/store.js';
import { num, AUTONOMY, PERM_VALUE } from '../../lib/format.js';
import { Icon, Badge, Button, Card, AgentMark, Skeleton, Loader } from '../../ui/core.js';
import { toast, confirm } from '../../ui/overlays.js';
import { useCachedApi, withSection, Head, PermControl, PermLegend, AGENT_GROUPS } from './kit.js';

const LEVEL_ICON = { manual: 'hand', assisted: 'scale', autopilot: 'rocket' };

/** Cells that differ from the preset of the current level (manual edits made after choosing it). */
const driftOf = (agents, preset) => agents.reduce((n, a) => n + a.permission_keys
  .filter((k) => preset && a.permissions[k] !== preset[k]).length, 0);

function LevelCard({ level, current, preset, catalog, busy, onPick, owner }) {
  const [name, hint] = AUTONOMY[level];
  const keys = Object.keys(preset || {});
  const auto = keys.filter((k) => preset[k] === 'auto');
  const approve = keys.filter((k) => preset[k] === 'approve');
  const showAuto = auto.length <= approve.length;
  const list = showAuto ? auto : approve;
  const on = level === current;
  return html`<button type="button" class=${cls('st-level', on && 'on')} aria-pressed=${on} disabled=${!owner || busy}
    onClick=${() => onPick(level)}>
    <span class="row between"><span class="mark agent"><${Icon} name=${LEVEL_ICON[level]} size="18" /></span>
      ${on && html`<${Badge} tone="accent" icon="check">المستوى الحالي</${Badge}>`}</span>
    <b class="st-level-name">${name}</b>
    <span class="small muted">${hint}</span>
    <span class="st-level-sum"><span class="tiny faint">${showAuto ? 'يعمل الوكلاء وحدهم في:' : 'ينتظر اعتمادك فقط:'}</span>
      <span class="st-tags">${list.map((k) => html`<span class=${cls('st-tag', showAuto ? 'auto' : 'approve')} key=${k}>${catalog[k]?.label || k}</span>`)}</span>
    </span>
  </button>`;
}

function Levels({ level, presets, catalog, agents, onApplied }) {
  const [busy, setBusy] = useState(false);
  const owner = can('owner');
  const drift = agents ? driftOf(agents, presets[level]) : 0;
  const apply = async (next) => {
    if (next === level && !drift) return;
    const name = AUTONOMY[next][0];
    const yes = await confirm({
      title: next === level ? `إعادة ضبط مستوى «${name}»؟` : `التحويل إلى «${name}»؟`,
      text: 'سيُعاد ضبط صلاحيات الوكلاء العشرة كلها وفق هذا المستوى، وتُستبدل أي تعديلات يدوية في المصفوفة. يسري ذلك فورًا على المهام القادمة.',
      ok: 'تطبيق المستوى',
    });
    if (!yes) return;
    setBusy(true);
    try {
      await api.post('/settings/autonomy', { level: next });
      shell.set({ autonomy: next });
      toast(`مستوى الاستقلالية الآن: ${name}`);
      onApplied(next);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return html`<${Card} title="مستوى الاستقلالية" icon="gauge"
    actions=${!owner && html`<span class="tiny faint row gap-4"><${Icon} name="lock" size="13" />يغيّره المالك فقط</span>`}>
    <div class="st-levels">${Object.keys(AUTONOMY).map((k) => html`<${LevelCard} key=${k} level=${k} current=${level}
      preset=${presets[k]} catalog=${catalog} busy=${busy} owner=${owner} onPick=${apply} />`)}</div>
    ${drift > 0 && html`<div class="notice warn mt-16"><${Icon} name="sliders" size="17" />
      <div class="grow">عدّلت ${num(drift)} ${drift === 1 ? 'صلاحية' : 'صلاحيات'} يدويًا بعد اختيار هذا المستوى، فالمصفوفة أدناه لا تطابقه تمامًا.</div>
      ${owner && html`<${Button} size="sm" icon="refresh" loading=${busy} onClick=${() => apply(level)}>إعادة الضبط</${Button}>`}</div>`}
  </${Card}>`;
}

function Matrix({ agents, keys, catalog, pending, editable, onChange }) {
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const cell = (a, k) => (a.permission_keys.includes(k)
    ? html`<td key=${k}><${PermControl} compact value=${a.permissions[k]} disabled=${!editable} busy=${pending.has(`${a.id}:${k}`)}
        label=${`${a.name}: ${catalog[k]?.label || k}`} onChange=${(v) => onChange(a, k, v)} /></td>`
    : html`<td key=${k} class="st-na"><span title="لا تنطبق على هذا الوكيل">·</span></td>`);
  return html`<div class="st-mx-wrap"><table class="st-mx">
    <thead><tr><th class="st-mx-agent" scope="col">الوكيل</th>
      ${keys.map((k) => html`<th key=${k} scope="col" title=${catalog[k]?.hint}><span>${catalog[k]?.label || k}</span></th>`)}</tr></thead>
    <tbody>${AGENT_GROUPS.map((g) => html`
      <tr class="st-mx-group" key=${g.id}><th colSpan=${keys.length + 1} scope="rowgroup">${g.label}</th></tr>
      ${g.ids.filter((id) => byId[id]).map((id) => html`<tr key=${id}>
        <th scope="row" class="st-mx-agent"><span class="row gap-6"><${AgentMark} id=${id} size="sm" /><span class="ellipsis">${byId[id].name}</span></span></th>
        ${keys.map((k) => cell(byId[id], k))}</tr>`)}`)}
    </tbody></table></div>`;
}

/** Phones: one block per agent with only the permissions that apply to it. */
function MatrixList({ agents, catalog, pending, editable, onChange }) {
  return html`<div class="st-mx-list">${AGENT_GROUPS.flatMap((g) => g.ids).map((id) => agents.find((a) => a.id === id)).filter(Boolean)
    .map((a) => html`<div class="st-mx-card" key=${a.id}>
      <div class="row gap-6"><${AgentMark} id=${a.id} size="sm" /><b>${a.name}</b></div>
      ${a.permission_keys.map((k) => html`<div class="st-perm" key=${k}><div class="grow"><b>${catalog[k]?.label || k}</b></div>
        <${PermControl} value=${a.permissions[k]} disabled=${!editable} busy=${pending.has(`${a.id}:${k}`)}
          label=${`${a.name}: ${catalog[k]?.label || k}`} onChange=${(v) => onChange(a, k, v)} /></div>`)}
    </div>`)}</div>`;
}

function KeyGuide({ keys, catalog, agents }) {
  return html`<div class="st-keys">${keys.map((k) => html`<div class="st-key" key=${k}>
    <b>${catalog[k]?.label || k}</b><p>${catalog[k]?.hint}</p>
    <span class="row gap-4 wrap">${agents.filter((a) => a.permission_keys.includes(k)).map((a) => html`<span key=${a.id} title=${a.name}>
      <${AgentMark} id=${a.id} size="sm" /></span>`)}</span>
  </div>`)}</div>`;
}

function Skel() {
  return html`<div class="col gap-16"><div class="card pad"><${Skeleton} h=${190} /></div><div class="card pad"><${Skeleton} h=${360} /></div></div>`;
}

export default function PermissionsTab() {
  const meta = useCachedApi('/settings');
  const net = useCachedApi('/network');
  const [pending, setPending] = useState(new Set());
  const editable = can('owner'); // permission changes are owner-only on the server
  useLive('autonomy', () => { meta.reload(); net.reload(); });

  const setPerm = (id, key, value) => net.setData((n) => n && ({
    ...n, agents: n.agents.map((a) => (a.id === id ? { ...a, permissions: { ...a.permissions, [key]: value } } : a)),
  }));
  const change = async (agent, key, value) => {
    const cell = `${agent.id}:${key}`;
    const prev = agent.permissions[key];
    const label = meta.data?.permissions?.[key]?.label || key;
    setPerm(agent.id, key, value);
    setPending((p) => new Set([...p, cell]));
    try {
      await api.patch(`/agents/${agent.id}`, { permissions: { [key]: value } });
      toast(`${agent.name}: ${label} ← ${PERM_VALUE[value]}`);
    } catch (e) {
      setPerm(agent.id, key, prev);
      toast.error(e);
    } finally {
      setPending((p) => new Set([...p].filter((x) => x !== cell)));
    }
  };
  const applied = (level) => {
    meta.setData(withSection('autonomy', { level }));
    net.reload();
  };

  const state = { data: meta.data && net.data ? true : null, error: meta.error || net.error,
    reload: () => { meta.reload(); net.reload(); } };
  return html`<${Head} title="الاستقلالية والصلاحيات"
    text="حدّد ما يفعله الوكلاء وحدهم وما ينتظر اعتمادك. ابدأ بمستوى عام، ثم عدّل أي صلاحية لوكيل بعينه من المصفوفة." />
    <${Loader} state=${state} skeleton=${html`<${Skel} />`}>${() => {
      const catalog = meta.data.permissions || {};
      const keys = Object.keys(catalog);
      const agents = net.data.agents || [];
      return html`<div class="col gap-20">
        <${Levels} level=${meta.data.sections?.autonomy?.level || 'assisted'} presets=${meta.data.presets || {}} catalog=${catalog}
          agents=${agents} onApplied=${applied} />
        <${Card} title="مصفوفة الصلاحيات" icon="grid" pad=${false}
          actions=${!editable && html`<span class="tiny faint row gap-4"><${Icon} name="lock" size="13" />يغيّرها المالك فقط</span>`}>
          <div class="card-body">
            <p class="small muted">${editable ? 'كل خانة تُحفظ فور تغييرها. ' : ''}الصفوف للوكلاء والأعمدة للصلاحيات، والخانات الفارغة
              لا تخص الوكيل.</p>
            <${Matrix} agents=${agents} keys=${keys} catalog=${catalog} pending=${pending} editable=${editable} onChange=${change} />
            <${MatrixList} agents=${agents} catalog=${catalog} pending=${pending} editable=${editable} onChange=${change} />
          </div>
        </${Card}>
        <${Card} title="ماذا تعني كل قيمة وكل صلاحية" icon="info">
          <${PermLegend} />
          <div class="mt-16"><${KeyGuide} keys=${keys} catalog=${catalog} agents=${agents} /></div>
        </${Card}>
      </div>`;
    }}</${Loader}>`;
}
