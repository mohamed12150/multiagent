// Drawers, modals, toasts and confirm — rendered through hosts mounted once by the shell.
import { html, useEffect, useRef, useState } from '../lib/h.js';
import { Icon } from '../lib/icons.js';
import { Button } from './core.js';

// Open layers, newest last: Escape closes only the top one (a confirm over a drawer leaves the drawer open).
const layers = [];
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !layers.length) return;
  e.stopPropagation();
  layers[layers.length - 1].current?.();
});

export function useEscape(onClose) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    layers.push(ref);
    return () => { const i = layers.lastIndexOf(ref); if (i >= 0) layers.splice(i, 1); };
  }, []);
}

export function Drawer({ title, icon, onClose, children, footer, wide = false, head }) {
  useEscape(onClose);
  return html`<div class="overlay" onClick=${onClose} />
    <aside class=${wide ? 'drawer wide' : 'drawer'} role="dialog" aria-modal="true" aria-label=${title}>
      <div class="drawer-head">${icon}<h2 class="ellipsis">${title}</h2>${head}
        <button class="icon-btn" aria-label="إغلاق" onClick=${onClose}><${Icon} name="x" size="18" /></button></div>
      <div class="drawer-body">${children}</div>
      ${footer && html`<div class="drawer-foot">${footer}</div>`}
    </aside>`;
}

export function Modal({ title, onClose, children, footer, wide = false }) {
  useEscape(onClose);
  return html`<div class="overlay" onClick=${onClose} />
    <div class=${wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true" aria-label=${title}>
      <div class="modal-head"><h2>${title}</h2><button class="icon-btn" aria-label="إغلاق" onClick=${onClose}><${Icon} name="x" size="18" /></button></div>
      <div class="modal-body">${children}</div>
      ${footer && html`<div class="modal-foot">${footer}</div>`}
    </div>`;
}

// ---------- toasts ----------
let pushToast = null;
let toastId = 0;
export function toast(message, tone = 'ok', title) {
  pushToast?.({ id: ++toastId, message, tone, title });
}
toast.error = (e) => toast(e?.message || String(e), 'bad', 'تعذر التنفيذ');

export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    pushToast = (t) => {
      setItems((xs) => [...xs.slice(-3), t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.tone === 'bad' ? 7000 : 4200);
    };
    return () => { pushToast = null; };
  }, []);
  const icon = { ok: 'checkCircle', bad: 'alert', warn: 'info' };
  return html`<div class="toasts" aria-live="polite">${items.map((t) => html`<div class=${`toast ${t.tone}`} key=${t.id}>
    <span class="mark"><${Icon} name=${icon[t.tone] || 'info'} size="16" /></span>
    <div class="grow">${t.title && html`<b class="strong" style="display:block">${t.title}</b>`}${t.message}</div></div>`)}</div>`;
}

// ---------- confirm ----------
let openConfirm = null;
/** await confirm({title, text, ok, danger, input}) → true/false (or the typed text when `input` is set). */
export function confirm(opts) {
  return new Promise((resolve) => openConfirm?.({ ...opts, resolve }));
}

export function ConfirmHost() {
  const [c, setC] = useState(null);
  const [text, setText] = useState('');
  useEffect(() => { openConfirm = (o) => { setText(o.value || ''); setC(o); }; return () => { openConfirm = null; }; }, []);
  if (!c) return null;
  const close = (v) => { c.resolve(v); setC(null); };
  return html`<${Modal} title=${c.title} onClose=${() => close(false)} footer=${html`
      <${Button} variant=${c.danger ? 'danger' : 'primary'} onClick=${() => close(c.input ? text : true)}>${c.ok || 'تأكيد'}</${Button}>
      <${Button} variant="ghost" onClick=${() => close(false)}>إلغاء</${Button}>`}>
    ${c.text && html`<p class="muted">${c.text}</p>`}
    ${c.input && html`<textarea class="textarea mt-12" placeholder=${c.placeholder || ''} value=${text}
      onInput=${(e) => setText(e.currentTarget.value)} autofocus />`}
  </${Modal}>`;
}
