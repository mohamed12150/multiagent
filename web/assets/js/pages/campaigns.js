// الحملات: running campaigns, proposals from مدير الحملات, competitors, and the limits with his raise authority.
// /campaigns renders the tabbed home (?tab=proposals|competitors|limits, ?status= on the first tab); /campaigns/:id the detail.
import { html, useState } from '../lib/h.js';
import { useApi } from '../lib/api.js';
import { useLive } from '../lib/live.js';
import { navigate, setQuery } from '../lib/router.js';
import { can } from '../lib/store.js';
import { Button, Tabs, Loader, useDebounced } from '../ui/core.js';
import { toast } from '../ui/overlays.js';
import { CampaignsTab, StripsSkeleton } from './campaigns/list.js';
import { ProposalsTab, ProposalsSkeleton } from './campaigns/proposals.js';
import { CompetitorsTab } from './campaigns/competitors.js';
import { LimitsTab } from './campaigns/limits.js';
import { CampaignDetail } from './campaigns/detail.js';
import { ProposeModal, ManualDrawer } from './campaigns/forms.js';

const TABS = ['campaigns', 'proposals', 'competitors', 'limits'];
const ENDED = new Set(['done', 'failed', 'waiting']);

export function title(params) {
  return params?.id ? 'تفاصيل الحملة' : 'الحملات';
}

function Home({ query }) {
  const tab = TABS.includes(query.tab) ? query.tab : 'campaigns';
  const st = useApi('/campaigns');
  const [overlay, setOverlay] = useState('');
  const [proposing, setProposing] = useState(null);
  const reload = useDebounced(() => st.reload(true), 1200);

  useLive('task', (d) => {
    const t = d.task || {};
    if (!(t.kind || '').startsWith('campaigns.')) return;
    if (t.kind === 'campaigns.propose' && (d.event === 'created' || d.event === 'started')) {
      if (!proposing) setProposing(t.id);
      return;
    }
    if (!ENDED.has(d.event)) return;
    if (t.kind === 'campaigns.propose' && t.id === proposing) {
      setProposing(null);
      const failed = d.event === 'failed';
      toast(failed ? (t.error || 'تعذر إكمال الاقتراح، حاول مجددًا') : (t.summary || 'وصلت مقترحات مدير الحملات'), failed ? 'bad' : 'ok', 'مدير الحملات');
    }
    reload();
  });
  useLive('approvals', reload);
  useLive('metrics', reload);

  const rows = st.data || [];
  const proposals = rows.filter((c) => c.status === 'proposed');
  const go = (id) => setQuery({ tab: id === 'campaigns' ? null : id, status: null });
  const changed = (out) => {
    if (out?.id) st.setData((xs) => (xs || []).map((c) => (c.id === out.id ? { ...c, ...out, results: c.results } : c)));
    reload();
  };
  const tabs = [
    { id: 'campaigns', label: 'الحملات', icon: 'megaphone' },
    { id: 'proposals', label: 'المقترحات', icon: 'lightbulb', count: proposals.length },
    { id: 'competitors', label: 'المنافسون', icon: 'users' },
    { id: 'limits', label: 'الليمت والصلاحية', icon: 'gauge' },
  ];
  const openPropose = () => setOverlay('propose');
  const openManual = () => setOverlay('manual');

  return html`
    <div class="page-head cp-head">
      <div class="grow"><h2>حملاتك ومقترحات مدير الحملات</h2>
        <p>تابع أداء كل حملة وميزانيتها، واعتمد المقترحات، وراقب المنافسين، واضبط الليمت من مكان واحد.</p></div>
      <div class="cp-acts">
        ${can('editor') && html`<${Button} variant="primary" icon="wand" onClick=${openPropose}>اقترح حملة</${Button}>`}
        ${can('manager') && html`<${Button} icon="plus" onClick=${openManual}>حملة يدوية</${Button}>`}
      </div>
    </div>
    <div class="cp-tabs"><${Tabs} tabs=${tabs} value=${tab} onChange=${go} /></div>
    ${tab === 'campaigns' && html`<${Loader} state=${st} skeleton=${html`<${StripsSkeleton} />`}>${() => html`<${CampaignsTab} rows=${rows}
      proposals=${proposals.length} status=${query.status || ''} onStatus=${(s) => setQuery({ status: s || null })} onChanged=${changed}
      onPropose=${openPropose} onManual=${openManual} onProposals=${() => go('proposals')} />`}</${Loader}>`}
    ${tab === 'proposals' && html`<${Loader} state=${st} skeleton=${html`<${ProposalsSkeleton} />`}>${() => html`<${ProposalsTab}
      rows=${proposals} proposing=${proposing} onPropose=${openPropose} onDecided=${changed} />`}</${Loader}>`}
    ${tab === 'competitors' && html`<${CompetitorsTab} />`}
    ${tab === 'limits' && html`<${LimitsTab} />`}
    ${overlay === 'propose' && html`<${ProposeModal} onClose=${() => setOverlay('')}
      onStarted=${(task) => { setOverlay(''); setProposing(task?.id || 'pending'); go('proposals'); }} />`}
    ${overlay === 'manual' && html`<${ManualDrawer} onClose=${() => setOverlay('')}
      onCreated=${(c) => { setOverlay(''); st.reload(true); navigate(`/campaigns/${c.id}`); }} />`}`;
}

export default function CampaignsPage({ params, query }) {
  if (params?.id) return html`<${CampaignDetail} id=${params.id} />`;
  return html`<${Home} query=${query || {}} />`;
}
