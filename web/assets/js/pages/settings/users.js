// الإعدادات › الفريق: members and exactly what each may do. Whoever holds «إدارة المستخدمين» adds people with a
// username, email and password, picks a role as a starting preset, then ticks individual permissions. The server
// enforces the same rules shown here: nobody grants what they lack, and three permissions come from the owner only.
import { html, cls, useState } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { can, session, useStore } from '../../lib/store.js';
import { num, ago, dateTime } from '../../lib/format.js';
import { Icon, Button, Badge, Toggle, Skeleton, Loader, Empty } from '../../ui/core.js';
import { Modal, toast, confirm } from '../../ui/overlays.js';
import { useCachedApi, without, hasKeys, same, Head, TextField, SelectField, ROLE, EMAIL, passwordProblem, makePassword,
  initialOf } from './kit.js';

const ASSIGNABLE = ['manager', 'editor', 'viewer'];
const ROLE_OPTIONS = ASSIGNABLE.map((r) => [r, ROLE[r].label]);
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const ERROR_FIELD = { bad_email: 'email', email_taken: 'email', bad_username: 'username', username_taken: 'username',
  weak_password: 'password', bad_role: 'role', cannot_grant: 'caps' };
const ROLE_ICON = { owner: 'crown', manager: 'shield', editor: 'edit', viewer: 'eye' };

const sortCaps = (catalog, caps) => Object.keys(catalog.capabilities).filter((k) => caps.includes(k));
const suggestUsername = (email) => (email.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);

function grantRule(catalog, me) {
  const mine = new Set(me?.caps || []);
  const ownerOnly = new Set(catalog.owner_granted);
  return (key) => {
    if (me?.role === 'owner') return '';
    if (ownerOnly.has(key)) return 'يمنحها المالك فقط';
    return mine.has(key) ? '' : 'لا تملكها لتمنحها';
  };
}

function validate(f, creating) {
  const errors = {};
  if (f.name.trim().length < 2) errors.name = 'اكتب الاسم، حرفان على الأقل';
  if (!USERNAME.test(f.username.trim().toLowerCase())) errors.username = '3-32 حرفًا إنجليزيًا صغيرًا أو أرقامًا أو . _ -';
  if (!EMAIL.test(f.email.trim())) errors.email = 'البريد غير صحيح';
  if (creating || f.password) {
    const pw = passwordProblem(f.password);
    if (pw) errors.password = pw;
  }
  return errors;
}

/** Permission checklist grouped like the server catalog; locked rows explain why. */
function CapPicker({ catalog, caps, onChange, lockedWhy, disabled }) {
  const groups = [];
  Object.entries(catalog.capabilities).forEach(([key, c]) => {
    const g = groups.find((x) => x.name === c.group) || (groups.push({ name: c.group, keys: [] }), groups[groups.length - 1]);
    g.keys.push(key);
  });
  const toggle = (key) => onChange(sortCaps(catalog, caps.includes(key) ? caps.filter((k) => k !== key) : [...caps, key]));
  return html`<div class="st-caps">${groups.map((g) => html`<fieldset class="st-capgroup" key=${g.name}>
    <legend>${g.name}</legend>
    ${g.keys.map((key) => {
      const c = catalog.capabilities[key];
      const why = lockedWhy(key);
      const on = caps.includes(key);
      return html`<label class=${cls('st-cap', on && 'on', (why || disabled) && 'locked')} key=${key}>
        <input type="checkbox" checked=${on} disabled=${!!why || disabled} aria-label=${c.label} onChange=${() => toggle(key)} />
        <span class="st-cap-box" aria-hidden="true">${on && html`<${Icon} name="check" size="13" />`}</span>
        <span class="grow"><b>${c.label}</b><small>${why ? html`<${Icon} name="lock" size="11" /> ${why}` : c.hint}</small></span>
      </label>`;
    })}</fieldset>`)}</div>`;
}

function MemberEditor({ member, catalog, me, onClose, onSaved, onDeleted }) {
  const creating = !member;
  const preset = (role) => sortCaps(catalog, catalog.presets[role] || []);
  const start = member
    ? { name: member.name, username: member.username, email: member.email, role: member.role, password: '', caps: member.caps }
    : { name: '', username: '', email: '', role: 'editor', password: '', caps: preset('editor') };
  const [f, setF] = useState(start);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState('');
  const [show, setShow] = useState(false);
  const [touchedUser, setTouchedUser] = useState(!creating);
  const lockedWhy = grantRule(catalog, me);
  const set = (patch) => { setF((x) => ({ ...x, ...patch })); setErrors((e) => Object.keys(patch).reduce(without, e)); };
  const onEmail = (email) => set(touchedUser ? { email } : { email, username: suggestUsername(email) });
  const onRole = (role) => set({ role, caps: preset(role) });
  const followsPreset = same(f.caps, preset(f.role));

  const body = () => {
    const base = { name: f.name.trim(), username: f.username.trim().toLowerCase(), email: f.email.trim().toLowerCase(),
      role: f.role };
    if (creating) return { ...base, password: f.password, permissions: followsPreset ? null : f.caps };
    const out = { ...base, ...(f.password ? { password: f.password } : {}) };
    if (followsPreset) return member.custom_permissions || member.role !== f.role ? { ...out, use_preset: true } : out;
    return same(f.caps, member.caps) && member.role === f.role ? out : { ...out, permissions: f.caps };
  };
  const submit = async (e) => {
    e?.preventDefault();
    const errs = validate(f, creating);
    if (hasKeys(errs)) { setErrors(errs); return; }
    setBusy('save');
    try {
      const u = creating ? await api.post('/users', body()) : await api.patch(`/users/${member.id}`, body());
      onSaved(u);
      toast(creating ? `شارك مع ${u.name} اسم المستخدم «${u.username}» وكلمة المرور المؤقتة بطريقة آمنة، وسيغيّرها من «حسابي».`
        : f.password ? `حُدّث حساب ${u.name} وسُجّل خروجه من أجهزته ليدخل بكلمة المرور الجديدة` : `حُدّث حساب ${u.name}`,
      'ok', creating ? 'أُضيف العضو' : undefined);
      onClose();
    } catch (err) {
      const field = ERROR_FIELD[err.code];
      if (field) setErrors({ [field]: err.message }); else toast.error(err);
    } finally { setBusy(''); }
  };
  const remove = async () => {
    const yes = await confirm({ title: `حذف ${member.name} نهائيًا؟`, ok: 'حذف العضو', danger: true,
      text: 'يُحذف الحساب ويُسجَّل خروجه فورًا، وتبقى أعماله السابقة في السجل. لإيقافه مؤقتًا استخدم «نشط» بدل الحذف.' });
    if (!yes) return;
    setBusy('delete');
    try { await api.del(`/users/${member.id}`); onDeleted(member); toast(`حُذف حساب ${member.name}`); onClose(); }
    catch (err) { toast.error(err); } finally { setBusy(''); }
  };
  const eye = html`<button type="button" class="st-eye" aria-label=${show ? 'إخفاء' : 'إظهار'} aria-pressed=${show}
    onClick=${() => setShow(!show)}><${Icon} name=${show ? 'eyeOff' : 'eye'} size="15" /></button>`;
  return html`<${Modal} wide title=${creating ? 'إضافة عضو للفريق' : `تعديل ${member.name}`} onClose=${onClose} footer=${html`
      <${Button} type="submit" form="st-member" variant="primary" icon=${creating ? 'plus' : 'save'} loading=${busy === 'save'}
        disabled=${!!busy}>${creating ? 'إضافة العضو' : 'حفظ التغييرات'}</${Button}>
      <${Button} variant="ghost" onClick=${onClose}>إلغاء</${Button}>
      ${!creating && html`<span class="grow" /><${Button} variant="ghost" icon="trash" class="st-del" loading=${busy === 'delete'}
        disabled=${!!busy} onClick=${remove}>حذف العضو</${Button}>`}`}>
    <form id="st-member" class="st-member" noValidate onSubmit=${submit}>
      <div class="st-grid">
        <${TextField} label="الاسم" required maxLength=${120} value=${f.name} error=${errors.name} autocomplete="off"
          onInput=${(e) => set({ name: e.currentTarget.value })} />
        <${TextField} label="البريد الإلكتروني" required ltr type="email" maxLength=${200} value=${f.email} error=${errors.email}
          autocomplete="off" placeholder="name@company.sa" onInput=${(e) => onEmail(e.currentTarget.value)} />
        <${TextField} label="اسم المستخدم" required ltr maxLength=${32} value=${f.username} error=${errors.username}
          autocomplete="off" help="يدخل به العضو أو ببريده" placeholder="sara.k"
          onInput=${(e) => { setTouchedUser(true); set({ username: e.currentTarget.value.toLowerCase() }); }} />
        <${TextField} label=${creating ? 'كلمة مرور مؤقتة' : 'كلمة مرور جديدة'} required=${creating} ltr type=${show ? 'text' : 'password'}
          maxLength=${200} value=${f.password} error=${errors.password} autocomplete="new-password" extra=${eye}
          help=${creating ? '10 أحرف على الأقل تجمع بين الأحرف والأرقام' : 'اتركها فارغة لتبقى كما هي'}
          onInput=${(e) => set({ password: e.currentTarget.value })} />
      </div>
      <div><${Button} size="sm" icon="key" onClick=${() => { set({ password: makePassword() }); setShow(true); }}>إنشاء كلمة مرور قوية</${Button}></div>
      <div class="st-member-role">
        <${SelectField} label="الدور (نقطة البداية)" options=${ROLE_OPTIONS} value=${f.role} error=${errors.role}
          help=${ROLE[f.role].text} onChange=${onRole} />
        <div class="st-member-sum"><b>${num(f.caps.length)}</b> من ${num(Object.keys(catalog.capabilities).length)} صلاحية
          ${followsPreset ? html`<${Badge} tone="outline">حسب الدور</${Badge}>` : html`<${Badge} tone="accent">مخصصة</${Badge}>
            <${Button} size="xs" variant="ghost" icon="refresh" onClick=${() => set({ caps: preset(f.role) })}>أعد صلاحيات الدور</${Button}>`}</div>
      </div>
      ${errors.caps && html`<span class="error" role="alert">${errors.caps}</span>`}
      <${CapPicker} catalog=${catalog} caps=${f.caps} onChange=${(caps) => set({ caps })} lockedWhy=${lockedWhy} />
      <p class="tiny faint">كل عضو نشط يرى الشبكة والتقارير. الصلاحيات تحدد ما يستطيع تغييره أو تنفيذه فقط.</p>
    </form>
  </${Modal}>`;
}

function MemberRow({ u, me, total, manageable, onEdit, onActive }) {
  const self = u.id === me?.id;
  return html`<div class=${cls('st-urow', !u.active && 'off')}>
    <div class="st-uwho"><span class="st-avatar">${initialOf(u.name)}</span>
      <div class="grow"><b class="row gap-6"><span class="ellipsis">${u.name}</span>${self && html`<${Badge} tone="outline">أنت</${Badge}>`}
        ${!u.active && html`<${Badge} tone="bad">موقوف</${Badge}>`}</b>
        <span class="tiny faint ltr ellipsis st-email">${u.username ? `@${u.username} · ` : ''}${u.email}</span></div></div>
    <div class="st-ucell st-u-role" data-label="الدور"><${Badge} tone=${u.role === 'owner' ? 'accent' : ''} icon=${ROLE_ICON[u.role]}>
      ${ROLE[u.role]?.label || u.role}</${Badge}>
      <span class="tiny faint st-u-caps">${u.role === 'owner' ? 'كل الصلاحيات' : `${num(u.caps.length)}/${num(total)}${u.custom_permissions ? ' · مخصصة' : ''}`}</span></div>
    <div class="st-ucell st-u-active" data-label="نشط"><${Toggle} checked=${u.active} disabled=${!manageable} label=${`حساب ${u.name} نشط`}
      onChange=${(v) => onActive(u, v)} /></div>
    <div class="st-ucell st-u-last small muted" data-label="آخر دخول" title=${u.last_login_at ? dateTime(u.last_login_at) : ''}>
      ${u.last_login_at ? ago(u.last_login_at) : 'لم يدخل بعد'}</div>
    <div class="st-ucell st-u-edit">${manageable && html`<${Button} size="sm" variant="ghost" icon="edit" aria-label=${`تعديل ${u.name}`}
      onClick=${() => onEdit(u)}>تعديل</${Button}>`}</div>
  </div>`;
}

function canManage(me, u) {
  if (!me || u.id === me.id || u.role === 'owner') return false;
  if (me.role === 'owner') return true;
  const mine = new Set(me.caps || []);
  return u.caps.every((c) => mine.has(c));
}

function RoleGuide() {
  return html`<div class="card pad st-roles">${Object.entries(ROLE).map(([k, r]) => html`<div class="st-role" key=${k}>
    <span class="mark sm agent"><${Icon} name=${ROLE_ICON[k]} size="14" /></span>
    <div><b>${r.label}</b><p>${r.text}</p></div></div>`)}</div>`;
}

export default function UsersTab() {
  const st = useCachedApi('/users');
  const cat = useCachedApi('/users/catalog');
  const me = useStore(session).user;
  const admin = can('users');
  const [editing, setEditing] = useState(null); // null | 'new' | member
  const put = (u) => st.setData((rows) => rows.map((r) => (r.id === u.id ? u : r)));
  const onActive = async (u, active) => {
    if (!active && !(await confirm({ title: `إيقاف حساب ${u.name}؟`, ok: 'إيقاف الحساب', danger: true,
      text: 'لن يتمكن من الدخول، وسيُسجَّل خروجه من كل الأجهزة فورًا. يمكنك إعادة تفعيله في أي وقت.' }))) return;
    put({ ...u, active });
    try {
      const out = await api.patch(`/users/${u.id}`, { active });
      put(out);
      toast(out.active ? `أُعيد تفعيل حساب ${out.name}` : `أُوقف حساب ${out.name}`);
    } catch (e) { put(u); toast.error(e); }
  };
  const total = Object.keys(cat.data?.capabilities || {}).length;
  return html`<${Head} title="الفريق" text="من يدخل المنصة وماذا يستطيع أن يفعل: اسم مستخدم وبريد وكلمة مرور، وصلاحيات تختارها بندًا بندًا."
      actions=${admin && cat.data && html`<${Button} variant="primary" size="sm" icon="plus" onClick=${() => setEditing('new')}>إضافة عضو</${Button}>`} />
    <${Loader} state=${st} skeleton=${html`<div class="card pad"><${Skeleton} lines=${4} h=${44} /></div>`}>${(rows) => html`
      <div class="card st-users">
        <div class="st-urow st-uhead" aria-hidden="true"><span>العضو</span><span>الدور والصلاحيات</span><span>نشط</span><span>آخر دخول</span><span /></div>
        ${rows.length ? rows.map((u) => html`<${MemberRow} key=${u.id} u=${u} me=${me} total=${total} manageable=${admin && canManage(me, u)}
            onEdit=${setEditing} onActive=${onActive} />`)
          : html`<${Empty} icon="users" title="لا أعضاء بعد" text="أضف مديرًا أو محررًا ليشاركك متابعة الشبكة." />`}
        <p class="tiny faint st-users-foot">${num(rows.filter((u) => u.active).length)} نشط من ${num(rows.length)}</p>
      </div>`}</${Loader}>
    <h3 class="mt-24 st-sub">الأدوار نقطة بداية</h3>
    <p class="small muted st-roles-note">اختر الدور الأقرب ثم عدّل الصلاحيات كما تحتاج. «الاستقلالية» و«الإشعارات» و«إدارة المستخدمين» يمنحها المالك وحده.</p>
    <${RoleGuide} />
    ${editing && cat.data && html`<${MemberEditor} member=${editing === 'new' ? null : editing} catalog=${cat.data} me=${me}
      onClose=${() => setEditing(null)}
      onSaved=${(u) => st.setData((rows) => (rows.some((r) => r.id === u.id) ? rows.map((r) => (r.id === u.id ? u : r)) : [...rows, u]))}
      onDeleted=${(u) => st.setData((rows) => rows.filter((r) => r.id !== u.id))} />`}`;
}
