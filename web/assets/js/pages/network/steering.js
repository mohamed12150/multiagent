// The CEO's own steering on the home page: month goals and pace, the intervention mode, and its latest decisions.
import { html, cls, useState } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { navigate } from '../../lib/router.js';
import { can } from '../../lib/store.js';
import { num, compact, ago } from '../../lib/format.js';
import { Icon, Button, Badge, Card, Meter } from '../../ui/core.js';
import { toast } from '../../ui/overlays.js';

export const MODE = {
  auto: ['يتدخل بنفسه', 'ok', 'القائد يعدّل الحملات والسعة ضمن الليمت ويخبرك بما فعل'],
  approve: ['يقترح خطة لاعتمادك', 'warn', 'كل تدخل يصلك خطةً واحدة في مكتب الاعتماد'],
  off: ['يراقب فقط', '', 'القائد يقيّم ويسجّل دون أن يغيّر شيئًا'],
};
export const ACTION_STATUS = {
  done: ['نُفّذ', 'ok'], pending: ['بانتظار اعتمادك', 'warn'], awaiting: ['في خطة بانتظارك', 'warn'],
  rejected: ['خارج الصلاحية', 'bad'], skipped: ['لم يعد مناسبًا', ''], observed: ['رُصد فقط', ''],
  deferred: ['أُجّل لحد اليوم', ''], declined: ['رفضته', 'bad'],
};
const SOURCE = { steer: 'مراجعة دورية', command: 'بأمرك' };
const DECISION_MODE = { approved: 'اعتمدت الخطة', declined: 'رفضت الخطة', approval: 'خطة بانتظارك', observe: 'مراقبة', steady: 'على المسار' };
const FOCUS = { leads: 'العملاء المحتملون', sales: 'المبيعات', engagement: 'التفاعل', awareness: 'الوصول' };

function paceTone(pace) {
  if (pace == null) return '';
  return pace >= 95 ? 'ok' : pace >= 75 ? 'warn' : 'bad';
}

function Goal({ label, track, fmt = num }) {
  const t = track.target || 0;
  return html`<div class="sg-goal">
    <div class="row between small"><span class="muted">${label}</span>
      <span><b class="num">${fmt(track.actual)}</b>${t ? html` / <span class="num">${fmt(t)}</span>` : ''}</span></div>
    ${t ? html`<div class="mt-4"><${Meter} value=${track.actual} max=${t} tone=${paceTone(track.pace)} /></div>
      <div class="row between tiny faint mt-4"><span>الوتيرة ${track.pace == null ? '—' : `${num(track.pace)}٪`}</span>
        <span>المتوقع آخر الشهر ${fmt(track.projected)}</span></div>` : html`<p class="tiny faint mt-4">لا هدف محدد</p>`}
  </div>`;
}

function Decision({ d }) {
  const [open, setOpen] = useState(false);
  const acts = d.actions || [];
  const shown = open ? acts : acts.slice(0, 3);
  return html`<div class="sg-dec">
    <div class="row between gap-6"><span class="tiny faint">${SOURCE[d.source] || d.source} · ${ago(d.at)}</span>
      ${DECISION_MODE[d.mode] && html`<${Badge} tone=${d.mode === 'declined' ? 'bad' : d.mode === 'approval' ? 'warn' : ''}>${DECISION_MODE[d.mode]}</${Badge}>`}</div>
    <p class="small mt-4">${d.assessment}</p>
    ${acts.length > 0 && html`<ul class="sg-acts">${shown.map((a, i) => { const [word, tone] = ACTION_STATUS[a.status] || [a.status, '']; return html`
      <li key=${i}><span class="grow"><b class="small">${a.label}</b>${a.reason && html`<span class="tiny faint">${a.reason}</span>`}</span>
        <${Badge} tone=${tone}>${word}</${Badge}></li>`; })}</ul>`}
    ${acts.length > 3 && html`<button class="sg-more tiny" onClick=${() => setOpen(!open)}>${open ? 'أقل' : `و${num(acts.length - 3)} إجراءات أخرى`}</button>`}
  </div>`;
}

export function Steering({ data, onRan }) {
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const { progress: p, goals, mode, decisions, used_today: used } = data;
  const [modeLabel, modeTone, modeHint] = MODE[mode] || MODE.off;
  const run = async () => {
    setBusy(true);
    try { await api.post('/agents/ceo/run', { kind: 'ceo.steer' }); toast('القائد يراجع الأداء الآن ويقرر'); onRan?.(); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return html`<${Card} title="قرارات القائد" icon="compass" actions=${html`<${Badge} tone=${modeTone} icon="crown">${modeLabel}</${Badge}>`}>
    <p class="tiny faint">${modeHint}. هدف الشهر: <b>${FOCUS[goals.focus] || goals.focus}</b> · اليوم ${num(p.day)} من ${num(p.days)}
      · تدخلات اليوم ${num(used)}/${num(goals.max_daily_interventions)}</p>
    <div class="sg-goals mt-12">
      <${Goal} label="العملاء المحتملون" track=${p.leads} />
      <${Goal} label="الوصول" track=${p.reach} fmt=${compact} />
      <div class="sg-goal"><div class="row between small"><span class="muted">معدل التفاعل</span>
        <span><b class="num">${p.engagement_rate.actual}٪</b> / <span class="num">${p.engagement_rate.target}٪</span></span></div>
        <div class="mt-4"><${Meter} value=${p.engagement_rate.actual} max=${p.engagement_rate.target || 1}
          tone=${p.engagement_rate.actual >= p.engagement_rate.target ? 'ok' : 'warn'} /></div></div>
    </div>
    <div class="sg-list mt-16">${decisions.length ? decisions.slice(0, 3).map((d) => html`<${Decision} key=${d.at} d=${d} />`)
      : html`<p class="small muted">لم يراجع القائد الأداء بعد. يراجعه كل 3 ساعات في ساعات العمل، أو اطلب مراجعة الآن.</p>`}</div>
    <div class=${cls('row wrap gap-6 mt-12')}>
      ${can('command') && html`<${Button} size="sm" icon="compass" loading=${busy} onClick=${run}>راجع الأداء الآن</${Button}>`}
      ${can('autonomy') && html`<${Button} size="sm" variant="ghost" icon="target" onClick=${() => navigate('/settings/goals')}>الأهداف والصلاحية</${Button}>`}
    </div>
  </${Card}>`;
}

/** Approval-desk body for a plan: what القائد wants to do and why. */
export function PlanBody({ a }) {
  const p = a.payload || {};
  const results = p.results || [];
  return html`<div class="col">
    <p>${a.summary}</p>
    <ul class="sg-acts">${(p.actions || []).map((x, i) => { const r = results[i]; const [word, tone] = r ? (ACTION_STATUS[r.status] || [r.status, '']) : []; return html`
      <li key=${i}><span class="grow"><b class="small">${x.label}</b>${x.reason && html`<span class="tiny faint">${x.reason}</span>`}
        ${x.expected && html`<span class="tiny sg-exp"><${Icon} name="trend" size="12" /> ${x.expected}</span>`}</span>
        ${r && html`<${Badge} tone=${tone}>${word}</${Badge}>`}</li>`; })}</ul>
    <p class="tiny faint">عند الاعتماد يتحقق القائد من كل إجراء مقابل الوضع الحالي قبل تنفيذه، ويتجاوز ما لم يعد مناسبًا.</p>
  </div>`;
}
