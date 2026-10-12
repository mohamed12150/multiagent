// الإعدادات › الإشعارات والتقارير: who receives the daily report and alerts, on which channels, when, and the
// WhatsApp template that reaches the owner outside Meta's 24-hour window.
import { html, useMemo } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { can } from '../../lib/store.js';
import { Icon, Card, Skeleton, Loader } from '../../ui/core.js';
import {
  useCachedApi, useForm, check, withSection, SettingsForm, Head, ReadOnly, TextField, ChipsField, CheckGroup, Labeled,
  EMAIL, HHMM,
} from './kit.js';

const OPT = {
  app: { value: 'app', label: 'داخل المنصة', icon: 'bell' },
  whatsapp: { value: 'whatsapp', label: 'واتساب', icon: 'whatsapp' },
  email: { value: 'email', label: 'البريد', icon: 'mail' },
};
const REPORT_OPTS = [OPT.whatsapp, OPT.email];
const ALERT_OPTS = [OPT.app, OPT.whatsapp, OPT.email];
const LANGS = ['ar', 'en', 'en_US'];
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Digits only (Arabic-Indic digits become Latin), no '+' and no leading 00. */
const toDigits = (v) => v.replace(/[٠-٩]/g, (c) => String(ARABIC_DIGITS.indexOf(c))).replace(/\D/g, '').replace(/^00/, '');

function validate(d) {
  const errors = {};
  if (d.owner_whatsapp && !/^[1-9]\d{7,14}$/.test(d.owner_whatsapp)) {
    errors.owner_whatsapp = d.owner_whatsapp.startsWith('0') ? 'ابدأ برمز الدولة بدل الصفر، مثل 9665XXXXXXXX' : 'رقم غير صحيح: 8 إلى 15 رقمًا مع رمز الدولة';
  }
  ['report_time', 'quiet_start', 'quiet_end'].forEach((k) => { if (!HHMM.test(d[k] || '')) errors[k] = 'اختر وقتًا صحيحًا'; });
  if (d.whatsapp_template.trim() && !/^[a-z0-9_]+$/.test(d.whatsapp_template.trim())) {
    errors.whatsapp_template = 'اسم القالب كما في Meta: أحرف إنجليزية صغيرة وأرقام وشرطة سفلية';
  }
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(d.whatsapp_template_lang.trim() || 'ar')) {
    errors.whatsapp_template_lang = 'رمز لغة مثل ar أو en_US';
  }
  return errors;
}

const clean = (d) => ({ ...d, owner_name: d.owner_name.trim(), whatsapp_template: d.whatsapp_template.trim(),
  whatsapp_template_lang: d.whatsapp_template_lang.trim() || 'ar' });

/** Non-blocking hints: a channel is chosen but its address is missing. */
function gaps(d) {
  const uses = (ch) => [d.report_channels, d.fix_channels, d.approval_channels].some((list) => list.includes(ch));
  return [
    uses('whatsapp') && !d.owner_whatsapp && 'اخترت واتساب لبعض الإشعارات، لكن رقم واتساب المالك فارغ.',
    uses('email') && !d.owner_emails.length && 'اخترت البريد لبعض الإشعارات، لكن لا يوجد بريد مستلم.',
  ].filter(Boolean);
}

function NotifyForm({ initial, onSaved }) {
  const f = useForm(initial);
  const d = f.draft;
  const submit = () => {
    if (!check(f, validate(d))) return;
    f.save(async () => {
      const obj = await api.put('/settings/notify', clean(d));
      onSaved(obj);
      return obj;
    }, 'حُفظت إعدادات الإشعارات والتقارير');
  };
  const warnings = gaps(d);
  return html`<${SettingsForm} form=${f} onSubmit=${submit} canEdit=${can('notify')}>
    <${Card} title="المستلم" icon="user">
      <div class="st-grid">
        <${TextField} label="اسم المالك" maxLength=${120} ...${f.bind('owner_name')} error=${f.errors.owner_name}
          help="يُخاطَب به في التقرير اليومي والتنبيهات." />
        <${TextField} label="رقم واتساب المالك" ltr inputMode="numeric" maxLength=${20} value=${d.owner_whatsapp}
          onInput=${(e) => f.set('owner_whatsapp', toDigits(e.currentTarget.value))} error=${f.errors.owner_whatsapp}
          placeholder="9665XXXXXXXX" help="من 8 إلى 15 رقمًا مع رمز الدولة ودون علامة +، مثل 966512345678." />
      </div>
      <div class="mt-16">
        <${ChipsField} label="البريد المستلم" ltr values=${d.owner_emails} max=${5} onChange=${(v) => f.set('owner_emails', v)}
          normalize=${(v) => v.trim().toLowerCase()} validate=${(v) => EMAIL.test(v)} invalidText="بريد غير صحيح"
          error=${f.errors.owner_emails} placeholder="name@company.sa" help="حتى خمسة عناوين. اضغط Enter بعد كل عنوان." />
      </div>
      ${warnings.map((w) => html`<div class="notice warn mt-12"><${Icon} name="info" size="17" /><div class="grow">${w}</div></div>`)}
    </${Card}>

    <${Card} title="التقرير اليومي" icon="chart">
      <div class="st-grid">
        <${TextField} label="وقت التقرير" type="time" ltr ...${f.bind('report_time')} error=${f.errors.report_time}
          help="يصلك تقرير الإنجاز يوميًا في هذا الوقت." />
        <${Labeled} label="يصلك عبر" help="يصل التقرير دائمًا، حتى في ساعات الهدوء.">
          <${CheckGroup} label="قنوات التقرير" options=${REPORT_OPTS} values=${d.report_channels}
            onChange=${(v) => f.set('report_channels', v)} /></${Labeled}>
      </div>
    </${Card}>

    <${Card} title="التنبيهات" icon="bell">
      <div class="st-grid">
        <${Labeled} label="الأعطال والإصلاحات" help="حين يكتشف الحارس خطأ أو يحتاج اعتمادك لإصلاح.">
          <${CheckGroup} label="قنوات تنبيهات الإصلاح" options=${ALERT_OPTS} values=${d.fix_channels}
            onChange=${(v) => f.set('fix_channels', v)} /></${Labeled}>
        <${Labeled} label="طلبات الاعتماد" help="حين يرسل وكيل محتوى أو حملة أو صرفًا لمكتب الاعتماد.">
          <${CheckGroup} label="قنوات طلبات الاعتماد" options=${ALERT_OPTS} values=${d.approval_channels}
            onChange=${(v) => f.set('approval_channels', v)} /></${Labeled}>
      </div>
      <div class="st-quiet mt-16">
        <div class="grow"><b class="small">ساعات الهدوء</b>
          <p class="help">لا تصلك رسائل واتساب أو بريد غير عاجلة خلال هذه الفترة. التقرير والتنبيهات العاجلة تصل دائمًا، وتبقى كل
            الإشعارات داخل المنصة.</p></div>
        <div class="st-range">
          <${TextField} label="من" type="time" ltr ...${f.bind('quiet_start')} error=${f.errors.quiet_start} />
          <${TextField} label="إلى" type="time" ltr ...${f.bind('quiet_end')} error=${f.errors.quiet_end} />
        </div>
      </div>
    </${Card}>

    <${Card} title="قالب واتساب المعتمد" icon="whatsapp">
      <div class="notice"><${Icon} name="info" size="17" /><div class="grow"><b>قاعدة الـ24 ساعة في واتساب</b>
        الرسائل النصية الحرة تصلك فقط خلال 24 ساعة من آخر رسالة أرسلتها أنت إلى رقم الأعمال. خارج هذه النافذة تشترط Meta قالبًا
        معتمدًا من فئة الخدمات (Utility). أنشئ القالب في <span class="ltr">WhatsApp Manager</span> بمتغير واحد
        <span class="ltr mono">{{1}}</span> يحمل نص الرسالة، ثم اكتب اسمه هنا ليصلك التقرير في أي وقت.</div></div>
      <div class="st-grid mt-16">
        <${TextField} label="اسم القالب" ltr maxLength=${60} ...${f.bind('whatsapp_template')} error=${f.errors.whatsapp_template}
          placeholder="daily_report" help="اتركه فارغًا لتصلك الرسائل داخل نافذة الـ24 ساعة فقط." spellcheck=${false} />
        <${TextField} label="لغة القالب" ltr maxLength=${10} list="st-tpl-langs" ...${f.bind('whatsapp_template_lang')}
          error=${f.errors.whatsapp_template_lang} placeholder="ar" help="رمز اللغة كما سُجّل القالب، مثل ar أو en_US." />
        <datalist id="st-tpl-langs">${LANGS.map((x) => html`<option value=${x} />`)}</datalist>
      </div>
    </${Card}>
  </${SettingsForm}>`;
}

function Skel() {
  return html`<div class="col gap-16">${[170, 120, 190, 200].map((h) => html`<div class="card pad"><${Skeleton} h=${h} /></div>`)}</div>`;
}

export default function NotificationsTab() {
  const st = useCachedApi('/settings');
  const initial = useMemo(() => st.data?.sections?.notify, [st.data]);
  return html`<${Head} title="الإشعارات والتقارير"
    text="اختر من يستلم تقرير الإنجاز والتنبيهات، وعبر أي قناة، وفي أي وقت. يرسلها المنسّق والحارس نيابة عن الشبكة." />
    ${!can('notify') && html`<${ReadOnly} cap="notify" />`}
    <${Loader} state=${st} skeleton=${html`<${Skel} />`}>${() => html`<${NotifyForm} initial=${initial}
      onSaved=${(obj) => st.setData(withSection('notify', obj))} />`}</${Loader}>`;
}
