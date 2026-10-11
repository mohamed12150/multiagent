// UI kit — every page builds from these. Keep pages free of one-off widgets.
import { html, cls, useState, useEffect, useRef, useCallback } from '../lib/h.js';
import { Icon } from '../lib/icons.js';
import { CHANNEL_ICON, CHANNEL_LABEL, label as labelOf, tone as toneOf } from '../lib/format.js';

export { Icon };

export const AGENT_ICON = { ceo: 'crown', campaigns: 'target', content: 'wand', coordinator: 'workflow', guardian: 'shield',
  ...CHANNEL_ICON };

export function Button({ variant = '', size = '', icon, iconEnd, loading = false, class: c, children, type = 'button', ...rest }) {
  return html`<button type=${type} class=${cls('btn', variant, size, !children && 'icon', c)} disabled=${loading || rest.disabled} ...${rest}>
    ${loading ? html`<${Icon} name="refresh" size="16" class="spin" />` : icon && html`<${Icon} name=${icon} size=${size === 'xs' ? 14 : 16} />`}
    ${children}
    ${iconEnd && html`<${Icon} name=${iconEnd} size="15" />`}
  </button>`;
}

export function Badge({ tone = '', icon, children, class: c, title }) {
  return html`<span class=${cls('badge', tone, c)} title=${title}>${icon && html`<${Icon} name=${icon} size="12" />`}${children}</span>`;
}

/** Badge from a vocabulary map in format.js (e.g. POST_STATUS). */
export function StatusBadge({ map, value, icon }) {
  return html`<${Badge} tone=${toneOf(map, value)} icon=${icon}>${labelOf(map, value)}</${Badge}>`;
}

export function SimTag({ title = 'بيانات أو مخرجات وضع المحاكاة، أضف المفاتيح لتصبح حقيقية' }) {
  return html`<span class="sim" title=${title}><${Icon} name="beaker" size="13" />محاكاة</span>`;
}

export function Card({ title, icon, actions, children, pad = true, class: c, ...rest }) {
  return html`<section class=${cls('card', c)} ...${rest}>
    ${title && html`<div class="card-head">${icon && html`<span class="mark sm agent"><${Icon} name=${icon} size="15" /></span>`}<h2>${title}</h2>${actions}</div>`}
    ${pad ? html`<div class="card-body">${children}</div>` : children}
  </section>`;
}

export function Empty({ icon = 'sparkles', title, text, action }) {
  return html`<div class="empty"><span class="mark"><${Icon} name=${icon} size="24" /></span>
    ${title && html`<h3>${title}</h3>`}${text && html`<p>${text}</p>`}${action}</div>`;
}

export function Skeleton({ h = 16, w = '100%', lines = 1, gap = 10 }) {
  return html`<div class="col" style=${{ gap: `${gap}px` }}>${Array.from({ length: lines }, (_, i) => html`<div class="skeleton"
    style=${{ height: `${h}px`, width: i === lines - 1 && lines > 1 ? '62%' : w }} />`)}</div>`;
}

export function ErrorBox({ error, retry }) {
  if (!error) return null;
  return html`<div class="notice bad"><${Icon} name="alert" size="18" /><div class="grow"><b>تعذر التحميل</b>${error.message}</div>
    ${retry && html`<${Button} size="sm" icon="refresh" onClick=${() => retry()}>إعادة</${Button}>`}</div>`;
}

/** Loading → error → content, with a skeleton shaped like the content. */
export function Loader({ state, skeleton, children }) {
  if (state.error && !state.data) return html`<${ErrorBox} error=${state.error} retry=${state.reload} />`;
  if (!state.data) return skeleton || html`<${Skeleton} lines=${4} h=${18} />`;
  return children(state.data, state.meta);
}

export function Stat({ label, value, delta, hint, icon }) {
  const up = typeof delta === 'number' ? delta > 0 : null;
  return html`<div class="stat">
    <span class="k row gap-6">${icon && html`<${Icon} name=${icon} size="14" />`}${label}</span>
    <span class="v">${value}</span>
    ${delta !== undefined && delta !== null && html`<span class=${cls('d', up === true && 'up', up === false && 'down')}>${up ? '▲' : up === false ? '▼' : ''} ${typeof delta === 'number' ? Math.abs(delta).toLocaleString('en-US') : delta}</span>`}
    ${hint && html`<span class="tiny faint">${hint}</span>`}
  </div>`;
}

export function Meter({ value = 0, max = 100, tone }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const t = tone || (pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : '');
  return html`<div class=${cls('meter', t)} role="progressbar" aria-valuenow=${value} aria-valuemax=${max}><i style=${{ width: `${pct}%` }} /></div>`;
}

export function Seg({ options, value, onChange, size, accent, label }) {
  return html`<div class=${cls('seg', size, accent && 'accent')} role="radiogroup" aria-label=${label}>
    ${options.map((o) => html`<button type="button" role="radio" aria-checked=${o.value === value} class=${o.value === value ? 'on' : ''}
      title=${o.title} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
  </div>`;
}

export function Tabs({ tabs, value, onChange }) {
  return html`<div class="tabs" role="tablist">${tabs.map((t) => html`<button type="button" role="tab" aria-selected=${t.id === value}
    class=${t.id === value ? 'on' : ''} onClick=${() => onChange(t.id)}>${t.icon && html`<${Icon} name=${t.icon} size="15" />`}${t.label}
    ${t.count ? html`<span class="count">${t.count}</span>` : null}</button>`)}</div>`;
}

export function Toggle({ checked, onChange, label, disabled }) {
  return html`<label class="toggle" title=${label}><input type="checkbox" checked=${!!checked} disabled=${disabled} aria-label=${label}
    onChange=${(e) => onChange(e.currentTarget.checked)} /><span /></label>`;
}

export function Field({ label, help, error, children, class: c }) {
  return html`<div class=${cls('field', c)}>${label && html`<label>${label}</label>`}${children}
    ${error ? html`<span class="error">${error}</span>` : help && html`<span class="help">${help}</span>`}</div>`;
}

export function ChannelMark({ ch, size = '', title }) {
  return html`<span class=${cls('mark', size, `ch-${ch}`)} title=${title || CHANNEL_LABEL[ch]}><${Icon} name=${CHANNEL_ICON[ch]}
    size=${size === 'sm' ? 14 : size === 'lg' ? 22 : 17} /></span>`;
}

export function AgentMark({ id, size = '' }) {
  if (CHANNEL_ICON[id]) return html`<${ChannelMark} ch=${id} size=${size} />`;
  return html`<span class=${cls('mark agent', size)}><${Icon} name=${AGENT_ICON[id] || 'bot'} size=${size === 'sm' ? 14 : size === 'lg' ? 22 : 17} /></span>`;
}

/** Tiny line chart; values left→right in time, drawn right→left for RTL reading. */
export function Spark({ values = [], height = 36, width = 120, color = 'var(--accent)', fill = true }) {
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => [width - i * step, height - 3 - (v / max) * (height - 8)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return html`<svg viewBox=${`0 0 ${width} ${height}`} width=${width} height=${height} aria-hidden="true">
    ${fill && html`<path d=${`${d} L${pts[pts.length - 1][0]},${height} L${width},${height} Z`} fill=${color} opacity="0.12" />`}
    <path d=${d} fill="none" stroke=${color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
}

/** Vertical bars for a small series [{label, value}]. */
export function Bars({ data = [], height = 120, color = 'var(--accent)' }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return html`<div class="bars" style=${{ height: `${height}px` }}>${data.map((d) => html`<div class="bar" title=${`${d.label}: ${d.value}`}>
    <i style=${{ height: `${Math.max(3, (d.value / max) * 100)}%`, background: color }} /><span>${d.short ?? ''}</span></div>`)}</div>`;
}

export function useClickAway(onAway) {
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onAway(); };
    const k = (e) => { if (e.key === 'Escape') onAway(); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [onAway]);
  return ref;
}

/** A stable callback that runs `fn` once, `ms` after the last call (bursts of live events → one reload). */
export function useDebounced(fn, ms) {
  const t = useRef(0);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => () => clearTimeout(t.current), []);
  return useCallback(() => { clearTimeout(t.current); t.current = setTimeout(() => ref.current(), ms); }, [ms]);
}

export function usePoll(fn, ms, deps = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) ref.current(); }, ms);
    return () => clearInterval(id);
  }, [ms, ...deps]);
}

export function Thumb({ asset, class: c, onClick }) {
  const [broken, setBroken] = useState(false);
  const isVideo = asset.kind === 'video';
  return html`<div class=${cls('thumb', c)} onClick=${onClick}>
    ${asset.has_thumb || !isVideo ? (broken ? html`<div class="empty" style="padding:0;height:100%;justify-content:center"><${Icon} name="image" size="22" /></div>`
      : html`<img src=${asset.thumb} alt=${asset.title} loading="lazy" onError=${() => setBroken(true)} />`)
      : html`<div class="empty" style="padding:0;height:100%;justify-content:center"><${Icon} name="video" size="24" /></div>`}
    <span class="kind"><${Icon} name=${isVideo ? 'play' : 'image'} size="13" /></span>
  </div>`;
}

export function KeyVal({ items }) {
  return html`<dl class="kv">${items.filter(Boolean).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}
