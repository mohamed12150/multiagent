// الإعدادات › الربط: Claude, the five channel accounts and SMTP. Each provider card expands into its fields
// (secrets stay on the server; only a 4-character hint comes back), sandbox/live mode, test and removal.
import { html, cls, useMemo, useState } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { setQuery } from '../../lib/router.js';
import { compact, num, ago } from '../../lib/format.js';
import { Icon, Button, Badge, SimTag, Card, Stat, Seg, Skeleton, Loader, Empty } from '../../ui/core.js';
import { toast, confirm } from '../../ui/overlays.js';
import { useCachedApi, useForm, check, without, Head, TextField, CopyField, GoLink, confirmLeave } from './kit.js';

const GROUPS = [
  { id: 'ai', label: 'العقل', text: 'المفتاح الذي يشغّل تفكير الوكلاء العشرة.' },
  { id: 'channel', label: 'القنوات', text: 'حسابات النشر والتفاعل. يدير كل قناة وكيلها.' },
  { id: 'delivery', label: 'التوصيل', text: 'البريد الذي يصلك عبره التقرير والتنبيهات.' },
];
const ICON = { anthropic: 'brain', instagram: 'instagram', tiktok: 'tiktok', x: 'xlogo', whatsapp: 'whatsapp', linkedin: 'linkedin', email: 'mail' };
const RTL_FIELDS = new Set(['from_name']);
const DIGITS_ID = [/^\d{5,25}$/, 'أرقام فقط كما تظهر في لوحة Meta'];
// Mirrors connectors.catalog.PATTERNS so the owner sees the reason before the server refuses the value.
const RULES = {
  graph_version: [/^v\d{1,2}\.\d$/, 'الصيغة مثل v24.0'],
  api_version: [/^\d{6}$/, 'ستة أرقام بصيغة YYYYMM، مثل 202509'],
  ig_user_id: DIGITS_ID, page_id: DIGITS_ID, phone_number_id: DIGITS_ID, waba_id: DIGITS_ID,
  author_urn: [/^urn:li:(organization|person):[A-Za-z0-9_-]{1,40}$/, 'الصيغة مثل urn:li:organization:12345678'],
  smtp_port: [/^\d{2,5}$/, 'رقم المنفذ، مثل 587 أو 465'],
  security: [/^(starttls|ssl)$/, 'اكتب starttls أو ssl'],
  smtp_host: [/^[A-Za-z0-9.-]{3,253}$/, 'اسم خادم صحيح، مثل smtp.office365.com'],
  broadcast_template: [/^[a-z0-9_]{1,512}$/, 'اسم القالب كما في Meta: أحرف إنجليزية صغيرة وأرقام وشرطة سفلية'],
};
const PRIVATE_HOST = /^(localhost|.*\.(local|localhost|internal)|[^.]*|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0)$/i;
const PUBLIC_HOST_TEXT = 'خادم البريد يجب أن يكون عنوانًا عامًا، لا عنوانًا محليًا أو داخليًا';
const EMAIL_ANCHORS = ['smtp_host', 'smtp_port', 'username']; // changing these without the password clears the stored one

/** Client checks for the plain fields (only non-empty values; required-ness is checked separately for live mode). */
function fieldProblems(id, config) {
  return Object.fromEntries(Object.entries(config).flatMap(([k, raw]) => {
    const v = String(raw || '').trim();
    if (!v) return [];
    const rule = RULES[k];
    if (rule && !rule[0].test(v)) return [[k, rule[1]]];
    if (id === 'email' && k === 'smtp_host' && PRIVATE_HOST.test(v.replace(/\.$/, ''))) return [[k, PUBLIC_HOST_TEXT]];
    return [];
  }));
}

/** Server refusals that name fields: "قيمة غير صالحة: a, b", "أكمل الحقول المطلوبة قبل التفعيل: a، b", private SMTP host. */
function connError(err) {
  if (err.code === 'private_host') return { smtp_host: PUBLIC_HOST_TEXT };
  if (err.code !== 'bad_value' && err.code !== 'missing_fields') return null;
  const keys = (err.message.split(':')[1] || '').split(/[,،]/).map((k) => k.trim()).filter(Boolean);
  const text = err.code === 'bad_value' ? 'قيمة غير مقبولة لهذا الحقل' : 'مطلوب للربط المباشر';
  return Object.fromEntries(keys.map((k) => [k, text]));
}
const MODE_OPTIONS = [{ value: 'sandbox', label: 'محاكاة' }, { value: 'live', label: 'مباشر' }];

const modeText = (id, mode) => {
  if (mode === 'sandbox') {
    return id === 'anthropic'
      ? 'محاكاة: يعمل الوكلاء بعقل تجريبي دون تكلفة، ومخرجاتهم موسومة بـ«محاكاة».'
      : 'محاكاة: يواصل الوكيل عمله على بيانات تجريبية، ولا يصل شيء إلى حسابك الحقيقي.';
  }
  return id === 'anthropic'
    ? 'مباشر: يفكر الوكلاء بـ Claude الحقيقي، وتُحتسب التكلفة على حسابك في Anthropic.'
    : 'مباشر: ينشر الوكيل ويقرأ من حسابك الحقيقي بعد نجاح اختبار الاتصال.';
};

const formOf = (c) => ({
  config: Object.fromEntries(c.fields.filter((fl) => !fl.secret).map((fl) => [fl.key, c.config[fl.key] ?? fl.default ?? ''])),
  secrets: Object.fromEntries(c.fields.filter((fl) => fl.secret).map((fl) => [fl.key, ''])),
  mode: c.mode,
});

function StatusTag({ c }) {
  if (c.mode === 'sandbox') {
    return html`<${SimTag} title="وضع المحاكاة: يعمل الوكيل على بيانات تجريبية حتى تفعّل الربط المباشر" />
      ${c.status === 'connected' && html`<${Badge} tone="outline" icon="checkCircle">الاختبار ناجح، جاهز للتفعيل</${Badge}>`}`;
  }
  if (c.status === 'connected') return html`<${Badge} tone="ok" icon="checkCircle">متصل</${Badge}>`;
  if (c.status === 'error') return html`<${Badge} tone="bad" icon="alert">خطأ في الاتصال</${Badge}>`;
  return html`<${Badge} tone="warn" icon="clock">مباشر، بانتظار الاختبار</${Badge}>`;
}

function Account({ c }) {
  const a = c.account || {};
  const bits = [
    a.name && html`<span>${a.name}</span>`,
    a.handle && html`<span class="ltr">@${String(a.handle).replace(/^@/, '')}</span>`,
    a.followers ? html`<span>${compact(a.followers)} متابع</span>` : null,
    c.last_checked_at && html`<span class="faint">آخر اختبار ${ago(c.last_checked_at)}</span>`,
  ].filter(Boolean);
  if (!bits.length) return null;
  return html`<p class="st-acct tiny muted">${bits.map((b, i) => html`${i > 0 && html`<span class="st-sep" aria-hidden="true">·</span>`}${b}`)}</p>`;
}

function WebhookBox() {
  const st = useCachedApi('/webhooks');
  return html`<div class="st-hook">
    <div class="row gap-6"><span class="mark sm agent"><${Icon} name="webhook" size="15" /></span>
      <b class="small">استقبال الرسائل والتعليقات لحظيًا (Webhook)</b></div>
    <${Loader} state=${st} skeleton=${html`<div class="mt-12"><${Skeleton} lines=${2} h=${40} /></div>`}>${(w) => html`
      <div class="st-grid mt-12">
        <${CopyField} label="رابط الاستدعاء (Callback URL)" value=${w.meta_url} />
        <${CopyField} label="رمز التحقق (Verify token)" value=${w.verify_token} />
      </div>
      ${!/^https:\/\//.test(w.meta_url) && html`<div class="notice warn mt-12"><${Icon} name="alert" size="17" />
        <div class="grow">تقبل Meta روابط HTTPS العامة فقط. اضبط الرابط العام للمنصة من
          <${GoLink} href="/settings/general">عام والذكاء الاصطناعي</${GoLink}> ثم انسخ الرابط من جديد.</div></div>`}
      <ol class="st-steps">
        <li>في <span class="ltr">Meta for Developers</span> افتح تطبيقك، ثم اختر <b class="ltr">Webhooks</b>.</li>
        <li>الصق رابط الاستدعاء ورمز التحقق، ثم اضغط <b class="ltr">Verify and save</b>.</li>
        <li>اشترك في الحقول: <span class="ltr mono">${(w.fields || []).join(', ')}</span>.</li>
      </ol>`}</${Loader}>
  </div>`;
}

function SecretInput({ fl, hint, value, error, onInput }) {
  const [show, setShow] = useState(false);
  const help = html`${hint && html`<span class="st-saved"><${Icon} name="lock" size="12" />محفوظ <span class="ltr num">${hint}</span>، اتركه فارغًا للإبقاء عليه</span>`}
    ${fl.help && html`<span class="st-fhelp">${fl.help}</span>`}`;
  const eye = html`<button type="button" class="st-eye" aria-label=${show ? 'إخفاء' : 'إظهار'} aria-pressed=${show}
    onClick=${() => setShow(!show)}><${Icon} name=${show ? 'eyeOff' : 'eye'} size="15" /></button>`;
  return html`<${TextField} label=${fl.label} required=${fl.required && !hint} ltr type=${show ? 'text' : 'password'} value=${value}
    autocomplete="new-password" spellcheck=${false} maxLength=${2000} error=${error} help=${help} extra=${eye}
    placeholder=${hint ? 'اتركه فارغًا للإبقاء على المحفوظ' : fl.placeholder} onInput=${onInput} />`;
}

function ConnEditor({ c, onChange }) {
  const initial = useMemo(() => formOf(c), [c]);
  const f = useForm(initial);
  const d = f.draft;
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const setCfg = (k, v) => { f.set('config', { ...d.config, [k]: v }); f.setErrors((e) => without(e, k)); };
  const setSecret = (k, v) => { f.set('secrets', { ...d.secrets, [k]: v }); f.setErrors((e) => without(e, k)); };
  const missing = () => c.fields.filter((fl) => fl.required).filter((fl) => (fl.secret
    ? !(d.secrets[fl.key] || '').trim() && !c.secrets[fl.key] : !String(d.config[fl.key] || '').trim()));

  const save = () => {
    const missingErrors = d.mode === 'live' ? Object.fromEntries(missing().map((fl) => [fl.key, 'مطلوب للربط المباشر'])) : {};
    if (!check(f, { ...missingErrors, ...fieldProblems(c.id, d.config) })) return null;
    const secrets = Object.fromEntries(Object.entries(d.secrets).filter(([, v]) => v.trim()));
    const body = { config: d.config, secrets, ...(d.mode !== c.mode && { mode: d.mode }) };
    return f.save(async () => {
      const out = await api.put(`/connections/${c.id}`, body);
      onChange(out);
      return formOf(out);
    }, `حُفظ ربط ${c.label}`, connError);
  };
  const test = async () => {
    if (f.dirty && !(await save())) return;
    setTesting(true);
    try {
      const r = await api.post(`/connections/${c.id}/test`);
      onChange(r.connection);
      toast(r.detail, r.ok ? 'ok' : 'bad', r.ok ? 'نجح اختبار الاتصال' : 'فشل اختبار الاتصال');
    } catch (e) { toast.error(e); } finally { setTesting(false); }
  };
  const remove = async () => {
    const yes = await confirm({ title: `إزالة ربط ${c.label}؟`, ok: 'إزالة الربط', danger: true,
      text: 'ستُحذف المفاتيح المحفوظة لهذه الخدمة نهائيًا، ويعود وكيلها إلى وضع المحاكاة حتى تربطها من جديد.' });
    if (!yes) return;
    setRemoving(true);
    try {
      const out = await api.del(`/connections/${c.id}`);
      onChange(out);
      f.commit(formOf(out));
      toast(`أُزيل ربط ${c.label}`);
    } catch (e) { toast.error(e); } finally { setRemoving(false); }
  };
  const configured = Object.keys(c.secrets || {}).length > 0 || c.mode === 'live';
  const anchorMoved = c.id === 'email' && !!c.secrets?.password && !(d.secrets.password || '').trim()
    && EMAIL_ANCHORS.some((k) => (d.config[k] ?? '') !== (f.saved.config[k] ?? ''));
  return html`<form class="st-conn-edit" noValidate onSubmit=${(e) => { e.preventDefault(); if (f.dirty) save(); }}>
    <div class="st-grid">${c.fields.map((fl) => (fl.secret
      ? html`<${SecretInput} key=${fl.key} fl=${fl} hint=${c.secrets[fl.key]} value=${d.secrets[fl.key]} error=${f.errors[fl.key]}
          onInput=${(e) => setSecret(fl.key, e.currentTarget.value)} />`
      : html`<${TextField} key=${fl.key} label=${fl.label} required=${fl.required} ltr=${!RTL_FIELDS.has(fl.key)}
          value=${d.config[fl.key]} maxLength=${500} placeholder=${fl.placeholder || fl.default} error=${f.errors[fl.key]}
          help=${fl.help} spellcheck=${false} onInput=${(e) => setCfg(fl.key, e.currentTarget.value)} />`))}</div>
    ${c.id === 'email' && html`<p class="tiny faint mt-12">لحماية كلمة المرور: تغيير الخادم أو المنفذ أو اسم المستخدم دون إدخالها من جديد
      يحذف كلمة المرور المحفوظة، فلا تُرسل إلى خادم لم تؤكده.</p>`}
    ${anchorMoved && html`<div class="notice warn mt-12" role="alert"><${Icon} name="alert" size="17" /><div class="grow">
      <b>أعد إدخال كلمة المرور</b>غيّرت بيانات الخادم، وعند الحفظ دون كلمة المرور ستُحذف المحفوظة ويتوقف إرسال البريد حتى تضيفها.</div></div>`}
    <div class="st-mode mt-16">
      <div class="grow"><b class="small">وضع التشغيل</b><p class="help">${modeText(c.id, d.mode)}</p></div>
      <${Seg} options=${MODE_OPTIONS} value=${d.mode} onChange=${(v) => f.set('mode', v)} accent label="وضع التشغيل" />
    </div>
    ${c.webhook && html`<${WebhookBox} />`}
    <div class="st-conn-actions">
      <${Button} type="submit" variant="primary" size="sm" icon="save" loading=${f.busy} disabled=${!f.dirty}>حفظ</${Button}>
      <${Button} size="sm" icon="activity" loading=${testing} disabled=${f.busy} onClick=${test}>اختبار الاتصال</${Button}>
      ${f.dirty && html`<span class="tiny faint row gap-4"><i class="st-dot" />تغييرات غير محفوظة</span>`}
      <span class="grow" />
      ${configured && html`<${Button} variant="danger" size="sm" icon="trash" loading=${removing} onClick=${remove}>إزالة الربط</${Button}>`}
    </div>
  </form>`;
}

function ConnCard({ c, open, onToggle, onChange }) {
  return html`<section class=${cls('card st-conn', open && 'open')} style=${{ '--pc': c.color }} id=${`conn-${c.id}`}>
    <div class="st-conn-head">
      <span class="st-pmark"><${Icon} name=${ICON[c.id] || 'plug'} size="20" /></span>
      <div class="grow">
        <div class="row wrap gap-6"><h3>${c.label}</h3><${StatusTag} c=${c} /></div>
        <p class=${cls('small muted', !open && 'clamp-2')}>${c.about}</p>
        <${Account} c=${c} />
      </div>
      <div class="st-conn-tools">
        ${c.docs && html`<a class="btn ghost sm" href=${c.docs} target="_blank" rel="noopener noreferrer">
          <${Icon} name="arrowUpRight" size="15" />دليل الربط</a>`}
        <${Button} size="sm" iconEnd=${open ? 'chevronUp' : 'chevronDown'} aria-expanded=${open} onClick=${onToggle}>${open ? 'إغلاق' : 'إعداد'}</${Button}>
      </div>
    </div>
    ${c.status === 'error' && c.last_error && html`<div class="notice bad st-conn-err"><${Icon} name="alert" size="17" />
      <div class="grow"><b>تعذر الاتصال</b>${c.last_error}</div></div>`}
    ${open && html`<${ConnEditor} c=${c} onChange=${onChange} />`}
  </section>`;
}

function Overview({ rows }) {
  const live = rows.filter((c) => c.mode === 'live' && c.status === 'connected').length;
  const sandbox = rows.filter((c) => c.mode === 'sandbox').length;
  const attention = rows.filter((c) => c.status === 'error' || (c.mode === 'live' && c.status !== 'connected')).length;
  return html`<div class="card pad st-overview">
    <${Stat} label="متصلة مباشرة" value=${`${num(live)}/${num(rows.length)}`} icon="checkCircle" />
    <${Stat} label="في وضع المحاكاة" value=${num(sandbox)} icon="beaker" />
    <${Stat} label="تحتاج انتباهك" value=${num(attention)} icon="alert" hint=${attention ? 'افتح البطاقة لمعرفة السبب' : 'لا شيء معلّق'} />
  </div>`;
}

function Skel() {
  return html`<div class="col gap-16"><div class="card pad"><${Skeleton} h=${64} /></div>
    ${[1, 2, 3, 4].map(() => html`<div class="card pad"><${Skeleton} h=${70} /></div>`)}</div>`;
}

export default function ConnectionsTab({ query }) {
  const st = useCachedApi('/connections');
  const open = query.provider || '';
  const replace = (c) => st.setData((rows) => rows.map((r) => (r.id === c.id ? c : r)));
  const toggle = async (id) => {
    if (!(await confirmLeave())) return;
    setQuery({ provider: open === id ? null : id });
  };
  return html`<${Head} title="الربط" text="اربط عقل الشبكة وحسابات قنواتك وبريدك. تُحفظ المفاتيح مشفّرة على الخادم ولا تظهر كاملة مرة أخرى." />
    <div class="notice st-sandbox"><${Icon} name="beaker" size="18" /><div class="grow"><b>كيف يعمل وضع المحاكاة؟</b>
      تبدأ كل خدمة في وضع المحاكاة: يواصل الوكيل عمله على بيانات تجريبية (منشورات وتفاعلات وأرقام) حتى تضيف المفاتيح وتحوّل
      الربط إلى «مباشر» وينجح الاختبار. لا يُنشر شيء حقيقي ولا تُحتسب تكلفة في وضع المحاكاة.</div></div>
    <${Loader} state=${st} skeleton=${html`<${Skel} />`}>${(rows) => (rows.length ? html`
      <${Overview} rows=${rows} />
      ${GROUPS.map((g) => {
        const items = rows.filter((c) => c.group === g.id);
        if (!items.length) return null;
        return html`<section class="st-cgroup" key=${g.id}>
          <div class="st-cgroup-head"><h3>${g.label}</h3><p class="small muted">${g.text}</p></div>
          <div class="col gap-16">${items.map((c) => html`<${ConnCard} key=${c.id} c=${c} open=${open === c.id}
            onToggle=${() => toggle(c.id)} onChange=${replace} />`)}</div>
        </section>`;
      })}`
      : html`<${Card}><${Empty} icon="plug" title="لا توجد خدمات للربط" text="أعد تشغيل المنصة لتهيئة قائمة الخدمات، ثم عد إلى هذه الصفحة." /></${Card}>`)}</${Loader}>`;
}
