// Page-head actions: ask مدير الحملات for a proposal, or build a manual campaign.
import { html, cls, useState } from '../../lib/h.js';
import { api, useApi } from '../../lib/api.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Field, Toggle, ChannelMark, AgentMark } from '../../ui/core.js';
import { Drawer, Modal, toast } from '../../ui/overlays.js';
import { NumInput, addDays, daysBetween, daysText, isDay, todayIso } from './shared.js';

const IDEAS = ['الجمعة البيضاء', 'موسم الرياض', 'رفع المبيعات قبل نهاية الشهر', 'إطلاق منتج جديد', 'زيادة المتابعين على تيك توك'];

export function ProposeModal({ onClose, onStarted }) {
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const task = await api.post('/campaigns/propose', { focus: focus.trim().slice(0, 600) });
      toast('بدأ مدير الحملات دراسة السوق، وستصلك مقترحاته في تبويب المقترحات خلال دقائق', 'ok', 'وصل طلبك');
      onStarted(task);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return html`<${Modal} title="اطلب مقترح حملة" onClose=${onClose} footer=${html`
    <${Button} variant="primary" icon="wand" loading=${busy} onClick=${send}>اقترح الآن</${Button}>
    <${Button} variant="ghost" onClick=${onClose}>إلغاء</${Button}>`}>
    <div class="cp-intro"><${AgentMark} id="campaigns" size="lg" />
      <p class="small muted">سيدرس مدير الحملات أداء آخر 14 يومًا وتحليل المنافسين والمواسم السعودية القادمة، ثم يعرض عليك حتى 3 مقترحات كاملة بميزانياتها ومؤشراتها.</p></div>
    <${Field} label="ما الذي تريد التركيز عليه؟" help="اختياري. اتركه فارغًا ليختار هو الفرصة الأفضل الآن.">
      <textarea class="textarea" maxLength="600" value=${focus} placeholder="مثال: حملة للجمعة البيضاء تركّز على الرياض وجدة"
        onInput=${(e) => setFocus(e.currentTarget.value)} autofocus /></${Field}>
    <div class="cp-ideas">${IDEAS.map((i) => html`<button type="button" key=${i} class=${cls('chip', focus === i && 'on')} onClick=${() => setFocus(i)}>${i}</button>`)}</div>
  </${Modal}>`;
}

const KPI_FIELDS = [
  ['reach', 'الوصول المستهدف', 'شخص', 1000, true],
  ['engagement_rate', 'معدل التفاعل', '٪', 0.5, false],
  ['leads', 'عملاء محتملون', 'عميل', 1, true],
  ['sales', 'مبيعات', 'عملية', 1, true],
];

function blank() {
  const start = todayIso();
  return { name: '', objective: 'sales', channels: [], audience: '', offer: '', budget_total: 0, daily_budget_cap: 0, posts_per_day: 2,
    start_date: start, end_date: addDays(start, 13), kpis: { reach: 0, engagement_rate: 0, leads: 0, sales: 0 }, pillars: [], launch: false };
}

function validate(f, cap) {
  const e = {};
  if (f.name.trim().length < 2) e.name = 'اكتب اسمًا للحملة (حرفان على الأقل)';
  if (!f.channels.length) e.channels = 'اختر قناة واحدة على الأقل';
  if (typeof cap === 'number' && f.daily_budget_cap > cap) e.daily_budget_cap = `يتجاوز سقف الصرف اليومي العام (${F.money(cap)})`;
  else if (f.budget_total && f.daily_budget_cap > f.budget_total) e.daily_budget_cap = 'السقف اليومي أكبر من الميزانية الكلية';
  if (!isDay(f.start_date)) e.start_date = 'اختر تاريخ البدء';
  if (isDay(f.start_date) && isDay(f.end_date) && f.end_date < f.start_date) e.end_date = 'تاريخ الانتهاء قبل تاريخ البدء';
  return e;
}

export function ManualDrawer({ onClose, onCreated }) {
  const lim = useApi('/limits');
  const cap = lim.data?.limits?.daily_ad_spend_cap;
  const [f, setF] = useState(blank);
  const [pillar, setPillar] = useState('');
  const [err, setErr] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const text = (k) => (e) => { const v = e.currentTarget.value; setF((x) => ({ ...x, [k]: v })); };
  const setKpi = (k) => (v) => setF((x) => ({ ...x, kpis: { ...x.kpis, [k]: v } }));
  const toggleCh = (ch) => setF((x) => ({ ...x, channels: x.channels.includes(ch) ? x.channels.filter((c) => c !== ch) : [...x.channels, ch] }));
  const addPillar = () => {
    const p = pillar.trim().slice(0, 80);
    if (!p) return;
    if (f.pillars.length >= 10) { setErr((x) => ({ ...x, pillars: 'عشرة محاور كحد أقصى' })); return; }
    setF((x) => ({ ...x, pillars: x.pillars.includes(p) ? x.pillars : [...x.pillars, p] }));
    setPillar('');
  };
  const days = daysBetween(f.start_date, f.end_date);
  const span = days !== null && days >= 0 ? days + 1 : null;

  const save = async () => {
    const e = validate(f, cap);
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const kpis = Object.fromEntries(Object.entries(f.kpis).filter(([, v]) => v > 0));
      const out = await api.post('/campaigns', { ...f, name: f.name.trim(), audience: f.audience.trim(), offer: f.offer.trim(), kpis });
      toast(f.launch ? 'أُنشئت الحملة وانطلقت، وبدأ تجهيز منشورات الانطلاق' : 'أُنشئت الحملة معتمدة، وتطلقها متى شئت', 'ok', out.name);
      onCreated(out);
    } catch (er) { toast.error(er); } finally { setBusy(false); }
  };

  return html`<${Drawer} title="حملة يدوية" onClose=${onClose} icon=${html`<span class="mark sm agent"><${Icon} name="megaphone" size="15" /></span>`}
    footer=${html`<${Button} variant="primary" icon=${f.launch ? 'rocket' : 'check'} loading=${busy} onClick=${save}>${f.launch ? 'أنشئ وأطلق الآن' : 'أنشئ الحملة'}</${Button}>
      <${Button} variant="ghost" onClick=${onClose}>إلغاء</${Button}>`}>
    <div class="col gap-16 cp-form">
      <${Field} label="اسم الحملة" error=${err.name}><input class="input" value=${f.name} maxLength="160" placeholder="مثال: عروض الجمعة البيضاء"
        onInput=${text('name')} autofocus /></${Field}>
      <div class="field"><label>هدف الحملة</label>
        <div class="cp-choice" role="radiogroup" aria-label="هدف الحملة">${Object.entries(F.OBJECTIVE).map(([v, l]) => html`<button type="button" key=${v}
          role="radio" aria-checked=${f.objective === v} class=${cls('chip', f.objective === v && 'on')} onClick=${() => set('objective')(v)}>${l}</button>`)}</div></div>
      <div class="field"><label>القنوات</label>
        <div class="cp-choice">${F.CHANNELS.map((ch) => { const on = f.channels.includes(ch); return html`<button type="button" key=${ch}
          aria-pressed=${on} class=${cls('chip cp-ch-chip', on && 'on')} onClick=${() => toggleCh(ch)}><${ChannelMark} ch=${ch} size="sm" />${F.CHANNEL_LABEL[ch]}</button>`; })}</div>
        ${err.channels && html`<span class="error">${err.channels}</span>`}</div>
      <${Field} label="الجمهور" help="من تستهدف؟ المدينة، العمر، الاهتمامات."><textarea class="textarea cp-short" maxLength="2000" value=${f.audience}
        placeholder="مثال: العائلات في الرياض وجدة من 25 إلى 44 سنة" onInput=${text('audience')} /></${Field}>
      <${Field} label="العرض" help="لا تذكر سعرًا لم يُعتمد بعد."><textarea class="textarea cp-short" maxLength="2000" value=${f.offer}
        placeholder="مثال: شحن مجاني للطلبات فوق 200 ريال" onInput=${text('offer')} /></${Field}>
      <div class="grid grid-2">
        <${Field} label="الميزانية الكلية"><${NumInput} value=${f.budget_total} min=${0} step=${50} suffix="ر.س" label="الميزانية الكلية" onChange=${set('budget_total')} /></${Field}>
        <${Field} label="السقف اليومي" error=${err.daily_budget_cap} help=${typeof cap === 'number' ? `لا يتجاوز سقف الصرف العام ${F.money(cap)}` : ''}>
          <${NumInput} value=${f.daily_budget_cap} min=${0} step=${10} suffix="ر.س" label="السقف اليومي" onChange=${set('daily_budget_cap')} /></${Field}>
        <${Field} label="تاريخ البدء" error=${err.start_date}><input class="input ltr" type="date" value=${f.start_date} onInput=${text('start_date')} /></${Field}>
        <${Field} label="تاريخ الانتهاء" error=${err.end_date} help=${span ? `المدة ${daysText(span)}` : ''}>
          <input class="input ltr" type="date" value=${f.end_date} min=${f.start_date} onInput=${text('end_date')} /></${Field}>
        <${Field} label="منشورات يوميًا"><${NumInput} value=${f.posts_per_day} min=${1} max=${50} suffix="يوميًا" label="منشورات يوميًا" onChange=${set('posts_per_day')} /></${Field}>
      </div>
      <div class="field"><label>المؤشرات المستهدفة <span class="faint">(اختياري)</span></label>
        <div class="grid grid-2">${KPI_FIELDS.map(([k, l, sfx, step, int]) => html`<div key=${k} class="cp-kpi-field"><span class="tiny muted">${l}</span>
          <${NumInput} value=${f.kpis[k]} min=${0} step=${step} int=${int} suffix=${sfx} label=${l} onChange=${setKpi(k)} /></div>`)}</div></div>
      <div class="field"><label>محاور المحتوى</label>
        <div class="row gap-6"><input class="input" value=${pillar} maxLength="80" placeholder="مثال: قصص عملاء" aria-label="محور جديد"
          onInput=${(e) => setPillar(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); addPillar(); } }} />
          <${Button} icon="plus" onClick=${addPillar} disabled=${!pillar.trim()}>أضف</${Button}></div>
        ${f.pillars.length > 0 && html`<div class="cp-pills mt-8">${f.pillars.map((p) => html`<span class="cp-pill" key=${p}>${p}
          <button type="button" aria-label=${`إزالة ${p}`} onClick=${() => setF((x) => ({ ...x, pillars: x.pillars.filter((y) => y !== p) }))}><${Icon} name="x" size="12" /></button></span>`)}</div>`}
        ${err.pillars ? html`<span class="error">${err.pillars}</span>` : html`<span class="help">الزوايا التي سيبني عليها صانع المحتوى منشورات الحملة.</span>`}</div>
      <div class="well cp-launch"><div class="grow"><b class="small">أطلقها فورًا</b>
        <p class="tiny muted">تنطلق الحملة الآن ويبدأ صانع المحتوى بتجهيز منشورات الانطلاق. وإلا تُحفظ معتمدة وتطلقها متى شئت.</p></div>
        <${Toggle} checked=${f.launch} label="أطلقها فورًا" onChange=${set('launch')} /></div>
    </div>
  </${Drawer}>`;
}
