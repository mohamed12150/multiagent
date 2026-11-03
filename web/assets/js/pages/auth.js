// First-run setup (creates the owner) and sign-in.
import { html, useState } from '../lib/h.js';
import { api } from '../lib/api.js';
import { session } from '../lib/store.js';
import { Button, Field } from '../ui/core.js';
import { OrbitMap } from '../ui/orbit.js';
import { BrandMark } from '../layout/shell.js';

const DEMO_AGENTS = [
  ['ceo', 'القائد', 'working'], ['campaigns', 'مدير الحملات', 'idle'], ['content', 'صانع المحتوى', 'working'],
  ['coordinator', 'المنسّق', 'idle'], ['guardian', 'الحارس', 'idle'], ['tiktok', 'تيك توك', 'idle'],
  ['instagram', 'إنستقرام', 'working'], ['x', 'إكس', 'idle'], ['whatsapp', 'واتساب', 'idle'], ['linkedin', 'لينكدإن', 'idle'],
].map(([id, name, status]) => ({ id, name, status, enabled: true }));

export function Auth({ setup }) {
  const [f, setF] = useState({ name: '', company: '', email: '', login: '', password: '', setup_token: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = setup
        // the token is typed or pasted by hand — strip anything but printable ASCII (hidden RTL marks break HMAC equality)
        ? { name: f.name, company: f.company, email: f.email, password: f.password,
            setup_token: f.setup_token.replace(/[^\x21-\x7e]/g, '') }
        : { login: f.login.trim(), password: f.password };
      const user = await api.post(setup ? '/auth/setup' : '/auth/login', body);
      const st = await api.get('/auth/state');
      session.set({ user, company: st.company, setupNeeded: false });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return html`<div class="auth">
    <div class="auth-form">
      <div class="row"><${BrandMark} size=${44} /><div><b>Qhub Smart Marketing</b><div class="tiny faint">شبكة تسويق ذكية لشركتك</div></div></div>
      <div><h1>${setup ? 'لنطلق شبكتك' : 'أهلًا بعودتك'}</h1>
        <p class="muted mt-4">${setup ? 'أنشئ حساب المالك. ستعمل الشبكة فورًا في وضع المحاكاة حتى تربط مفاتيحك.' : 'سجّل الدخول لمتابعة فريقك.'}</p></div>
      <form onSubmit=${submit}>
        ${setup && html`<${Field} label="اسمك"><input class="input" required minlength="2" value=${f.name} onInput=${set('name')} autocomplete="name" /></${Field}>
          <${Field} label="اسم الشركة"><input class="input" required minlength="2" value=${f.company} onInput=${set('company')} autocomplete="organization" /></${Field}>`}
        ${setup && html`<${Field} label="رمز الإعداد" help="يطلبه خادم الإنتاج (QSM_SETUP_TOKEN) — يُترك فارغًا في التطوير">
          <input class="input ltr" value=${f.setup_token} onInput=${set('setup_token')} autocomplete="off" autocapitalize="none" spellcheck="false" /></${Field}>`}
        ${setup
          ? html`<${Field} label="البريد الإلكتروني"><input class="input ltr" type="email" required value=${f.email} onInput=${set('email')} autocomplete="email" /></${Field}>`
          : html`<${Field} label="البريد أو اسم المستخدم"><input class="input ltr" required value=${f.login} onInput=${set('login')}
              autocomplete="username" autocapitalize="none" spellcheck="false" /></${Field}>`}
        <${Field} label="كلمة المرور" help=${setup ? '10 أحرف على الأقل، أحرف وأرقام' : ''}>
          <input class="input ltr" type="password" required value=${f.password} onInput=${set('password')} autocomplete=${setup ? 'new-password' : 'current-password'} /></${Field}>
        ${error && html`<div class="notice bad" role="alert">${error}</div>`}
        <${Button} variant="primary" type="submit" loading=${busy}>${setup ? 'إطلاق المنصة' : 'دخول'}</${Button}>
      </form>
    </div>
    <div class="auth-art" aria-hidden="true">
      <${OrbitMap} agents=${DEMO_AGENTS} />
      <div class="caption"><b>عشرة وكلاء يعملون كفريق واحد</b><p>القائد يوزّع، مدير الحملات يخطط، صانع المحتوى يكتب، وكلاء القنوات ينشرون ويتفاعلون، والمنسّق يرسل لك تقرير الإنجاز كل يوم.</p></div>
    </div>
  </div>`;
}
