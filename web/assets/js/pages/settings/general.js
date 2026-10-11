// الإعدادات › عام والذكاء الاصطناعي: timezone, currency, the public URL, the send window, the AI switches and
// the last 7 days of AI usage. One save bar writes whichever of the two sections changed.
import { html, useMemo } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { can } from '../../lib/store.js';
import { num, usd, AGENT_NAME } from '../../lib/format.js';
import { Icon, Card, Stat, Meter, AgentMark, SimTag, Skeleton, Loader, Empty } from '../../ui/core.js';
import {
  useCachedApi, useForm, check, same, withSection, SettingsForm, Head, ReadOnly, TextField, SelectField, SwitchRow, GoLink,
  AGENT_ORDER, HHMM,
} from './kit.js';

const USAGE_DAYS = 7;
// Mirrors settings.General.public_base_url: an origin only (no path or query); plain http for local testing only.
const ORIGIN = /^(https:\/\/[A-Za-z0-9.-]+(:\d{2,5})?|http:\/\/(localhost|127\.0\.0\.1)(:\d{2,5})?)$/;
const ZONES = [
  ['Asia/Riyadh', 'الرياض (السعودية)'], ['Asia/Dubai', 'دبي (الإمارات)'], ['Asia/Kuwait', 'الكويت'],
  ['Asia/Qatar', 'الدوحة (قطر)'], ['Asia/Bahrain', 'المنامة (البحرين)'], ['Asia/Muscat', 'مسقط (عُمان)'],
  ['Africa/Cairo', 'القاهرة (مصر)'],
];
const CURRENCIES = [
  ['SAR', 'ريال سعودي (SAR)'], ['AED', 'درهم إماراتي (AED)'], ['KWD', 'دينار كويتي (KWD)'], ['QAR', 'ريال قطري (QAR)'],
  ['BHD', 'دينار بحريني (BHD)'], ['OMR', 'ريال عُماني (OMR)'], ['EGP', 'جنيه مصري (EGP)'], ['USD', 'دولار أمريكي (USD)'],
];

function validate({ general: g }) {
  const errors = {};
  const url = cleanUrl(g.public_base_url);
  if (url && !ORIGIN.test(url)) {
    errors.public_base_url = /^https?:\/\/[^/]+\/./.test(url) || url.includes('?')
      ? 'اكتب أصل الرابط فقط دون مسار أو استعلام، مثل https://marketing.company.sa'
      : 'أدخل رابطًا يبدأ بـ https:// ثم النطاق، ويمكن إضافة المنفذ مثل :8443';
  }
  ['send_window_start', 'send_window_end'].forEach((k) => { if (!HHMM.test(g[k] || '')) errors[k] = 'اختر وقتًا صحيحًا'; });
  if (!errors.send_window_end && g.send_window_start === g.send_window_end) errors.send_window_end = 'يجب أن تختلف النهاية عن البداية';
  return errors;
}

const cleanUrl = (v) => v.trim().replace(/\/+$/, '');
const cleanGeneral = (g) => ({ ...g, public_base_url: cleanUrl(g.public_base_url) });

function GeneralForm({ initial, onSaved }) {
  const f = useForm(initial);
  const g = f.draft.general;
  const ai = f.draft.ai;
  const submit = () => {
    if (!same(g, f.saved.general) && !check(f, validate(f.draft))) return; // never block an AI-only save on untouched fields
    f.save(async () => {
      const general = same(g, f.saved.general) ? f.saved.general : await api.put('/settings/general', cleanGeneral(g));
      const nextAi = same(ai, f.saved.ai) ? f.saved.ai : await api.put('/settings/ai', ai);
      onSaved(general, nextAi);
      return { general, ai: nextAi };
    }, 'حُفظت الإعدادات العامة');
  };
  const httpOnly = /^http:\/\//i.test(g.public_base_url.trim());
  const owner = can('owner'); // timezone, public URL and send window are owner-only on the server; AI stays manager+
  return html`<${SettingsForm} form=${f} onSubmit=${submit} canEdit=${can('manager')}>
    <fieldset class="st-fieldset" disabled=${!owner}>
    ${!owner && can('manager') && html`<div class="notice st-ro"><${Icon} name="lock" size="17" /><div class="grow">المنطقة والعملة والرابط
      العام ونافذة الإرسال يغيّرها المالك فقط. إعدادات الذكاء الاصطناعي أدناه متاحة لك.</div></div>`}
    <${Card} title="المنطقة والعملة" icon="globe">
      <div class="st-grid">
        <${SelectField} label="المنطقة الزمنية" options=${ZONES} value=${g.timezone} error=${f.errors.timezone}
          onChange=${(v) => f.setIn('general', 'timezone', v)} help="تُحسب بها مواعيد الجداول والتقرير اليومي ونافذة الإرسال." />
        <${SelectField} label="العملة" options=${CURRENCIES} value=${g.currency} error=${f.errors.currency}
          onChange=${(v) => f.setIn('general', 'currency', v)} help="عملة الميزانيات والصرف في الحملات." />
      </div>
    </${Card}>

    <${Card} title="الرابط العام للمنصة" icon="link">
      <${TextField} label="الرابط العام" ltr type="url" inputMode="url" maxLength=${300} value=${g.public_base_url}
        onInput=${(e) => f.setIn('general', 'public_base_url', e.currentTarget.value)} error=${f.errors.public_base_url}
        placeholder="https://marketing.company.sa"
        help="اكتب أصل الرابط فقط دون مسار أو استعلام: النطاق، ومعه المنفذ عند الحاجة. يسحب منه إنستقرام وتيك توك الصور والمقاطع عند النشر، وتستدعيه Meta لتوصيل الرسائل والتعليقات." />
      ${httpOnly && html`<div class="notice warn mt-12"><${Icon} name="alert" size="17" /><div class="grow">تشترط Meta وتيك توك رابطًا
        يبدأ بـ <span class="ltr">https://</span>، فلن يعمل النشر الحقيقي ولا الويب هوك بهذا الرابط.</div></div>`}
    </${Card}>

    <${Card} title="نافذة الإرسال" icon="clock">
      <p class="small muted">لا تُرسل رسائل واتساب الجماعية والتسويقية خارج هذه الساعات. الافتراضي في السعودية من 09:00 إلى 22:00.</p>
      <div class="st-range mt-12">
        <${TextField} label="من" type="time" ltr value=${g.send_window_start} error=${f.errors.send_window_start}
          onInput=${(e) => f.setIn('general', 'send_window_start', e.currentTarget.value)} />
        <${TextField} label="إلى" type="time" ltr value=${g.send_window_end} error=${f.errors.send_window_end}
          onInput=${(e) => f.setIn('general', 'send_window_end', e.currentTarget.value)} />
      </div>
    </${Card}>
    </fieldset>

    <${Card} title="الذكاء الاصطناعي" icon="brain">
      <${SwitchRow} title="البحث في الويب" checked=${ai.web_research} onChange=${(v) => f.setIn('ai', 'web_research', v)}
        text="يبحث مدير الحملات في الويب عن المنافسين وأحوال السوق قبل اقتراح الحملات. يضيف نحو $0.01 لكل عملية بحث." />
      <${SwitchRow} title="البديل التلقائي عند الرفض" checked=${ai.fallbacks} onChange=${(v) => f.setIn('ai', 'fallbacks', v)}
        text="إذا رفض النموذج طلبًا، يعيد خادم Anthropic المحاولة تلقائيًا بنموذج بديل بدل أن تتوقف المهمة. يُنصح بإبقائه مفعّلًا." />
      <div class="notice mt-12"><${Icon} name="coins" size="17" /><div class="grow">السقف اليومي لتكلفة الذكاء الاصطناعي يُضبط مع
        بقية الليمت في <${GoLink} href="/campaigns?tab=limits">لوحة الليمت</${GoLink}>. عند بلوغه تتوقف الاستدعاءات الجديدة حتى اليوم التالي.</div></div>
    </${Card}>
  </${SettingsForm}>`;
}

function Usage() {
  const st = useCachedApi(`/usage?days=${USAGE_DAYS}`);
  return html`<${Card} title=${`استهلاك الذكاء الاصطناعي، آخر ${num(USAGE_DAYS)} أيام`} icon="activity"
    actions=${st.data && !st.data.live && html`<${SimTag} title="الشبكة في وضع المحاكاة: لا تُحتسب تكلفة حقيقية" />`}>
    <${Loader} state=${st} skeleton=${html`<${Skeleton} lines=${4} h=${22} />`}>${(u) => {
      const rows = Object.entries(u.by_agent || {}).map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => b.cost_usd - a.cost_usd || AGENT_ORDER.indexOf(a.id) - AGENT_ORDER.indexOf(b.id));
      const top = Math.max(...rows.map((r) => r.cost_usd), 0.0001);
      return html`<div class="st-usage-stats">
          <${Stat} label="التكلفة" value=${usd(u.cost_usd)} icon="coins" />
          <${Stat} label="الاستدعاءات" value=${num(u.calls)} icon="cpu" />
          <${Stat} label="المتوسط اليومي" value=${usd((u.cost_usd || 0) / USAGE_DAYS)} icon="calendar" />
        </div>
        ${rows.length ? html`<div class="st-usage mt-16">${rows.map((r) => html`<div class="st-urow-ai" key=${r.id}>
            ${AGENT_ORDER.includes(r.id) ? html`<${AgentMark} id=${r.id} size="sm" />` : html`<span class="mark sm"><${Icon} name="cpu" size="14" /></span>`}
            <span class="st-usage-name ellipsis">${AGENT_NAME[r.id] || 'النظام'}</span>
            <${Meter} value=${r.cost_usd} max=${top} />
            <span class="num st-usage-v">${usd(r.cost_usd)}</span>
            <span class="tiny faint st-usage-c">${num(r.calls)} استدعاء</span>
          </div>`)}</div>`
          : html`<${Empty} icon="activity" title="لا استدعاءات بعد" text="ستظهر هنا تكلفة كل وكيل بعد أن يبدأ العمل بمفتاح Claude." />`}`;
    }}</${Loader}>
  </${Card}>`;
}

function Skel() {
  return html`<div class="col gap-16">${[120, 150, 120, 200].map((h) => html`<div class="card pad"><${Skeleton} h=${h} /></div>`)}</div>`;
}

export default function GeneralTab() {
  const st = useCachedApi('/settings');
  const initial = useMemo(() => st.data && ({ general: st.data.sections.general, ai: st.data.sections.ai }), [st.data]);
  const onSaved = (general, ai) => st.setData((d) => withSection('ai', ai)(withSection('general', general)(d)));
  return html`<${Head} title="عام والذكاء الاصطناعي" text="إعدادات تشغيل الشبكة: التوقيت والرابط العام ونافذة الإرسال، وكيف يستخدم الوكلاء Claude." />
    ${!can('manager') && html`<${ReadOnly} />`}
    <${Loader} state=${st} skeleton=${html`<${Skel} />`}>${() => html`<${GeneralForm} initial=${initial} onSaved=${onSaved} />`}</${Loader}>
    <div class="mt-24"><${Usage} /></div>`;
}
