// الإعدادات: a settings sub-navigation (vertical on desktop, scrolling tabs on phones) and one module per tab
// under pages/settings/. Routes /settings and /settings/:tab land here; the default tab is the brand brief.
import { html, cls, useEffect, useRef } from '../lib/h.js';
import { can, capLabel } from '../lib/store.js';
import { Icon, Button, Empty } from '../ui/core.js';
import { go } from './settings/kit.js';
import BrandTab from './settings/brand.js';
import AgentsTab from './settings/agents.js';
import PermissionsTab from './settings/permissions.js';
import ConnectionsTab from './settings/connections.js';
import NotificationsTab from './settings/notifications.js';
import GeneralTab from './settings/general.js';
import UsersTab from './settings/users.js';
import GoalsTab from './settings/goals.js';
import AccountTab from './settings/account.js';

const TABS = [
  { id: 'brand', label: 'العلامة', hint: 'الملف الذي يقرؤه كل وكيل', icon: 'palette', view: BrandTab },
  { id: 'agents', label: 'الوكلاء', hint: 'النموذج والجدول والتعليمات', icon: 'bot', view: AgentsTab },
  { id: 'permissions', label: 'الاستقلالية والصلاحيات', hint: 'ما يفعله الوكلاء وحدهم', icon: 'gauge', view: PermissionsTab },
  { id: 'goals', label: 'أهداف القائد', hint: 'ما يسعى إليه وكيف يتدخل', icon: 'target', view: GoalsTab },
  { id: 'connections', label: 'الربط', hint: 'Claude والقنوات والبريد', icon: 'plug', min: 'connections', view: ConnectionsTab },
  { id: 'notifications', label: 'الإشعارات والتقارير', hint: 'متى وأين يصلك التقرير', icon: 'bell', view: NotificationsTab },
  { id: 'general', label: 'عام والذكاء الاصطناعي', hint: 'التوقيت والرابط العام والتكلفة', icon: 'globe', view: GeneralTab },
  { id: 'users', label: 'الفريق', hint: 'الأعضاء وصلاحياتهم', icon: 'users', min: 'users', view: UsersTab },
  { id: 'account', label: 'حسابي', hint: 'بياناتك وكلمة المرور', icon: 'user', view: AccountTab },
];
const BY_ID = Object.fromEntries(TABS.map((t) => [t.id, t]));
const DEFAULT_TAB = 'brand';

/** Top-bar title (the shell calls this with the route params). */
export function title(params) {
  const tab = BY_ID[params?.tab || DEFAULT_TAB];
  return tab ? `الإعدادات · ${tab.label}` : 'الإعدادات';
}

function SubNav({ current }) {
  const ref = useRef(null);
  const tabs = TABS.filter((t) => !t.min || can(t.min));
  useEffect(() => { // phones: keep the active tab visible in the scrolling strip
    const el = ref.current?.querySelector('a.on');
    if (el && ref.current.scrollWidth > ref.current.clientWidth) el.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [current]);
  const click = (e, id) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    if (id !== current) go(`/settings/${id}`);
  };
  return html`<nav class="st-nav" ref=${ref} aria-label="أقسام الإعدادات">${tabs.map((t) => html`
    <a key=${t.id} href=${`/settings/${t.id}`} class=${cls(t.id === current && 'on')} aria-current=${t.id === current ? 'page' : undefined}
      onClick=${(e) => click(e, t.id)}>
      <span class="st-nav-ico"><${Icon} name=${t.icon} size="16" /></span>
      <span class="st-nav-txt"><b>${t.label}</b><small>${t.hint}</small></span>
    </a>`)}</nav>`;
}

export default function SettingsPage({ params, query }) {
  const id = params?.tab || DEFAULT_TAB;
  const tab = BY_ID[id];
  let body;
  if (!tab) {
    body = html`<${Empty} icon="compass" title="هذا القسم غير موجود" text="اختر قسمًا من القائمة، أو ابدأ بملف العلامة الذي يقرؤه كل وكيل."
      action=${html`<${Button} size="sm" icon="palette" onClick=${() => go('/settings/brand')}>ملف العلامة</${Button}>`} />`;
  } else if (tab.min && !can(tab.min)) {
    body = html`<${Empty} icon="lock" title="لا تملك صلاحية هذا القسم"
      text=${`يحتاج هذا القسم صلاحية «${capLabel(tab.min)}». اطلبها من مالك الحساب إذا احتجت إليها.`} />`;
  } else {
    const View = tab.view;
    body = html`<${View} query=${query || {}} />`;
  }
  return html`<div class="st"><${SubNav} current=${tab ? id : ''} /><div class="st-main">${body}</div></div>`;
}
