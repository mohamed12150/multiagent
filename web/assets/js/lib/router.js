// Minimal history router: navigate(), useRoute(), and <Link>.
import { html, useEffect, useState } from './h.js';

const subs = new Set();

function snapshot() {
  const url = new URL(location.href);
  return { path: url.pathname.replace(/\/+$/, '') || '/', query: Object.fromEntries(url.searchParams) };
}

export function navigate(to, { replace = false } = {}) {
  if (to === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', to);
  subs.forEach((fn) => fn(snapshot()));
  window.scrollTo({ top: 0 });
}

/** Update the query string without a new history entry (filters, tabs). */
export function setQuery(patch) {
  const url = new URL(location.href);
  Object.entries(patch).forEach(([k, v]) => (v === null || v === undefined || v === '' ? url.searchParams.delete(k) : url.searchParams.set(k, v)));
  history.replaceState({}, '', url.pathname + url.search);
  subs.forEach((fn) => fn(snapshot()));
}

let leaveGuard = null;
/** A page with unsaved work registers `async () => boolean`; every <Link> asks it before leaving. */
export function setLeaveGuard(fn) { leaveGuard = fn; }

export async function requestNavigate(to) {
  if (leaveGuard && !(await leaveGuard())) return false;
  navigate(to);
  return true;
}

window.addEventListener('popstate', () => subs.forEach((fn) => fn(snapshot())));

export function useRoute() {
  const [r, setR] = useState(snapshot);
  useEffect(() => { subs.add(setR); return () => subs.delete(setR); }, []);
  return r;
}

/** Match "/channels/:ch" against a path → params or null. */
export function match(pattern, path) {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export function Link({ href, class: cls, children, onClick, ...rest }) {
  const go = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    onClick?.(e);
    requestNavigate(href);
  };
  return html`<a href=${href} class=${cls} onClick=${go} ...${rest}>${children}</a>`;
}
