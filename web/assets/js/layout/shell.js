// App frame: side rail, top bar (autonomy, approvals, notifications, theme, account) and the phone tab bar.
import { html, cls, useState, useEffect, useCallback } from '../lib/h.js';
import { Icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { Link, navigate, useRoute } from '../lib/router.js';
import { useLive, useLiveStatus } from '../lib/live.js';
import { session, shell, useStore, can } from '../lib/store.js';
import { AUTONOMY, CHANNELS, CHANNEL_LABEL, ago, setTimeZone } from '../lib/format.js';
import { ChannelMark, useClickAway } from '../ui/core.js';
import { ToastHost, ConfirmHost, toast } from '../ui/overlays.js';

export function BrandMark({ size = 36 }) {
  return html`<svg class="brand-mark" width=${size} height=${size} viewBox="0 0 64 64" aria-hidden="true">
    <defs><linearGradient id="bm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8585ff" /><stop offset="1" stop-color="#46c2d2" /></linearGradient></defs>
    <rect width="64" height="64" rx="18" fill="#0d1428" />
    <circle cx="32" cy="32" r="19" fill="none" stroke="url(#bm)" stroke-width="2.2" opacity="0.55" />
    <circle cx="32" cy="32" r="8.5" fill="url(#bm)" />
    <circle cx="32" cy="13" r="3.6" fill="#46c2d2" /><circle cx="48.5" cy="41.5" r="3.6" fill="#8585ff" /><circle cx="15.5" cy="41.5" r="3.6" fill="#46c2d2" />
  </svg>`;
}

const NAV = [
  { href: '/', icon: 'orbit', label: 'الشبكة الحية' },
  { href: '/approvals', icon: 'checkCircle', label: 'مكتب الاعتماد', badge: 'approvals' },
  { group: 'التسويق' },
  { href: '/campaigns', icon: 'megaphone', label: 'الحملات' },
  { href: '/content', icon: 'kanban', label: 'المحتوى' },
  { href: '/library', icon: 'image', label: 'المكتبة' },
  { group: 'القنوات' },
  ...CHANNELS.map((ch) => ({ href: `/channels/${ch}`, channel: ch, label: CHANNEL_LABEL[ch] })),
  { group: 'العملاء والتشغيل' },
  { href: '/inbox', icon: 'message', label: 'التفاعل مع العملاء' },
  { href: '/reports', icon: 'chart', label: 'التقارير' },
  { href: '/guardian', icon: 'shield', label: 'الحارس' },
  { href: '/settings', icon: 'sliders', label: 'الإعدادات' },
];

const isOn = (href, path) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));

function NavList({ path, counts, onPick }) {
  return html`<nav class="nav">${NAV.map((n, i) => n.group
    ? html`<div class="nav-group" key=${`g${i}`}>${n.group}</div>`
    : html`<${Link} key=${n.href} href=${n.href} class=${isOn(n.href, path) ? 'on' : ''} onClick=${onPick}>
        ${n.channel ? html`<${ChannelMark} ch=${n.channel} size="sm" />` : html`<${Icon} name=${n.icon} size="19" />`}
        <span>${n.label}</span>
        ${n.badge && counts[n.badge] ? html`<span class="count">${counts[n.badge]}</span>` : null}
      </${Link}>`)}</nav>`;
}

function Side({ path, counts }) {
  const live = useLiveStatus();
  const company = useStore(session).company;
  return html`<aside class="side">
    <div class="brand"><${BrandMark} /><div><b>Qhub Smart Marketing</b><span>${company}</span></div></div>
    <${NavList} path=${path} counts=${counts} />
    <div class="side-foot"><div class="engine"><span class=${cls('status-dot', live ? 'working' : 'error')} />
      ${live ? 'الشبكة متصلة مباشرة' : 'إعادة الاتصال بالشبكة…'}</div></div>
  </aside>`;
}

export function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try { localStorage.setItem('qsm-theme', mode); } catch { /* storage blocked */ }
}

function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set) return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function AutonomyMenu({ level }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(useCallback(() => setOpen(false), []));
  const pick = async (v) => {
    setOpen(false);
    try {
      await api.post('/settings/autonomy', { level: v });
      shell.set({ autonomy: v });
      toast(`مستوى الاستقلالية: ${AUTONOMY[v][0]}`);
    } catch (e) { toast.error(e); }
  };
  return html`<div style="position:relative" ref=${ref}>
    <button class="autonomy-pill" onClick=${() => setOpen(!open)} aria-haspopup="menu" title="مستوى استقلالية الوكلاء">
      <${Icon} name="gauge" size="16" /><span class="lbl">الاستقلالية:</span><b>${AUTONOMY[level]?.[0]}</b></button>
    ${open && html`<div class="menu" style="inset-inline-end:0;top:42px;width:300px" role="menu">
      ${Object.entries(AUTONOMY).map(([k, [name, hint]]) => html`<button role="menuitemradio" aria-checked=${k === level}
        disabled=${!can('autonomy')} onClick=${() => pick(k)}>
        <${Icon} name=${k === level ? 'checkCircle' : 'gauge'} size="17" /><span class="col gap-4" style="gap:0"><b>${name}</b><span class="tiny muted">${hint}</span></span></button>`)}
      ${!can('autonomy') && html`<p class="tiny faint" style="padding:6px 10px">يغيّره المالك فقط</p>`}
    </div>`}
  </div>`;
}

const LEVEL_ICON = { success: 'checkCircle', warning: 'alert', danger: 'alert', info: 'info' };

function Notifications({ unread }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const ref = useClickAway(useCallback(() => setOpen(false), []));
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      try {
        setItems(await api.get('/notifications?limit=30'));
        if (unread) { await api.post('/notifications/read'); shell.set({ unread: 0 }); }
      } catch (e) { toast.error(e); }
    }
  };
  return html`<div ref=${ref}>
    <button class="icon-btn" aria-label="الإشعارات" onClick=${toggle}><${Icon} name="bell" size="19" />
      ${unread ? html`<span class="count">${unread}</span>` : null}</button>
    ${open && html`<div class="notif-panel" role="dialog" aria-label="الإشعارات">
      ${!items ? html`<p class="muted small" style="padding:12px">…</p>` : !items.length ? html`<p class="muted small" style="padding:16px">لا إشعارات بعد</p>`
        : items.map((n) => html`<div class=${cls('notif', !n.read && 'unread')} key=${n.id} onClick=${() => { if (n.link) { navigate(n.link); setOpen(false); } }}>
          <span class=${`mark ${n.level === 'danger' ? 'ch-instagram' : 'agent'}`}><${Icon} name=${LEVEL_ICON[n.level] || 'bell'} size="15" /></span>
          <div class="grow"><b class="small">${n.title}</b><p class="small muted pre clamp-3">${n.body}</p><span class="tiny faint">${ago(n.created_at)}</span></div></div>`)}
    </div>`}
  </div>`;
}

function Account() {
  const { user } = useStore(session);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(currentTheme());
  const ref = useClickAway(useCallback(() => setOpen(false), []));
  const flip = () => { const t = theme === 'dark' ? 'light' : 'dark'; applyTheme(t); setTheme(t); };
  const logout = async () => { try { await api.post('/auth/logout'); } finally { location.href = '/'; } };
  return html`<button class="icon-btn" aria-label="تبديل المظهر" onClick=${flip}><${Icon} name=${theme === 'dark' ? 'sun' : 'moon'} size="18" /></button>
    <div style="position:relative" ref=${ref}>
      <button class="avatar" aria-label="الحساب" onClick=${() => setOpen(!open)}>${(user?.name || '؟').trim().slice(0, 1)}</button>
      ${open && html`<div class="menu" style="inset-inline-end:0;top:44px">
        <div style="padding:8px 10px 10px"><b>${user?.name}</b><div class="tiny muted ltr">${user?.email}</div></div>
        <${Link} href="/settings/account" onClick=${() => setOpen(false)}><${Icon} name="user" size="17" />حسابي</${Link}>
        <${Link} href="/settings" onClick=${() => setOpen(false)}><${Icon} name="sliders" size="17" />الإعدادات</${Link}>
        <button onClick=${logout}><${Icon} name="logout" size="17" />تسجيل الخروج</button></div>`}
    </div>`;
}

function TabBar({ path, counts }) {
  const [more, setMore] = useState(false);
  const tabs = [
    { href: '/', icon: 'orbit', label: 'الشبكة' }, { href: '/approvals', icon: 'checkCircle', label: 'الاعتماد', badge: 'approvals' },
    { href: '/content', icon: 'kanban', label: 'المحتوى' }, { href: '/inbox', icon: 'message', label: 'العملاء' },
  ];
  return html`<nav class="tabbar">${tabs.map((t) => html`<${Link} key=${t.href} href=${t.href} class=${isOn(t.href, path) ? 'on' : ''}>
      <${Icon} name=${t.icon} size="21" />${t.label}${t.badge && counts[t.badge] ? html`<span class="count">${counts[t.badge]}</span>` : null}</${Link}>`)}
    <button class=${more ? 'on' : ''} onClick=${() => setMore(!more)}><${Icon} name="grid" size="21" />المزيد</button></nav>
    ${more && html`<div class="overlay" onClick=${() => setMore(false)} /><div class="more-sheet"><${NavList} path=${path} counts=${counts} onPick=${() => setMore(false)} /></div>`}`;
}

export function Shell({ title, children }) {
  const { path } = useRoute();
  const s = useStore(shell);
  useEffect(() => {
    api.raw('/approvals?limit=1').then((j) => shell.set({ approvals: Object.values(j.meta?.counts || {}).reduce((a, b) => a + b, 0) })).catch(() => {});
    api.raw('/notifications?limit=1').then((j) => shell.set({ unread: j.meta?.unread || 0 })).catch(() => {});
    api.get('/network').then((n) => shell.set({ autonomy: n.autonomy, aiLive: n.ai_live })).catch(() => {});
    api.get('/settings').then((st) => setTimeZone(st.sections?.general?.timezone)).catch(() => {});
  }, []);
  useLive('approvals', (d) => shell.set({ approvals: d.pending }));
  useLive('autonomy', (d) => shell.set({ autonomy: d.level }));
  useLive('notification', (n) => {
    shell.set((st) => ({ unread: st.unread + 1 }));
    toast(n.body ? n.body.split('\n')[0] : '', n.level === 'danger' || n.level === 'warning' ? 'warn' : 'ok', n.title);
  });
  useEffect(() => { document.title = `${title} · Qhub Smart Marketing`; }, [title]);
  const counts = { approvals: s.approvals };
  return html`<div class="shell">
    <${Side} path=${path} counts=${counts} />
    <div class="main">
      <header class="topbar"><h1>${title}</h1><div class="top-actions">
        <${AutonomyMenu} level=${s.autonomy} />
        <${Link} href="/approvals" class="icon-btn" aria-label="مكتب الاعتماد"><${Icon} name="checkCircle" size="19" />${s.approvals ? html`<span class="count">${s.approvals}</span>` : null}</${Link}>
        <${Notifications} unread=${s.unread} />
        <${Account} />
      </div></header>
      <main class="page" id="main">${children}</main>
    </div>
    <${TabBar} path=${path} counts=${counts} />
    <${ToastHost} /><${ConfirmHost} />
  </div>`;
}
