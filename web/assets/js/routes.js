// Route table. Pages are loaded on demand; each default-exports a component receiving {params, query}.
export const ROUTES = [
  { path: '/', title: 'الشبكة الحية', load: () => import('./pages/network.js') },
  { path: '/approvals', title: 'مكتب الاعتماد', load: () => import('./pages/approvals.js') },
  { path: '/campaigns', title: 'الحملات', load: () => import('./pages/campaigns.js') },
  { path: '/campaigns/:id', title: 'الحملة', load: () => import('./pages/campaigns.js') },
  { path: '/content', title: 'المحتوى', load: () => import('./pages/content.js') },
  { path: '/library', title: 'المكتبة', load: () => import('./pages/library.js') },
  { path: '/channels/:ch', title: 'القنوات', load: () => import('./pages/channels.js') },
  { path: '/inbox', title: 'التفاعل مع العملاء', load: () => import('./pages/inbox.js') },
  { path: '/reports', title: 'التقارير', load: () => import('./pages/reports.js') },
  { path: '/reports/:id', title: 'التقرير', load: () => import('./pages/reports.js') },
  { path: '/guardian', title: 'الحارس', load: () => import('./pages/guardian.js') },
  { path: '/settings', title: 'الإعدادات', load: () => import('./pages/settings.js') },
  { path: '/settings/:tab', title: 'الإعدادات', load: () => import('./pages/settings.js') },
];
