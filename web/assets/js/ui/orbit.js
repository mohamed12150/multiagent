// The live network map: القائد at the core, departments on the inner orbit, channel agents on the outer arc,
// الحارس riding the perimeter that encloses everything, and the owner (أنت) giving orders from outside.
// Hand-offs travel as pulses along the links; a node's ring tells its state at a glance.
import { html, cls, useEffect, useRef, useState } from '../lib/h.js';
import { Icon } from '../lib/icons.js';
import { AGENT_ICON } from './core.js';

export const VIEW = { w: 1000, h: 690 };
const C = { x: 500, y: 335 };
const polar = (r, deg) => ({ x: Math.round(C.x + r * Math.cos((deg * Math.PI) / 180)), y: Math.round(C.y + r * Math.sin((deg * Math.PI) / 180)) });

export const POS = {
  ceo: { ...C, r: 50 },
  campaigns: { ...polar(150, -32), r: 36 },
  content: { ...polar(150, -148), r: 36 },
  coordinator: { ...polar(128, 90), r: 36 },
  guardian: { ...polar(298, -90), r: 30 },
  tiktok: { ...polar(255, 14), r: 31 },
  instagram: { ...polar(255, 52), r: 31 },
  x: { ...polar(262, 90), r: 31 },
  whatsapp: { ...polar(255, 128), r: 31 },
  linkedin: { ...polar(255, 166), r: 31 },
  owner: { x: 905, y: 70, r: 26 },
};
const CHANNEL_IDS = ['tiktok', 'instagram', 'x', 'whatsapp', 'linkedin'];
const RING_COLORS = { tiktok: 'var(--c-tiktok)', instagram: 'var(--c-instagram)', x: 'var(--c-x)', whatsapp: 'var(--c-whatsapp)', linkedin: 'var(--c-linkedin)' };

function curve(a, b, bend = 0.18) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = mx - C.x;
  const dy = my - C.y;
  const len = Math.hypot(dx, dy) || 1;
  const k = Math.hypot(b.x - a.x, b.y - a.y) * bend;
  return `M${a.x},${a.y} Q${(mx + (dx / len) * k).toFixed(1)},${(my + (dy / len) * k).toFixed(1)} ${b.x},${b.y}`;
}

export const LINKS = [
  { id: 'owner-ceo', a: 'owner', b: 'ceo', kind: 'command' },
  { id: 'ceo-campaigns', a: 'ceo', b: 'campaigns' },
  { id: 'ceo-content', a: 'ceo', b: 'content' },
  { id: 'ceo-coordinator', a: 'ceo', b: 'coordinator' },
  { id: 'ceo-guardian', a: 'ceo', b: 'guardian', kind: 'watch' },
  ...CHANNEL_IDS.map((ch) => ({ id: `coordinator-${ch}`, a: 'coordinator', b: ch })),
].map((l) => ({ ...l, d: l.a === 'ceo' && l.b !== 'guardian' ? `M${POS[l.a].x},${POS[l.a].y} L${POS[l.b].x},${POS[l.b].y}` : curve(POS[l.a], POS[l.b], l.a === 'owner' ? 0.08 : 0.22) }));

const LINK_BY_PAIR = Object.fromEntries(LINKS.flatMap((l) => [[`${l.a}>${l.b}`, l.d], [`${l.b}>${l.a}`, l.d]]));

/** Where a pulse should travel between two endpoints (agent ids, or 'owner'). */
export function pulsePath(from, to) {
  if (!POS[from] || !POS[to] || from === to) return null;
  const direct = LINK_BY_PAIR[`${from}>${to}`];
  const reversed = direct && LINKS.find((l) => l.d === direct)?.a !== from;
  return { d: direct || curve(POS[from], POS[to], 0.32), reverse: !!reversed };
}

export const endpoint = (who) => (!who ? null : who.startsWith('user:') ? 'owner' : POS[who] ? who : null);

const PULSE_MS = 1400;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A glowing dot travelling along a link (rAF on the path's geometry; skipped under reduced motion). */
function Pulse({ d, reverse, color }) {
  const path = useRef(null);
  const dot = useRef(null);
  useEffect(() => {
    const el = path.current;
    const g = dot.current;
    if (!el || !g || reduced()) return undefined;
    const len = el.getTotalLength();
    let raf = 0;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / PULSE_MS);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const pt = el.getPointAtLength(len * (reverse ? 1 - e : e));
      g.setAttribute('transform', `translate(${pt.x},${pt.y})`);
      g.style.opacity = k > 0.88 ? String((1 - k) / 0.12) : '1';
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [d, reverse]);
  return html`<g class="pulse"><path ref=${path} d=${d} fill="none" stroke="none" />
    <path class="trail" d=${d} style=${{ stroke: color }} />
    <g ref=${dot} style="opacity:0"><circle r="7" style=${{ fill: color }} filter="url(#soft)" /><circle r="3.6" style=${{ fill: color }} /></g></g>`;
}

function Node({ id, agent, selected, onPick, dim }) {
  const p = POS[id];
  const status = agent?.paused ? 'paused' : agent?.status || 'idle';
  const isChannel = CHANNEL_IDS.includes(id);
  const tint = isChannel ? RING_COLORS[id] : 'var(--accent)';
  const label = agent?.name || '';
  const note = status === 'working' ? agent?.status_note : status === 'error' ? 'تعثّر — افتح التفاصيل' : '';
  const iconSize = id === 'ceo' ? 30 : 21;
  return html`<g class=${cls('node', `st-${status}`, selected && 'sel', dim && 'dim', isChannel && 'channel')} data-id=${id}
      tabindex="0" role="button" aria-label=${`${label}: ${status}`} onClick=${() => onPick?.(id)}
      onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick?.(id); } }}>
    <circle class="halo" cx=${p.x} cy=${p.y} r=${p.r + 14} style=${{ fill: tint }} />
    <circle class="body" cx=${p.x} cy=${p.y} r=${p.r} />
    <circle class="ring" cx=${p.x} cy=${p.y} r=${p.r + 5} style=${{ stroke: tint }} />
    <circle class="spin" cx=${p.x} cy=${p.y} r=${p.r + 5} style=${{ stroke: tint }} />
    <g transform=${`translate(${p.x - iconSize / 2},${p.y - iconSize / 2})`} class="glyph" style=${{ color: isChannel ? tint : id === 'ceo' ? '#fff' : 'var(--accent-text)' }}>
      <${Icon} name=${AGENT_ICON[id]} size=${iconSize} />
    </g>
    <text class="lbl" x=${p.x} y=${p.y + p.r + 24} text-anchor="middle">${label}</text>
    ${note && html`<text class="note" x=${p.x} y=${p.y + p.r + 42} text-anchor="middle">${note.length > 34 ? `${note.slice(0, 33)}…` : note}</text>`}
  </g>`;
}

export function OrbitMap({ agents = [], pulses = [], pings = [], selected, onPick, ownerLabel = 'أنت' }) {
  const by = Object.fromEntries(agents.map((a) => [a.id, a]));
  const ids = ['guardian', 'campaigns', 'content', 'coordinator', ...CHANNEL_IDS, 'ceo'];
  const o = POS.owner;
  return html`<svg class="orbit" viewBox=${`0 0 ${VIEW.w} ${VIEW.h}`} role="img" aria-label="خريطة الشبكة الحية">
    <defs>
      <radialGradient id="core" cx="50%" cy="38%" r="70%"><stop offset="0" stop-color="#8f8fff" /><stop offset="1" stop-color="#4b4be0" /></radialGradient>
      <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" /></filter>
    </defs>
    <circle class="orbit-ring" cx=${C.x} cy=${C.y} r="150" />
    <circle class="orbit-ring" cx=${C.x} cy=${C.y} r="255" />
    <circle class="guard-ring" cx=${C.x} cy=${C.y} r="298" />
    ${LINKS.map((l) => html`<path key=${l.id} class=${cls('link', l.kind)} d=${l.d} />`)}
    ${pulses.map((p) => html`<${Pulse} key=${p.key} d=${p.d} reverse=${p.reverse} color=${p.color} />`)}
    <g class="owner" transform=${`translate(${o.x},${o.y})`}>
      <circle r=${o.r} class="body" /><g transform="translate(-10,-10)" style="color:var(--text-2)"><${Icon} name="user" size="20" /></g>
      <text class="lbl" y=${o.r + 20} text-anchor="middle">${ownerLabel}</text>
    </g>
    ${ids.map((id) => html`<${Node} key=${id} id=${id} agent=${by[id]} selected=${selected === id} onPick=${onPick}
      dim=${by[id] && !by[id].enabled} />`)}
    ${pings.map((p) => html`<circle key=${p.key} class="ping" cx=${POS[p.id].x} cy=${POS[p.id].y} r=${POS[p.id].r + 4} style=${{ stroke: p.color }} />`)}
  </svg>`;
}

/** Turns live task frames into pulses/pings with automatic expiry. */
export function usePulses() {
  const [pulses, setPulses] = useState([]);
  const [pings, setPings] = useState([]);
  const seq = useRef(0);
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const fire = (from, to, color = 'var(--live)') => {
    const a = endpoint(from);
    const b = endpoint(to);
    if (!a && !b) return;
    if (!a || !b || a === b) {
      const id = b || a;
      const key = ++seq.current;
      setPings((xs) => [...xs.slice(-12), { key, id, color }]);
      timers.current.push(setTimeout(() => setPings((xs) => xs.filter((x) => x.key !== key)), 1400));
      return;
    }
    const path = pulsePath(a, b);
    if (!path) return;
    const key = ++seq.current;
    setPulses((xs) => [...xs.slice(-16), { key, ...path, color }]);
    timers.current.push(setTimeout(() => setPulses((xs) => xs.filter((x) => x.key !== key)), 1700));
  };
  return { pulses, pings, fire };
}
