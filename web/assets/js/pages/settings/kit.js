// Settings kit: the pieces every settings tab shares (cached loads, form drafts with a leave guard, the sticky save
// bar, labelled fields, chips input, the 3-state permission control, copy fields). Settings-only; never imported elsewhere.
import { html, cls, useState, useEffect, useRef, useMemo, useCallback, useId } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { navigate, setLeaveGuard } from '../../lib/router.js';
import { num, CHANNELS, PERM_VALUE } from '../../lib/format.js';
import { Icon, Button, Toggle } from '../../ui/core.js';
import { toast, confirm } from '../../ui/overlays.js';

// ---------------------------------------------------------------- vocabulary

export const AGENT_GROUPS = [
  { id: 'lead', label: 'القيادة', ids: ['ceo'] },
  { id: 'depts', label: 'الأقسام', ids: ['campaigns', 'content', 'coordinator', 'guardian'] },
  { id: 'channels', label: 'القنوات', ids: CHANNELS },
];
export const AGENT_ORDER = AGENT_GROUPS.flatMap((g) => g.ids);
export const ROLE = {
  owner: { label: 'المالك', text: 'كل الصلاحيات، ومنها إدارة الفريق ومستوى الاستقلالية.' },
  manager: { label: 'مدير', text: 'يعتمد المحتوى والحملات، ويدير الليمت والربط.' },
  editor: { label: 'محرر', text: 'يطلب المحتوى من الوكلاء ويحرره.' },
  viewer: { label: 'مشاهد', text: 'اطلاع فقط على الشبكة والتقارير.' },
};
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 10;

// ---------------------------------------------------------------- small pure helpers

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
export const hasKeys = (obj) => Object.keys(obj).length > 0;
export const initialOf = (name) => (name || '؟').trim().slice(0, 1);

/** Mirrors the server rule (qsm/security.password_problem) so the owner sees the reason before submitting. */
export function passwordProblem(pw) {
  if ((pw || '').length < MIN_PASSWORD) return `كلمة المرور يجب ألا تقل عن ${MIN_PASSWORD} أحرف`;
  if (/^\d+$/.test(pw) || /^\p{L}+$/u.test(pw)) return 'استخدم مزيجًا من الأحرف والأرقام';
  return '';
}

/** A random temporary password with letters and digits (no look-alike characters). */
export function makePassword(length = 14) {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const rand = () => crypto.getRandomValues(new Uint32Array(1))[0];
  const pick = (set) => set[rand() % set.length];
  const chars = [pick(letters), pick(digits), ...Array.from({ length: length - 2 }, () => pick(letters + digits))];
  return chars.map((c) => [rand(), c]).sort((a, b) => a[0] - b[0]).map(([, c]) => c).join('');
}

const REASONS = [
  [/at most (\d+) characters/i, (m) => `الحد الأقصى ${m[1]} حرفًا`],
  [/at least (\d+) characters/i, (m) => `الحد الأدنى ${m[1]} أحرف`],
  [/at most (\d+) items/i, (m) => `الحد الأقصى ${m[1]} عناصر`],
  [/match pattern/i, () => 'الصيغة غير صحيحة'],
  [/valid (integer|number)/i, () => 'أدخل رقمًا صحيحًا'],
  [/field required/i, () => 'هذا الحقل مطلوب'],
  [/input should be/i, () => 'قيمة غير مسموحة'],
];
const translate = (reason) => {
  for (const [re, fn] of REASONS) { const m = reason.match(re); if (m) return fn(m); }
  return 'قيمة غير صالحة';
};

/** Map an API validation message to {field, path, message}: settings sections send "path.0.key: reason". */
export function fieldError(err) {
  const msg = err?.message || '';
  let m = msg.match(/^([a-z_]+(?:\.[\w]+)*):\s*(.+)$/i);
  if (m) return { path: m[1], field: m[1].split('.')[0], message: translate(m[2]) };
  m = msg.match(/^قيمة غير صالحة: ([\w.]+)$/);
  if (m) return { path: m[1], field: m[1].split('.')[0], message: 'قيمة غير صالحة' };
  return null;
}

// ---------------------------------------------------------------- data

const cache = new Map();

/** Like useApi, but remembers the last response per path so switching tabs paints instantly, then refreshes. */
export function useCachedApi(path) {
  const [state, setState] = useState(() => ({ data: cache.get(path) ?? null, error: null }));
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    if (!cache.has(path)) setState((s) => ({ ...s, error: null }));
    try {
      const data = await api.get(path);
      cache.set(path, data);
      if (n === seq.current) setState({ data, error: null });
    } catch (e) {
      if (n === seq.current && e.name !== 'AbortError') setState((s) => ({ ...s, error: e }));
    }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  const setData = useCallback((fn) => setState((s) => {
    const data = typeof fn === 'function' ? fn(s.data) : fn;
    cache.set(path, data);
    return { ...s, data };
  }), [path]);
  return { ...state, reload: load, setData };
}

/** Replace one section of the cached GET /settings payload after a successful save. */
export const withSection = (key, value) => (d) => d && ({ ...d, sections: { ...d.sections, [key]: value } });

// ---------------------------------------------------------------- unsaved-changes guard

const dirtyForms = new Set();
let unloadBound = false;
function onUnload(e) {
  if (!dirtyForms.size) return;
  e.preventDefault();
  e.returnValue = '';
}

export function useLeaveGuard(dirty) {
  const token = useRef({}).current;
  useEffect(() => {
    if (!unloadBound) { window.addEventListener('beforeunload', onUnload); unloadBound = true; }
    if (dirty) dirtyForms.add(token); else dirtyForms.delete(token);
  }, [dirty]);
  useEffect(() => () => { dirtyForms.delete(token); }, []);
}

export async function confirmLeave() {
  if (!dirtyForms.size) return true;
  const leave = await confirm({ title: 'تغييرات غير محفوظة', text: 'لم تحفظ تعديلاتك بعد، وستضيع إذا تابعت الآن.',
    ok: 'المتابعة دون حفظ', danger: true });
  if (leave) dirtyForms.clear();
  return leave;
}

setLeaveGuard(confirmLeave); // side rail, tab bar and every other <Link> ask before dropping unsaved settings

export async function go(href) {
  if (await confirmLeave()) navigate(href);
}

/** In-app link that respects the unsaved-changes guard. */
export function GoLink({ href, children, class: c }) {
  const click = (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    go(href);
  };
  return html`<a href=${href} class=${c} onClick=${click}>${children}</a>`;
}

// ---------------------------------------------------------------- form draft

/** Draft over a saved snapshot: dirty tracking, field errors, save with API error mapping, leave guard. */
export function useForm(initial) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const dirty = useMemo(() => !same(draft, saved), [draft, saved]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => { // adopt fresher server data while the owner has not started editing
    if (!dirtyRef.current && !same(initial, saved)) { setSaved(initial); setDraft(initial); }
  }, [initial]);
  useLeaveGuard(dirty);
  const clear = useCallback((key) => setErrors((e) => (e[key] ? without(e, key) : e)), []);
  const set = useCallback((key, value) => { setDraft((d) => ({ ...d, [key]: value })); clear(key); }, [clear]);
  const setIn = useCallback((group, key, value) => {
    setDraft((d) => ({ ...d, [group]: { ...d[group], [key]: value } }));
    clear(key);
  }, [clear]);
  const bind = (key) => ({ value: draft[key] ?? '', onInput: (e) => set(key, e.currentTarget.value) });
  const reset = useCallback(() => { setDraft(saved); setErrors({}); }, [saved]);
  const commit = useCallback((next) => { setSaved(next); setDraft(next); setErrors({}); }, []);
  /** `mapError(err)` may turn an API error into {field: message} for errors that are not "path: reason". */
  const save = async (run, okMessage, mapError) => {
    setBusy(true);
    try {
      const next = await run();
      commit(next);
      if (okMessage) toast(okMessage);
      return next;
    } catch (e) {
      const mapped = mapError?.(e);
      const fe = fieldError(e);
      if (mapped && hasKeys(mapped)) {
        setErrors(mapped);
        toast(e.message, 'bad', 'تعذر الحفظ');
      } else if (fe) {
        setErrors({ [fe.field]: fe.message, [fe.path]: fe.message });
        toast(`راجع الحقل المظلل: ${fe.message}`, 'bad', 'تعذر الحفظ');
      } else toast.error(e);
      return null;
    } finally { setBusy(false); }
  };
  return { draft, saved, dirty, errors, setErrors, busy, set, setIn, clear, bind, reset, commit, save, setDraft };
}

/** Run client validation; on problems show them inline and return false. */
export function check(form, errors) {
  if (!hasKeys(errors)) return true;
  form.setErrors(errors);
  toast('راجع الحقول المظللة قبل الحفظ', 'warn');
  return false;
}

// ---------------------------------------------------------------- layout pieces

export function Head({ title, text, actions }) {
  return html`<header class="st-head"><div class="grow"><h2>${title}</h2>${text && html`<p>${text}</p>`}</div>
    ${actions && html`<div class="row wrap gap-6">${actions}</div>`}</header>`;
}

export function ReadOnly({ who = 'للمدير والمالك' }) {
  return html`<div class="notice st-ro"><${Icon} name="lock" size="17" /><div class="grow">تعرض هذه الصفحة الإعدادات الحالية للاطلاع.
    التعديل متاح ${who} فقط.</div></div>`;
}

export function SaveBar({ form, label = 'حفظ التغييرات', note }) {
  const { dirty, busy, reset } = form;
  return html`<div class=${cls('st-save', dirty && 'dirty')} role="region" aria-label="حفظ التغييرات">
    <span class="st-save-state" aria-live="polite">${dirty
      ? html`<i class="st-dot" />لديك تغييرات غير محفوظة`
      : html`<${Icon} name="checkCircle" size="16" />كل التغييرات محفوظة`}</span>
    ${note && html`<span class="tiny faint st-save-note">${note}</span>`}
    <div class="st-save-actions">
      ${dirty && html`<${Button} variant="ghost" size="sm" onClick=${reset} disabled=${busy}>تراجع</${Button}>`}
      <${Button} type="submit" variant="primary" size="sm" icon="save" loading=${busy} disabled=${!dirty}>${label}</${Button}>
    </div>
  </div>`;
}

/** A settings form: fields disabled for roles that cannot edit, Enter saves, sticky save bar at the end. */
export function SettingsForm({ form, onSubmit, canEdit, children, saveLabel, note }) {
  const submit = (e) => {
    e.preventDefault();
    if (canEdit && form.dirty && !form.busy) onSubmit();
  };
  return html`<form class="st-form" onSubmit=${submit} noValidate>
    <fieldset class="st-fieldset" disabled=${!canEdit}>${children}</fieldset>
    ${canEdit && html`<${SaveBar} form=${form} label=${saveLabel} note=${note} />`}
  </form>`;
}

// ---------------------------------------------------------------- fields

export function Labeled({ id, label, help, error, extra, required, children, class: c }) {
  return html`<div class=${cls('field', c)}>
    ${(label || extra) && html`<div class="st-lbl">${label && html`<label class="label" for=${id}>${label}${required
      && html`<span class="st-req" title="مطلوب">*</span>`}</label>`}${extra}</div>`}
    ${children}
    ${error ? html`<span class="error" role="alert">${error}</span>` : help && html`<span class="help">${help}</span>`}
  </div>`;
}

/** Input or textarea with a linked label, help, inline error and an optional length counter. */
export function TextField({ label, help, error, area, counter, required, extra, ltr, class: c, ...rest }) {
  const id = useId();
  const max = rest.maxLength;
  const len = String(rest.value ?? '').length;
  const props = { id, 'aria-invalid': error ? 'true' : undefined, ...rest };
  const control = area
    ? html`<textarea class="textarea" ...${props} />`
    : html`<input class=${cls('input', ltr && 'ltr')} dir=${ltr ? 'ltr' : undefined} ...${props} />`;
  const count = counter && max
    ? html`<span class=${cls('st-counter', len >= max * 0.9 && 'near')}>${num(len)}/${num(max)}</span>` : null;
  return html`<${Labeled} id=${id} label=${label} help=${help} error=${error} required=${required} extra=${extra || count}
    class=${c}>${control}</${Labeled}>`;
}

export function SelectField({ label, help, error, options, value, onChange, class: c, ...rest }) {
  const id = useId();
  const known = options.some(([v]) => v === value);
  return html`<${Labeled} id=${id} label=${label} help=${help} error=${error} class=${c}>
    <select id=${id} class="select" value=${value} onChange=${(e) => onChange(e.currentTarget.value)} ...${rest}>
      ${!known && value && html`<option value=${value}>${value}</option>`}
      ${options.map(([v, text]) => html`<option key=${v} value=${v}>${text}</option>`)}
    </select></${Labeled}>`;
}

export function SwitchRow({ title, text, checked, onChange, icon, badge }) {
  return html`<div class="st-switch">
    ${icon && html`<span class="mark sm"><${Icon} name=${icon} size="15" /></span>`}
    <div class="grow"><b>${title}</b>${badge}${text && html`<p>${text}</p>`}</div>
    <${Toggle} checked=${checked} onChange=${onChange} label=${title} />
  </div>`;
}

/** Tag-style list input: Enter, comma or paste adds; Backspace on an empty box removes the last one. */
export function ChipsField({ label, help, error, values, onChange, max, placeholder, normalize = (v) => v.trim(),
  validate, invalidText, ltr }) {
  const id = useId();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState('');
  const full = !!max && values.length >= max;
  const add = (raw) => {
    const parts = raw.split(/[,،\n]+/).map(normalize).filter(Boolean);
    if (!parts.length) { setText(''); return; }
    let next = values;
    let bad = '';
    parts.forEach((p) => {
      if (max && next.length >= max) { bad = `وصلت إلى الحد الأقصى (${num(max)})`; return; }
      if (validate && !validate(p)) { bad = invalidText || 'قيمة غير صالحة'; return; }
      if (!next.includes(p)) next = [...next, p];
    });
    if (next !== values) onChange(next);
    setProblem(bad);
    if (!bad) setText('');
  };
  const key = (e) => { // read the live box value: Enter can arrive before the last keystroke re-renders
    const raw = e.currentTarget.value;
    if (e.key === 'Enter' || e.key === ',' || e.key === '،') { e.preventDefault(); add(raw); }
    else if (e.key === 'Backspace' && !raw && values.length) onChange(values.slice(0, -1));
  };
  const counter = max ? html`<span class="st-counter">${num(values.length)}/${num(max)}</span>` : null;
  return html`<${Labeled} id=${id} label=${label} help=${help} error=${problem || error} extra=${counter}>
    <div class=${cls('st-chips', (problem || error) && 'bad')}>
      ${values.map((v) => html`<span class=${cls('st-chip', ltr && 'ltr')} key=${v}>${v}
        <button type="button" aria-label=${`إزالة ${v}`} onClick=${() => onChange(values.filter((x) => x !== v))}>
          <${Icon} name="x" size="12" /></button></span>`)}
      <input id=${id} class=${cls(ltr && 'ltr')} dir=${ltr ? 'ltr' : undefined} value=${text} disabled=${full}
        placeholder=${full ? '' : placeholder} aria-invalid=${problem || error ? 'true' : undefined}
        onInput=${(e) => { setText(e.currentTarget.value); setProblem(''); }} onKeyDown=${key}
        onPaste=${(e) => { const t = e.clipboardData?.getData('text') || ''; if (/[,،\n]/.test(t)) { e.preventDefault(); add(t); } }}
        onBlur=${(e) => e.currentTarget.value.trim() && add(e.currentTarget.value)} />
    </div></${Labeled}>`;
}

/** Multi-select as toggle chips over native checkboxes; keeps the options' canonical order. */
export function CheckGroup({ options, values, onChange, label }) {
  const toggle = (v) => {
    const next = values.includes(v) ? values.filter((x) => x !== v) : [...values, v];
    onChange(options.map((o) => o.value).filter((x) => next.includes(x)));
  };
  return html`<div class="st-checks" role="group" aria-label=${label}>${options.map((o) => {
    const on = values.includes(o.value);
    return html`<label class=${cls('st-check', on && 'on')} key=${o.value}>
      <input type="checkbox" checked=${on} onChange=${() => toggle(o.value)} />
      <${Icon} name=${o.icon} size="15" /><span>${o.label}</span>${on && html`<${Icon} name="check" size="14" class="st-tick" />`}</label>`;
  })}</div>`;
}

/** Read-only value with a copy button (falls back to selecting the text when the clipboard is unavailable). */
export function CopyField({ label, value, help }) {
  const id = useId();
  const ref = useRef(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('نُسخ إلى الحافظة');
    } catch {
      ref.current?.select();
      toast('حدّد النص وانسخه يدويًا', 'warn');
    }
  };
  return html`<${Labeled} id=${id} label=${label} help=${help}>
    <div class="st-copy"><input id=${id} ref=${ref} class="input ltr mono" dir="ltr" readonly value=${value}
      onFocus=${(e) => e.currentTarget.select()} />
      <${Button} icon="copy" onClick=${copy} aria-label=${`نسخ ${label}`} title="نسخ" /></div></${Labeled}>`;
}

// ---------------------------------------------------------------- permission control

const PERM_META = { auto: { icon: 'zap' }, approve: { icon: 'user' }, off: { icon: 'x' } };
export const PERM_ORDER = ['auto', 'approve', 'off'];
export const PERM_HELP = {
  auto: 'ينفّذ الوكيل وحده، ضمن الليمت والسياسات دائمًا.',
  approve: 'يجهّز الوكيل العمل ويرسله إلى مكتب الاعتماد، ولا يُنفَّذ قبل موافقتك.',
  off: 'لا يقوم الوكيل بهذا الإجراء أبدًا.',
};

/** تلقائي / باعتمادك / موقوف, coloured ok / warn / bad. `compact` shows icons only (the matrix). */
export function PermControl({ value, onChange, compact, label, disabled, busy }) {
  return html`<div class=${cls('st-pc', compact && 'sm', busy && 'busy')} role="radiogroup" aria-label=${label}>
    ${PERM_ORDER.map((v) => html`<button type="button" role="radio" key=${v} aria-checked=${v === value}
      class=${cls(v, v === value && 'on')} title=${`${PERM_VALUE[v]}: ${PERM_HELP[v]}`}
      aria-label=${compact ? PERM_VALUE[v] : undefined} disabled=${disabled || busy}
      onClick=${() => v !== value && onChange(v)}>
      ${compact ? html`<${Icon} name=${PERM_META[v].icon} size="13" />` : html`<${Icon} name=${PERM_META[v].icon} size="13" />${PERM_VALUE[v]}`}
    </button>`)}
  </div>`;
}

export function PermLegend() {
  return html`<div class="st-legend">${PERM_ORDER.map((v) => html`<div class="st-legend-item" key=${v}>
      <span class=${cls('st-pc-dot', v)}><${Icon} name=${PERM_META[v].icon} size="13" /></span>
      <div><b>${PERM_VALUE[v]}</b><p>${PERM_HELP[v]}</p></div></div>`)}
    <div class="st-legend-item"><span class="st-pc-dot na">·</span><div><b>لا تنطبق</b><p>الصلاحية لا تخص هذا الوكيل.</p></div></div>
  </div>`;
}
