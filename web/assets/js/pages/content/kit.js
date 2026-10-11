// Page-level helpers shared by the content and library pages (styles live in content.css under `ct-`).
import { html, useState, useEffect, useRef, useCallback } from '../../lib/h.js';
import { num } from '../../lib/format.js';
import { Icon } from '../../ui/core.js';
import { confirm } from '../../ui/overlays.js';

const SEARCH_DEBOUNCE_MS = 350;

export function useDebounced(fn, ms) {
  const timer = useRef(0);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => ref.current(), ms);
  }, [ms]);
}

/** Arabic counted noun: [one, two, few (3-10), many (11+)] → «منشور واحد», «منشوران», «3 منشورات», «12 منشورًا». */
export function counted(n, [one, two, few, many]) {
  if (n === 1) return one;
  if (n === 2) return two;
  const rest = n % 100;
  return `${num(n)} ${rest >= 3 && rest <= 10 ? few : many}`;
}
export const POSTS = ['منشور واحد', 'منشوران', 'منشورات', 'منشورًا'];
export const FILES = ['ملف واحد', 'ملفان', 'ملفات', 'ملفًا'];

/**
 * Drawers that open confirms: the shared overlays close every layer on one Escape press, so a drawer routes its
 * onClose through `close`, which ignores the press while one of its own confirms (`ask`) is still open.
 */
export function useLayer(onClose) {
  const held = useRef(0);
  const ref = useRef(onClose);
  ref.current = onClose;
  const ask = useCallback(async (opts) => {
    held.current += 1;
    try { return await confirm(opts); } finally { setTimeout(() => { held.current -= 1; }, 0); }
  }, []);
  const close = useCallback(() => { if (!held.current) ref.current(); }, []);
  return { ask, close };
}

/** A modal opened above a drawer: Escape closes only this modal (captured before the drawer's listener). */
export function useTopEscape(onClose) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); ref.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
}

/** Search input that commits (debounced) to the URL; follows outside changes such as «امسح الفلاتر». */
export function SearchBox({ value = '', onCommit, placeholder, label }) {
  const [text, setText] = useState(value);
  const latest = useRef(value);
  useEffect(() => { if (value !== latest.current) { latest.current = value; setText(value); } }, [value]);
  const commit = useDebounced(() => onCommit(latest.current.trim()), SEARCH_DEBOUNCE_MS);
  const change = (v) => { latest.current = v; setText(v); commit(); };
  return html`<label class="ct-search">
    <${Icon} name="search" size="16" />
    <input type="search" value=${text} placeholder=${placeholder} aria-label=${label || placeholder}
      onInput=${(e) => change(e.currentTarget.value)} />
    ${text && html`<button type="button" class="ct-search-x" aria-label="مسح البحث" onClick=${() => change('')}><${Icon} name="x" size="14" /></button>`}
  </label>`;
}

/**
 * Tags as chips. `prefix="#"` turns it into a hashtag input (spaces split tags); without it, tags may hold spaces
 * and split on commas only.
 */
export function ChipsInput({ value = [], onChange, placeholder, prefix = '', max = 30, disabled = false, label }) {
  const [text, setText] = useState('');
  const input = useRef(null);
  const splitter = prefix ? /[\s,،]+/ : /[,،\n]+/;
  const norm = (raw) => {
    const t = raw.trim().replace(/^#+/, '').trim();
    if (!t) return '';
    return prefix ? `${prefix}${t.replace(/\s+/g, '_')}` : t;
  };
  const add = (raw) => {
    const pieces = raw.split(splitter).map(norm).filter(Boolean);
    if (!pieces.length) return;
    const merged = [...new Set([...value, ...pieces])].slice(0, max);
    if (merged.length !== value.length) onChange(merged);
  };
  const remove = (tag) => onChange(value.filter((t) => t !== tag));
  const key = (e) => {
    const sep = e.key === 'Enter' || e.key === ',' || e.key === '،' || (prefix && e.key === ' ');
    if (sep) {
      e.preventDefault();
      add(text);
      setText('');
    } else if (e.key === 'Backspace' && !text && value.length) {
      remove(value[value.length - 1]);
    }
  };
  const paste = (e) => {
    const data = e.clipboardData?.getData('text') || '';
    if (!splitter.test(data)) return;
    e.preventDefault();
    add(`${text} ${data}`);
    setText('');
  };
  if (disabled) {
    return value.length
      ? html`<div class="row wrap gap-6">${value.map((t) => html`<span class="ct-tag" key=${t}>${t}</span>`)}</div>`
      : html`<p class="small faint">لا توجد</p>`;
  }
  const full = value.length >= max;
  return html`<div class="ct-chips-in" onClick=${() => input.current?.focus()}>
    ${value.map((t) => html`<span class="ct-tag" key=${t}>${t}
      <button type="button" aria-label=${`إزالة ${t}`} onClick=${(e) => { e.stopPropagation(); remove(t); }}><${Icon} name="x" size="12" /></button></span>`)}
    <input ref=${input} value=${text} disabled=${full} aria-label=${label || placeholder}
      placeholder=${full ? `الحد ${max}` : value.length ? '' : placeholder}
      onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${key} onPaste=${paste}
      onBlur=${() => { if (text.trim()) { add(text); setText(''); } }} />
  </div>`;
}

/** Channel colour hook-up: `ct-c-<channel>` sets --ch for any element. */
export const chClass = (ch) => `ct-c-${ch}`;
