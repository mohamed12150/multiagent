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

// What the signed-in member may do: one capability per write action, mirrored from qsm/permissions.py.
// The server enforces every one of them; the UI only hides what would be refused.
export const CAP_LABELS = {
  command: 'أوامر القائد وتشغيل الوكلاء', content: 'كتابة المحتوى وجدولته', library: 'رفع التصاميم وإدارة المكتبة',
  approve: 'الاعتماد', proposals: 'مقترحات الحملات والمنافسون', campaigns: 'إدارة الحملات',
  inbox: 'التفاعل مع العملاء', reports: 'التقارير',
  agents: 'إعدادات الوكلاء والحارس', settings: 'ملف العلامة والذكاء الاصطناعي', connections: 'الربط والمفاتيح',
  autonomy: 'الاستقلالية والصلاحيات والليمت', notify: 'الإشعارات والإعدادات العامة', users: 'إدارة المستخدمين',
};
export const capLabel = (key) => CAP_LABELS[key] || key;
export const can = (cap) => {
  const user = session.get().user;
  return !!user && (user.role === 'owner' || (user.caps || []).includes(cap));
};
