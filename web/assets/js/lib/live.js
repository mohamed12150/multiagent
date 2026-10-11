// The live stream (SSE). One EventSource for the whole app; components subscribe by frame kind.
import { useEffect, useRef, useState } from './h.js';

const KINDS = ['feed', 'task', 'agent', 'approvals', 'notification', 'incident', 'inbox', 'metrics', 'autonomy'];
const subs = new Map();
const statusSubs = new Set();
let source = null;
let connected = false;
let retryTimer = null;

function setConnected(v) {
  connected = v;
  statusSubs.forEach((fn) => fn(v));
}

function dispatch(kind, frame) {
  (subs.get(kind) || new Set()).forEach((fn) => { try { fn(frame.data, frame); } catch (e) { console.warn(e); } });
  (subs.get('*') || new Set()).forEach((fn) => { try { fn(frame.data, frame); } catch (e) { console.warn(e); } });
}

export function connect() {
  if (source) return;
  source = new EventSource('/api/stream');
  source.onopen = () => setConnected(true);
  source.onerror = () => {
    setConnected(false);
    if (source && source.readyState === EventSource.CLOSED) {
      source = null;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, 4000);
    }
  };
  KINDS.forEach((k) => source.addEventListener(k, (ev) => {
    try { dispatch(k, JSON.parse(ev.data)); } catch { /* malformed frame */ }
  }));
}

export function disconnect() {
  if (source) source.close();
  source = null;
  setConnected(false);
}

export function on(kind, fn) {
  if (!subs.has(kind)) subs.set(kind, new Set());
  subs.get(kind).add(fn);
  return () => subs.get(kind).delete(fn);
}

/** Subscribe for the component's lifetime; the latest handler is always used. */
export function useLive(kind, fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => on(kind, (d, f) => ref.current(d, f)), [kind]);
}

export function useLiveStatus() {
  const [v, setV] = useState(connected);
  useEffect(() => { statusSubs.add(setV); return () => statusSubs.delete(setV); }, []);
  return v;
}
