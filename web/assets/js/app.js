// Entry: theme → session → (setup | login | shell + routed page).
import { html, render, useEffect, useState } from './lib/h.js';
import { api, onUnauthorized } from './lib/api.js';
import { connect, disconnect } from './lib/live.js';
import { match, useRoute } from './lib/router.js';
import { session, useStore } from './lib/store.js';
import { ROUTES } from './routes.js';
import { Shell, applyTheme } from './layout/shell.js';
import { Auth } from './pages/auth.js';
import { Empty, ErrorBox, Skeleton } from './ui/core.js';

try { const t = localStorage.getItem('qsm-theme'); if (t) applyTheme(t); } catch { /* storage blocked */ }

const cache = new Map();

function resolve(path) {
  for (const r of ROUTES) {
    const params = match(r.path, path);
    if (params) return { route: r, params };
  }
  return null;
}

function Routed() {
  const { path, query } = useRoute();
  const found = resolve(path);
  const [mod, setMod] = useState(() => (found ? cache.get(found.route.path) : null));
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!found) return;
    const key = found.route.path;
    if (cache.has(key)) { setMod(cache.get(key)); return; }
    setMod(null);
    setError(null);
    found.route.load().then((m) => { cache.set(key, m); setMod(m); }).catch(setError);
  }, [found?.route.path]);
  const title = found?.route.title || 'غير موجود';
  if (!found) {
    return html`<${Shell} title=${title}><${Empty} icon="compass" title="الصفحة غير موجودة" text="تحقق من الرابط أو عد للشبكة الحية." /></${Shell}>`;
  }
  const Page = mod?.default;
  return html`<${Shell} title=${mod?.title?.(found.params) || title}>
    ${error ? html`<${ErrorBox} error=${error} retry=${() => location.reload()} />`
      : Page ? html`<${Page} params=${found.params} query=${query} key=${path} />` : html`<${Skeleton} lines=${6} h=${22} />`}
  </${Shell}>`;
}

function App() {
  const s = useStore(session);
  useEffect(() => {
    onUnauthorized(() => { disconnect(); session.set({ user: null }); });
    api.get('/auth/state')
      .then((st) => session.set({ ready: true, user: st.user, company: st.company, setupNeeded: st.setup_needed }))
      .catch(() => session.set({ ready: true }));
  }, []);
  useEffect(() => { if (s.user) connect(); }, [s.user?.id]);
  if (!s.ready) return html`<div style="display:grid;place-items:center;min-height:100dvh"><${Skeleton} w="180px" /></div>`;
  if (!s.user) return html`<${Auth} setup=${s.setupNeeded} />`;
  return html`<${Routed} />`;
}

render(html`<${App} />`, document.getElementById('app'));
