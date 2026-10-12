// الإعدادات › حسابي: the signed-in member's details and the change-password form.
import { html, cls, useState } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { capLabel, session, useStore } from '../../lib/store.js';
import { date, dateTime } from '../../lib/format.js';
import { Icon, Button, Badge, Card, KeyVal, Meter } from '../../ui/core.js';
import { toast } from '../../ui/overlays.js';
import { without, hasKeys, Head, TextField, ROLE, passwordProblem, initialOf } from './kit.js';

const EMPTY = { current: '', next: '', confirm: '' };
const STRENGTH = [['ضعيفة', 'bad'], ['ضعيفة', 'bad'], ['متوسطة', 'warn'], ['جيدة', 'ok'], ['قوية', 'ok'], ['قوية جدًا', 'ok']];

function strength(pw) {
  if (!pw) return 0;
  return [pw.length >= 10, pw.length >= 14, /[a-z]/.test(pw) && /[A-Z]/.test(pw), /\d/.test(pw), /[^\p{L}\d]/u.test(pw)]
    .filter(Boolean).length;
}

function validate(f) {
  const errors = {};
  if (!f.current) errors.current = 'اكتب كلمة المرور الحالية';
  const problem = passwordProblem(f.next);
  if (problem) errors.next = problem;
  else if (f.next === f.current) errors.next = 'اختر كلمة مرور مختلفة عن الحالية';
  if (!errors.next && f.confirm !== f.next) errors.confirm = 'التأكيد لا يطابق كلمة المرور الجديدة';
  return errors;
}

function PasswordForm({ email }) {
  const [f, setF] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const set = (k) => (e) => { const v = e.currentTarget.value; setF((x) => ({ ...x, [k]: v })); setErrors((x) => without(x, k)); };
  const score = strength(f.next);
  const submit = async (e) => {
    e.preventDefault();
    const errs = validate(f);
    if (hasKeys(errs)) { setErrors(errs); return; }
    setBusy(true);
    try {
      await api.post('/auth/password', { current: f.current, new: f.next });
      setF(EMPTY);
      toast('سُجّل خروجك من الأجهزة الأخرى، وبقيت جلستك هذه نشطة.', 'ok', 'تغيّرت كلمة المرور');
    } catch (err) {
      if (err.code === 'bad_password') setErrors({ current: err.message });
      else if (err.code === 'weak_password') setErrors({ next: err.message });
      else toast.error(err);
    } finally { setBusy(false); }
  };
  const type = show ? 'text' : 'password';
  const eye = html`<button type="button" class="st-eye" aria-label=${show ? 'إخفاء كلمات المرور' : 'إظهار كلمات المرور'} aria-pressed=${show}
    onClick=${() => setShow(!show)}><${Icon} name=${show ? 'eyeOff' : 'eye'} size="15" /></button>`;
  return html`<form class="col gap-16" noValidate onSubmit=${submit}>
    <input class="sr-only" type="email" name="username" autocomplete="username" value=${email} readonly tabIndex="-1" aria-hidden="true" />
    <${TextField} label="كلمة المرور الحالية" ltr type=${type} value=${f.current} onInput=${set('current')} error=${errors.current}
      autocomplete="current-password" maxLength=${200} extra=${eye} />
    <${TextField} label="كلمة المرور الجديدة" ltr type=${type} value=${f.next} onInput=${set('next')} error=${errors.next}
      autocomplete="new-password" maxLength=${200} help="10 أحرف على الأقل تجمع بين الأحرف والأرقام." />
    ${f.next && html`<div class="st-strength"><${Meter} value=${score} max=${5} tone=${STRENGTH[score][1]} />
      <span class=${cls('tiny', `st-s-${STRENGTH[score][1]}`)}>${STRENGTH[score][0]}</span></div>`}
    <${TextField} label="تأكيد كلمة المرور الجديدة" ltr type=${type} value=${f.confirm} onInput=${set('confirm')} error=${errors.confirm}
      autocomplete="new-password" maxLength=${200} />
    <p class="tiny faint">بعد التغيير يُسجَّل خروجك من كل الأجهزة الأخرى، وتبقى جلستك هذه نشطة.</p>
    <div><${Button} type="submit" variant="primary" icon="lock" loading=${busy}>تغيير كلمة المرور</${Button}></div>
  </form>`;
}

export default function AccountTab() {
  const { user } = useStore(session);
  if (!user) return null;
  const role = ROLE[user.role] || { label: user.role, text: '' };
  return html`<${Head} title="حسابي" text="بياناتك في المنصة وكلمة المرور الخاصة بك." />
    <div class="st-account">
      <div class="card pad st-me">
        <div class="row gap-16"><span class="st-avatar lg">${initialOf(user.name)}</span>
          <div class="grow"><h3>${user.name}</h3><p class="small muted ltr st-email">${user.username ? `@${user.username} · ` : ''}${user.email}</p>
            <div class="row gap-6 mt-8"><${Badge} tone="accent" icon=${user.role === 'owner' ? 'crown' : 'user'}>${role.label}</${Badge}></div></div></div>
        <p class="small muted mt-16">${role.text}</p>
        <div class="mt-16"><${KeyVal} items=${[
          ['الصلاحيات', user.role === 'owner' ? 'كل الصلاحيات' : `${(user.caps || []).length} صلاحية`],
          ['آخر دخول', user.last_login_at ? dateTime(user.last_login_at) : 'هذه الجلسة'],
          ['عضو منذ', user.created_at ? date(user.created_at) : ''],
        ]} /></div>
        ${user.role !== 'owner' && (user.caps || []).length > 0 && html`<div class="row wrap gap-6 mt-12">${user.caps.map((c) => html`
          <${Badge} key=${c} tone="outline">${capLabel(c)}</${Badge}>`)}</div>`}
        ${user.role !== 'owner' && html`<p class="tiny faint mt-16">لتغيير اسمك أو بريدك أو صلاحياتك تواصل مع مالك الحساب.</p>`}
      </div>
      <${Card} title="تغيير كلمة المرور" icon="lock"><${PasswordForm} email=${user.email} /></${Card}>
    </div>`;
}
