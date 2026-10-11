// Tiny observable stores shared across the app (session, shell counters).
import { useEffect, useState } from './h.js';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      subs.forEach((fn) => fn(state));
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

export function useStore(store) {
  const [s, setS] = useState(store.get());
  useEffect(() => store.subscribe(setS), [store]);
  return s;
}

export const session = createStore({ user: null, company: '', ready: false, setupNeeded: false });
export const shell = createStore({ approvals: 0, unread: 0, autonomy: 'assisted', aiLive: false });

const RANK = { viewer: 0, editor: 1, manager: 2, owner: 3 };
export const can = (minimum) => (RANK[session.get().user?.role] ?? -1) >= RANK[minimum];
