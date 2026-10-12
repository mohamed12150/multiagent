// «المنافسون» tab: the rivals we watch, what مدير الحملات learned about each one, and the add / edit drawer.
import { html, useState } from '../../lib/h.js';
import { api, useApi } from '../../lib/api.js';
import { useLive } from '../../lib/live.js';
import { can } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Badge, SimTag, Empty, Skeleton, Loader, Field, ChannelMark, useDebounced } from '../../ui/core.js';
import { Drawer, toast, confirm } from '../../ui/overlays.js';
import { Label, Sources, safeUrl, hostOf } from './shared.js';

const THREAT = { low: ['تهديد منخفض', 'ok'], medium: ['تهديد متوسط', 'warn'], high: ['تهديد مرتفع', 'bad'] };
const FACETS = [
  ['strengths', 'نقاط القوة', 'trophy'],
  ['weaknesses', 'نقاط الضعف', 'alert'],
  ['content_patterns', 'أنماط المحتوى', 'layers'],
  ['offers', 'العروض', 'coins'],
];
const ANALYSIS_KEYS = ['positioning', 'threat', 'opportunities', ...FACETS.map(([k]) => k)];

function Facet({ title, icon, items }) {
  if (!items?.length) return null;
  return html`<div class="cp-facet"><${Label} icon=${icon}>${title}</${Label}>
    <ul>${items.map((x, i) => html`<li key=${i}>${x}</li>`)}</ul></div>`;
}

function RivalCard({ r, onEdit, onDeleted }) {
  const a = r.analysis || {};
  const analyzed = ANALYSIS_KEYS.some((k) => (Array.isArray(a[k]) ? a[k].length : a[k]));
  const site = safeUrl(r.website);
  const handles = Object.entries(r.handles || {}).filter(([ch, v]) => v && F.CHANNEL_LABEL[ch]);
  const threat = THREAT[a.threat];
  const del = async () => {
    if (!(await confirm({ title: 'حذف المنافس؟', text: `سيُحذف «${r.name}» وتحليله نهائيًا، ولن يدخل في مقترحات الحملات القادمة.`, ok: 'احذف', danger: true }))) return;
    try { await api.del(`/competitors/${r.id}`); toast('حُذف المنافس', 'ok', r.name); onDeleted(r.id); } catch (e) { toast.error(e); }
  };
  return html`<article class="card cp-rival">
    <header class="cp-rival-head">
      <span class="cp-avatar" aria-hidden="true">${(r.name || '؟').trim().slice(0, 1)}</span>
      <div class="grow"><h3 class="ellipsis">${r.name}</h3>
        ${site ? html`<a class="tiny ltr cp-site" href=${site} target="_blank" rel="noopener noreferrer">${hostOf(site)}</a>`
          : html`<span class="tiny faint">بلا موقع مسجّل</span>`}</div>
      ${threat && html`<${Badge} tone=${threat[1]} icon="flame">${threat[0]}</${Badge}>`}
      ${can('proposals') && html`<${Button} size="sm" variant="ghost" icon="edit" title="تعديل" aria-label=${`تعديل ${r.name}`} onClick=${() => onEdit(r)} />`}
      ${can('campaigns') && html`<${Button} size="sm" variant="ghost" icon="trash" class="cp-del" title="حذف" aria-label=${`حذف ${r.name}`} onClick=${del} />`}
    </header>
    ${handles.length > 0 && html`<div class="cp-handles">${handles.map(([ch, h]) => html`<span class="cp-handle" key=${ch}>
      <${ChannelMark} ch=${ch} size="sm" /><span class="ltr ellipsis">${h}</span></span>`)}</div>`}
    <div class="cp-rival-body">
      ${analyzed ? html`
        ${a.positioning && html`<p class="cp-position">${a.positioning}</p>`}
        <div class="cp-facets">${FACETS.map(([key, title, icon]) => html`<${Facet} key=${key} title=${title} icon=${icon} items=${a[key]} />`)}</div>
        ${a.opportunities?.length > 0 && html`<div class="cp-opps"><${Label} icon="lightbulb">فرص نتفوق بها عليه</${Label}>
          <ul>${a.opportunities.map((o, i) => html`<li key=${i}>${o}</li>`)}</ul></div>`}`
      : html`<div class="cp-unread"><${Icon} name="search" size="18" /><p class="small muted">لم يُحلَّل بعد. اضغط «حلّل المنافسين الآن» ليقرأ مدير الحملات حضوره ومحتواه وعروضه ويستخرج الفرص.</p></div>`}
      ${r.notes && html`<p class="cp-notes"><${Icon} name="file" size="13" /><span>${r.notes}</span></p>`}
    </div>
    ${analyzed && html`<footer class="cp-rival-foot">
      <span class="cp-when"><${Icon} name="clock" size="13" />${r.analyzed_at ? `حُلّل ${F.ago(r.analyzed_at)}` : 'حُلّل'}</span>
      ${a.simulated && html`<${SimTag} />`}<${Sources} items=${a.sources} max=${3} /></footer>`}
  </article>`;
}

const cleanHandles = (h) => Object.fromEntries(Object.entries(h || {})
  .map(([k, v]) => [k, String(v || '').trim()]).filter(([k, v]) => v && F.CHANNEL_LABEL[k]));

function RivalDrawer({ rival, onClose, onSaved }) {
  const [f, setF] = useState(() => ({ name: rival?.name || '', website: rival?.website || '', notes: rival?.notes || '',
    handles: { ...(rival?.handles || {}) } }));
  const [err, setErr] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.currentTarget.value }));
  const setHandle = (ch) => (e) => { const v = e.currentTarget.value; setF((x) => ({ ...x, handles: { ...x.handles, [ch]: v } })); };
  const save = async () => {
    const name = f.name.trim();
    const errors = {};
    if (name.length < 2) errors.name = 'اكتب اسم المنافس (حرفان على الأقل)';
    if (f.website.trim() && !safeUrl(f.website)) errors.website = 'الرابط غير صالح، اكتبه مثل: example.com';
    setErr(errors);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const body = { name, website: f.website.trim(), notes: f.notes.trim(), handles: cleanHandles(f.handles) };
      const out = rival ? await api.patch(`/competitors/${rival.id}`, body) : await api.post('/competitors', body);
      toast(rival ? 'حُفظت بيانات المنافس' : 'أُضيف المنافس. حلّل المنافسين ليظهر تحليله', 'ok', out.name);
      onSaved(out, !rival);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return html`<${Drawer} title=${rival ? `تعديل ${rival.name}` : 'منافس جديد'} onClose=${onClose}
    icon=${html`<span class="mark sm agent"><${Icon} name="users" size="15" /></span>`}
    footer=${html`<${Button} variant="primary" icon="check" loading=${busy} onClick=${save}>${rival ? 'احفظ التعديلات' : 'أضف المنافس'}</${Button}>
      <${Button} variant="ghost" onClick=${onClose}>إلغاء</${Button}>`}>
    <div class="col gap-16">
      <${Field} label="اسم المنافس" error=${err.name}><input class="input" value=${f.name} maxLength="160" placeholder="مثال: متجر الريم"
        onInput=${set('name')} autofocus /></${Field}>
      <${Field} label="الموقع الإلكتروني" error=${err.website} help="اختياري، يساعد مدير الحملات على قراءة عروضه وأسعاره المعلنة.">
        <input class="input ltr" value=${f.website} maxLength="300" placeholder="example.com" inputmode="url" onInput=${set('website')} /></${Field}>
      <div class="field"><label>حساباته على المنصات</label>
        <div class="cp-handle-fields">${F.CHANNELS.map((ch) => html`<div class="cp-handle-field" key=${ch}><${ChannelMark} ch=${ch} size="sm" />
          <input class="input ltr" value=${f.handles[ch] || ''} maxLength="120" placeholder=${ch === 'whatsapp' ? '9665XXXXXXXX' : '@handle'}
            aria-label=${`حسابه على ${F.CHANNEL_LABEL[ch]}`} onInput=${setHandle(ch)} /></div>`)}</div>
        <span class="help">اترك الحقل فارغًا إن لم يكن له حساب على المنصة.</span></div>
      <${Field} label="ملاحظاتك عنه" help="ما تعرفه: أسعاره، جمهوره، ما يميزه في السوق.">
        <textarea class="textarea" value=${f.notes} maxLength="3000" onInput=${set('notes')} /></${Field}>
    </div>
  </${Drawer}>`;
}

function RivalsSkeleton() {
  return html`<div class="cp-rivals">${[0, 1].map((i) => html`<div class="card pad" key=${i}><div class="row gap-16">
    <${Skeleton} w="44px" h=${44} /><div class="grow"><${Skeleton} lines=${2} h=${16} /></div></div>
    <div class="mt-16"><${Skeleton} lines=${5} h=${14} /></div></div>`)}</div>`;
}

export function CompetitorsTab() {
  const st = useApi('/competitors');
  const [edit, setEdit] = useState(null);
  const [analyzing, setAnalyzing] = useState(null);
  const [busy, setBusy] = useState(false);
  const reload = useDebounced(() => st.reload(true), 600);

  useLive('task', (d) => {
    const t = d.task || {};
    if (t.kind !== 'campaigns.analyze_competitors') return;
    if (d.event === 'created' || d.event === 'started' || d.event === 'retry') { setAnalyzing(t.id); return; }
    if (d.event !== 'done' && d.event !== 'failed' && d.event !== 'waiting') return;
    if (t.id === analyzing) {
      toast(d.event === 'failed' ? (t.error || 'تعذر إكمال التحليل') : (t.summary || 'اكتمل تحليل المنافسين'),
        d.event === 'failed' ? 'bad' : 'ok', 'مدير الحملات');
    }
    setAnalyzing(null);
    reload();
  });

  const analyze = async () => {
    setBusy(true);
    try {
      const t = await api.post('/competitors/analyze');
      setAnalyzing(t.id);
      toast('بدأ مدير الحملات تحليل المنافسين، وستظهر النتائج هنا تلقائيًا');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const saved = (row, isNew) => {
    st.setData((rows) => (isNew ? [...(rows || []), row] : (rows || []).map((x) => (x.id === row.id ? row : x))));
    setEdit(null);
  };
  const removed = (id) => st.setData((rows) => (rows || []).filter((x) => x.id !== id));
  const count = st.data?.length || 0;

  return html`
    <div class="cp-section-head">
      <div class="grow"><h2>منافسوك تحت المجهر</h2>
        <p>يقرأ مدير الحملات حضور كل منافس ومحتواه وعروضه، ويستخرج الفرص التي تتفوق بها عليه. يعتمد على هذه القراءة في كل مقترح حملة.</p></div>
      ${can('proposals') && html`<div class="cp-acts">
        <${Button} icon="plus" onClick=${() => setEdit('new')}>أضف منافسًا</${Button}>
        <${Button} variant="primary" icon="search" loading=${busy} disabled=${!count || !!analyzing} onClick=${analyze}>حلّل المنافسين الآن</${Button}></div>`}
    </div>
    ${analyzing && html`<div class="notice cp-working"><span class="status-dot working" /><div class="grow"><b>مدير الحملات يحلل المنافسين الآن</b>
      يقرأ المنصات والمواقع واحدًا تلو الآخر، وتتحدث البطاقات فور انتهائه.</div></div>`}
    <${Loader} state=${st} skeleton=${html`<${RivalsSkeleton} />`}>${(rows) => (rows.length
      ? html`<div class="cp-rivals">${rows.map((r) => html`<${RivalCard} key=${r.id} r=${r} onEdit=${setEdit} onDeleted=${removed} />`)}</div>`
      : html`<div class="card"><${Empty} icon="users" title="لم تضف منافسين بعد"
          text="أضف منافسيك المباشرين وحساباتهم على المنصات، وسيحللهم مدير الحملات ويستخرج الفرص التي تتفوق بها عليهم."
          action=${can('proposals') && html`<${Button} variant="primary" icon="plus" onClick=${() => setEdit('new')}>أضف أول منافس</${Button}>`} /></div>`)}
    </${Loader}>
    ${edit && html`<${RivalDrawer} key=${edit === 'new' ? 'new' : edit.id} rival=${edit === 'new' ? null : edit} onClose=${() => setEdit(null)} onSaved=${saved} />`}`;
}
