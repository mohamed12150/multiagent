// الإعدادات › أهداف القائد: the monthly targets القائد steers toward, when it reviews, how many interventions it may
// make a day, and — in one place — whether it acts alone, files a plan for approval, or only observes.
import { html, useMemo, useState } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { can } from '../../lib/store.js';
import { Icon, Card, Skeleton, Loader } from '../../ui/core.js';
import { toast } from '../../ui/overlays.js';
import { useCachedApi, useForm, check, withSection, SettingsForm, Head, ReadOnly, TextField, SelectField, PermControl,
  HHMM } from './kit.js';
import { MODE } from '../network/steering.js';
import { PERM_VALUE } from '../../lib/format.js';

const FOCUS_OPTIONS = [['leads', 'العملاء المحتملون'], ['sales', 'المبيعات'], ['engagement', 'التفاعل'], ['awareness', 'الوصول والانتشار']];
const NUMERIC = ['monthly_leads', 'monthly_reach', 'target_engagement_rate', 'max_daily_interventions'];
const LIMITS = { monthly_leads: 1e6, monthly_reach: 1e9, target_engagement_rate: 100, max_daily_interventions: 50 };

function validate(d) {
  const errors = {};
  NUMERIC.forEach((k) => {
    const v = Number(d[k]);
    if (d[k] === '' || !Number.isFinite(v) || v < 0 || v > LIMITS[k]) errors[k] = `رقم من 0 إلى ${LIMITS[k].toLocaleString('ar')}`;
  });
  ['review_start', 'review_end'].forEach((k) => { if (!HHMM.test(d[k] || '')) errors[k] = 'اختر وقتًا صحيحًا'; });
  return errors;
}

const clean = (d) => ({ ...d, notes: d.notes.trim(), ...Object.fromEntries(NUMERIC.map((k) => [k, Number(d[k])])),
  monthly_leads: Math.round(Number(d.monthly_leads)), monthly_reach: Math.round(Number(d.monthly_reach)),
  max_daily_interventions: Math.round(Number(d.max_daily_interventions)) });

function Authority({ value, onChange, busy, editable }) {
  const [label, , hint] = MODE[value] || MODE.off;
  return html`<${Card} title="صلاحية القائد في التدخل" icon="crown">
    <p class="small muted">هل يعدّل القائد الحملات والسعة بنفسه عندما تتأخر النتائج؟ يبقى دائمًا داخل الليمت وسقف صلاحية الرفع،
      ولا يزيد الصرف الكلي إلا بنقل الميزانية بين الحملات.</p>
    <div class="row wrap between gap-16 mt-12">
      <div><b>${label}</b><p class="tiny faint">${hint}</p></div>
      <${PermControl} value=${value} onChange=${onChange} busy=${busy} disabled=${!editable} label="صلاحية التدخل المستقل" />
    </div>
    <ul class="st-bullets mt-12 small muted">
      <li>يوقف الحملة التي تستنزف الميزانية بعد 3 أيام على الأقل من انطلاقها.</li>
      <li>ينقل الميزانية اليومية من الحملة الأضعف عائدًا إلى الأقوى.</li>
      <li>يرفع سعة القناة أو منشورات الحملة الرابحة ضمن خطوة الرفع والسقف.</li>
      <li>يكلّف صانع المحتوى ووكلاء القنوات ومدير الحملات بما يسد الفجوة.</li>
    </ul>
  </${Card}>`;
}

function GoalsForm({ initial, onSaved }) {
  const f = useForm(initial);
  const d = f.draft;
  const submit = () => {
    if (!check(f, validate(d))) return;
    f.save(async () => {
      const obj = await api.put('/settings/goals', clean(d));
      onSaved(obj);
      return obj;
    }, 'حُفظت أهداف القائد');
  };
  const num = (key, label, help, extra = {}) => html`<${TextField} label=${label} ltr inputMode="decimal" value=${d[key]}
    onInput=${(e) => f.set(key, e.currentTarget.value.replace(/[^\d.]/g, ''))} error=${f.errors[key]} help=${help} ...${extra} />`;
  return html`<${SettingsForm} form=${f} onSubmit=${submit} canEdit=${can('autonomy')}>
    <${Card} title="أهداف الشهر" icon="target">
      <div class="st-grid">
        <${SelectField} label="هدف التركيز" options=${FOCUS_OPTIONS} value=${d.focus} onChange=${(v) => f.set('focus', v)}
          help="يوجّه القائد كل خطة يومية وكل تدخل نحو هذا الهدف أولًا." />
        ${num('monthly_leads', 'العملاء المحتملون شهريًا', 'محادثات يصنّفها صانع المحتوى «فرصة بيع».')}
        ${num('monthly_reach', 'الوصول الشهري', 'مجموع وصول المنشورات المنشورة في الشهر.')}
        ${num('target_engagement_rate', 'معدل التفاعل المستهدف ٪', 'التفاعل ÷ الوصول.')}
      </div>
    </${Card}>
    <${Card} title="المراجعة والتدخل" icon="compass">
      <div class="st-grid">
        <${TextField} label="تبدأ المراجعة" type="time" ltr ...${f.bind('review_start')} error=${f.errors.review_start} />
        <${TextField} label="تنتهي المراجعة" type="time" ltr ...${f.bind('review_end')} error=${f.errors.review_end}
          help="يراجع القائد الأداء كل 3 ساعات داخل هذه الساعات فقط." />
        ${num('max_daily_interventions', 'حد التدخلات اليومية', 'ما يزيد يُسجَّل «أُجّل» ويُعاد النظر فيه غدًا. أوامرك لا تُحسب.')}
      </div>
      <div class="mt-16"><${TextField} area label="توجيهاتك للقائد" maxLength=${1500} counter rows="4" ...${f.bind('notes')}
        error=${f.errors.notes} placeholder="مثال: ركّز هذا الشهر على باقات الشركات في الرياض، ولا توقف حملة رمضان مهما كانت النتائج."
        help="يقرؤها القائد في كل مراجعة كأولوية منك." /></div>
    </${Card}>
  </${SettingsForm}>`;
}

export default function GoalsTab() {
  const st = useCachedApi('/settings');
  const ceo = useCachedApi('/agents/ceo');
  const [busy, setBusy] = useState(false);
  const initial = useMemo(() => st.data?.sections?.goals, [st.data]);
  const intervene = ceo.data?.permissions?.intervene || st.data?.presets?.[st.data?.sections?.autonomy?.level]?.intervene || 'approve';
  const change = async (value) => {
    setBusy(true);
    try {
      await api.patch('/agents/ceo', { permissions: { intervene: value } });
      ceo.setData((a) => a && ({ ...a, permissions: { ...a.permissions, intervene: value } }));
      toast(`القائد: التدخل المستقل ← ${PERM_VALUE[value]}`);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return html`<${Head} title="أهداف القائد"
    text="القائد لا يكتفي بالاقتراح: يقيس الشهر مقابل هذه الأهداف ويتدخل لتحقيق أفضل نتيجة ضمن الصلاحية التي تمنحها." />
    ${!can('autonomy') && html`<${ReadOnly} cap="autonomy" />`}
    <${Authority} value=${intervene} onChange=${change} busy=${busy} editable=${can('autonomy')} />
    <div class="notice st-goal-note"><${Icon} name="info" size="17" /><div class="grow">تغيير مستوى الاستقلالية العام يعيد ضبط هذه
      الصلاحية حسب المستوى: يدوي ← باعتمادك، شبه آلي وطيار آلي ← تلقائي.</div></div>
    <${Loader} state=${st} skeleton=${html`<div class="card pad"><${Skeleton} h=${260} /></div>`}>${() => initial
      ? html`<${GoalsForm} initial=${initial} onSaved=${(obj) => st.setData(withSection('goals', obj))} />`
      : html`<p class="muted small">لم تُحمَّل الأهداف.</p>`}</${Loader}>`;
}
