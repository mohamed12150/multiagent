// الإعدادات › الفريق: members, roles and access. Managers see the team; only the owner adds members or changes them.
import { html, cls, useState } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { can, session, useStore } from '../../lib/store.js';
import { num, ago, dateTime } from '../../lib/format.js';
import { Icon, Button, Badge, Toggle, Skeleton, Loader, Empty } from '../../ui/core.js';
import { Modal, toast, confirm } from '../../ui/overlays.js';
import { useCachedApi, without, hasKeys, Head, TextField, SelectField, ROLE, EMAIL, passwordProblem, makePassword, initialOf } from './kit.js';

const ASSIGNABLE = ['manager', 'editor', 'viewer'];
const ROLE_OPTIONS = ASSIGNABLE.map((r) => [r, ROLE[r].label]);
const ERROR_FIELD = { bad_email: 'email', exists: 'email', weak_password: 'password', bad_role: 'role' };
const EMPTY = { name: '', email: '', role: 'editor', password: '' };

function validate(f) {
  const errors = {};
  if (f.name.trim().length < 2) errors.name = 'اكتب الاسم، حرفان على الأقل';
  if (!EMAIL.test(f.email.trim())) errors.email = 'البريد غير صحيح';
  const pw = passwordProblem(f.password);
  if (pw) errors.password = pw;
  return errors;
}

function AddMember({ onClose, onAdded }) {
  const [f, setF] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setErrors((e) => without(e, k)); };
  const generate = () => { set('password', makePassword()); setShow(true); };
  const submit = async (e) => {
    e?.preventDefault();
    const errs = validate(f);
    if (hasKeys(errs)) { setErrors(errs); return; }
    setBusy(true);
    try {
      const u = await api.post('/users', { ...f, name: f.name.trim(), email: f.email.trim().toLowerCase() });
      onAdded(u);
      toast(`شارك مع ${u.name} بريده وكلمة المرور المؤقتة، وسيغيّرها من «حسابي» بعد أول دخول.`, 'ok', 'أُضيف العضو');
      onClose();
    } catch (err) {
      const field = ERROR_FIELD[err.code];
      if (field) setErrors({ [field]: err.message }); else toast.error(err);
    } finally { setBusy(false); }
  };
  const eye = html`<button type="button" class="st-eye" aria-label=${show ? 'إخفاء' : 'إظهار'} aria-pressed=${show}
    onClick=${() => setShow(!show)}><${Icon} name=${show ? 'eyeOff' : 'eye'} size="15" /></button>`;
  return html`<${Modal} title="إضافة عضو للفريق" onClose=${onClose} footer=${html`
      <${Button} type="submit" form="st-add-member" variant="primary" icon="plus" loading=${busy}>إضافة العضو</${Button}>
      <${Button} variant="ghost" onClick=${onClose}>إلغاء</${Button}>`}>
    <form id="st-add-member" class="col gap-16" noValidate onSubmit=${submit}>
      <${TextField} label="الاسم" required maxLength=${120} value=${f.name} error=${errors.name} autocomplete="off"
        onInput=${(e) => set('name', e.currentTarget.value)} />
      <${TextField} label="البريد الإلكتروني" required ltr type="email" maxLength=${200} value=${f.email} error=${errors.email}
        autocomplete="off" onInput=${(e) => set('email', e.currentTarget.value)} placeholder="name@company.sa" />
      <${SelectField} label="الدور" options=${ROLE_OPTIONS} value=${f.role} error=${errors.role} help=${ROLE[f.role].text}
        onChange=${(v) => set('role', v)} />
      <${TextField} label="كلمة مرور مؤقتة" required ltr type=${show ? 'text' : 'password'} maxLength=${200} value=${f.password}
        error=${errors.password} autocomplete="new-password" extra=${eye} onInput=${(e) => set('password', e.currentTarget.value)}
        help="10 أحرف على الأقل تجمع بين الأحرف والأرقام. شاركها مع العضو بطريقة آمنة." />
      <div><${Button} size="sm" icon="key" onClick=${generate}>إنشاء كلمة مرور قوية</${Button}></div>
    </form>
  </${Modal}>`;
}

function RoleGuide() {
  return html`<div class="card pad st-roles">${Object.entries(ROLE).map(([k, r]) => html`<div class="st-role" key=${k}>
    <span class="mark sm agent"><${Icon} name=${k === 'owner' ? 'crown' : k === 'manager' ? 'shield' : k === 'editor' ? 'edit' : 'eye'} size="14" /></span>
    <div><b>${r.label}</b><p>${r.text}</p></div></div>`)}</div>`;
}

function MemberRow({ u, me, owner, onRole, onActive }) {
  const self = u.id === me?.id;
  const locked = !owner || self || u.role === 'owner';
  return html`<div class=${cls('st-urow', !u.active && 'off')}>
    <div class="st-uwho"><span class="st-avatar">${initialOf(u.name)}</span>
      <div class="grow"><b class="row gap-6"><span class="ellipsis">${u.name}</span>${self && html`<${Badge} tone="outline">أنت</${Badge}>`}
        ${!u.active && html`<${Badge} tone="bad">موقوف</${Badge}>`}</b>
        <span class="tiny faint ltr ellipsis st-email">${u.email}</span></div></div>
    <div class="st-ucell st-u-role" data-label="الدور">${u.role === 'owner' ? html`<${Badge} tone="accent" icon="crown">${ROLE.owner.label}</${Badge}>`
      : locked ? html`<${Badge}>${ROLE[u.role]?.label || u.role}</${Badge}>`
      : html`<select class="select st-role-select" value=${u.role} aria-label=${`دور ${u.name}`}
          onChange=${(e) => onRole(u, e.currentTarget.value)}>${ROLE_OPTIONS.map(([v, t]) => html`<option value=${v}>${t}</option>`)}</select>`}</div>
    <div class="st-ucell st-u-active" data-label="نشط"><${Toggle} checked=${u.active} disabled=${locked} label=${`حساب ${u.name} نشط`}
      onChange=${(v) => onActive(u, v)} /></div>
    <div class="st-ucell st-u-last small muted" data-label="آخر دخول" title=${u.last_login_at ? dateTime(u.last_login_at) : ''}>
      ${u.last_login_at ? ago(u.last_login_at) : 'لم يدخل بعد'}</div>
  </div>`;
}

export default function UsersTab() {
  const st = useCachedApi('/users');
  const me = useStore(session).user;
  const owner = can('owner');
  const [adding, setAdding] = useState(false);
  const put = (u) => st.setData((rows) => rows.map((r) => (r.id === u.id ? u : r)));
  const patch = async (u, body, message) => {
    put({ ...u, ...body });
    try {
      const out = await api.patch(`/users/${u.id}`, body);
      put(out);
      toast(message(out));
    } catch (e) {
      put(u);
      toast.error(e);
    }
  };
  const onRole = (u, role) => patch(u, { role }, (o) => `أصبح دور ${o.name}: ${ROLE[o.role]?.label || o.role}`);
  const onActive = async (u, active) => {
    if (!active) {
      const yes = await confirm({ title: `إيقاف حساب ${u.name}؟`, ok: 'إيقاف الحساب', danger: true,
        text: 'لن يتمكن من الدخول، وسيُسجَّل خروجه من كل الأجهزة فورًا. يمكنك إعادة تفعيله في أي وقت.' });
      if (!yes) { put({ ...u }); return; }
    }
    patch(u, { active }, (o) => (o.active ? `أُعيد تفعيل حساب ${o.name}` : `أُوقف حساب ${o.name}`));
  };
  return html`<${Head} title="الفريق" text="من يدخل المنصة وماذا يستطيع أن يفعل. كل عضو يرى الشبكة حسب دوره."
      actions=${owner && html`<${Button} variant="primary" size="sm" icon="plus" onClick=${() => setAdding(true)}>إضافة عضو</${Button}>`} />
    ${!owner && html`<div class="notice st-ro"><${Icon} name="lock" size="17" /><div class="grow">يضيف المالك وحده أعضاء الفريق ويغيّر أدوارهم.</div></div>`}
    <${Loader} state=${st} skeleton=${html`<div class="card pad"><${Skeleton} lines=${4} h=${44} /></div>`}>${(rows) => html`
      <div class="card st-users">
        <div class="st-urow st-uhead" aria-hidden="true"><span>العضو</span><span>الدور</span><span>نشط</span><span>آخر دخول</span></div>
        ${rows.length ? rows.map((u) => html`<${MemberRow} key=${u.id} u=${u} me=${me} owner=${owner} onRole=${onRole} onActive=${onActive} />`)
          : html`<${Empty} icon="users" title="لا أعضاء بعد" text="أضف مديرًا أو محررًا ليشاركك متابعة الشبكة." />`}
        <p class="tiny faint st-users-foot">${num(rows.filter((u) => u.active).length)} نشط من ${num(rows.length)}</p>
      </div>`}</${Loader}>
    <h3 class="mt-24 st-sub">الأدوار</h3>
    <${RoleGuide} />
    ${adding && html`<${AddMember} onClose=${() => setAdding(false)} onAdded=${(u) => st.setData((rows) => [...(rows || []), u])} />`}`;
}
