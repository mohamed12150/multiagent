// المحتوى: the pipeline from draft to published: board by stage or week calendar, plus the post drawer.
import { html, cls, useState, useEffect } from '../lib/h.js';
import { api, useApi } from '../lib/api.js';
import { useLive } from '../lib/live.js';
import { setQuery } from '../lib/router.js';
import { can } from '../lib/store.js';
import * as F from '../lib/format.js';
import { Icon, Button, Seg, Empty, Loader } from '../ui/core.js';
import { toast } from '../ui/overlays.js';
import { useDebounced, SearchBox } from './content/kit.js';
import { isYmd, weekStart, todayYmd } from './content/shared.js';
import { Board, BoardSkeleton } from './content/board.js';
import { Calendar } from './content/calendar.js';
import { PostDrawer } from './content/drawer.js';
import { RequestDrawer, NewPostDrawer } from './content/create.js';

const BOARD_LIMIT = 300;
const LIVE_RELOAD_MS = 1200;
const LIVE_KINDS = ['coordinator.distribute', 'channel.publish'];
const viewOptions = () => [
  { value: 'board', label: html`<${Icon} name="kanban" size="15" />اللوحة` },
  { value: 'calendar', label: html`<${Icon} name="calendar" size="15" />التقويم` },
];

function ChannelFilter({ value }) {
  const pick = (ch) => setQuery({ ch: ch || null });
  return html`<div class="ct-chans" role="group" aria-label="تصفية حسب القناة">
    <button type="button" class=${cls('chip', !value && 'on')} aria-pressed=${!value} onClick=${() => pick('')}>كل القنوات</button>
    ${F.CHANNELS.map((ch) => html`<button type="button" key=${ch} class=${cls('chip', `ct-c-${ch}`, value === ch && 'on')}
        aria-pressed=${value === ch} onClick=${() => pick(value === ch ? '' : ch)}>
      <${Icon} name=${F.CHANNEL_ICON[ch]} size="15" class="ct-chip-ic" />${F.CHANNEL_LABEL[ch]}</button>`)}
  </div>`;
}

function BoardView({ channel, q, tick, onOpen, onAsk, onWrite }) {
  const params = new URLSearchParams({ limit: String(BOARD_LIMIT) });
  if (channel) params.set('channel', channel);
  if (q) params.set('q', q);
  const st = useApi(`/posts?${params}`);
  const [approving, setApproving] = useState('');
  useEffect(() => { if (tick) st.reload(true); }, [tick]);
  const filtered = !!(channel || q);

  const approve = async (p) => {
    setApproving(p.id);
    try {
      await api.post(`/posts/${p.id}/approve`, { note: '' });
      toast('اعتُمد المنشور، وسيجدوله المنسّق في أفضل وقت');
      st.reload(true);
    } catch (e) { toast.error(e); } finally { setApproving(''); }
  };

  return html`<${Loader} state=${st} skeleton=${html`<${BoardSkeleton} />`}>${(rows, meta) => {
    if (!rows.length && !filtered) {
      return html`<div class="card"><${Empty} icon="kanban" title="لا يوجد محتوى بعد"
        text="اطلب من صانع المحتوى منشورات لقنواتك، فيكتبها من تصاميمك المعتمدة ويرسلها لك للاعتماد. أو اكتب منشورًا بنفسك."
        action=${can('editor') && html`<div class="row wrap gap-6 ct-empty-actions">
          <${Button} variant="primary" icon="wand" onClick=${onAsk}>اطلب محتوى من صانع المحتوى</${Button}>
          <${Button} icon="edit" onClick=${onWrite}>منشور يدوي</${Button}></div>`} /></div>`;
    }
    if (!rows.length) {
      return html`<div class="card"><${Empty} icon="search" title="لا منشورات تطابق الفلاتر"
        text="جرّب كلمة أخرى أو اعرض كل القنوات."
        action=${html`<${Button} size="sm" icon="x" onClick=${() => setQuery({ ch: null, q: null })}>امسح الفلاتر</${Button}>`} /></div>`;
    }
    return html`<div class=${cls(st.loading && 'ct-loading')}><${Board} posts=${rows} counts=${meta?.counts} filtered=${filtered}
      onOpen=${onOpen} onApprove=${approve} approving=${approving} /></div>`;
  }}</${Loader}>`;
}

export default function ContentPage({ query }) {
  const view = query.view === 'calendar' ? 'calendar' : 'board';
  const channel = F.CHANNELS.includes(query.ch) ? query.ch : '';
  const q = (query.q || '').trim();
  const week = weekStart(isYmd(query.week) ? query.week : todayYmd());
  const [tick, setTick] = useState(0);
  const [asking, setAsking] = useState(false);
  const [writing, setWriting] = useState(false);
  const refresh = () => setTick((t) => t + 1);
  const bump = useDebounced(refresh, LIVE_RELOAD_MS);
  const editor = can('editor');

  useLive('task', (d) => {
    const kind = d.task?.kind || '';
    if (d.event !== 'created' && (kind.startsWith('content.') || LIVE_KINDS.includes(kind))) bump();
  });
  useLive('feed', (ev) => { if (ev.ref_kind === 'post' || /^(post|content)\./.test(ev.kind || '')) bump(); });
  useLive('approvals', bump);

  const open = (id) => setQuery({ post: id });
  return html`
    <div class="page-head">
      <div class="grow"><h2 class="ct-title">خط إنتاج المحتوى</h2>
        <p>يكتب صانع المحتوى النص والسكربت والوسوم من تصاميمك المعتمدة، وبعد اعتمادك يجدوله المنسّق في أفضل وقت وينشره وكيل القناة.</p></div>
      ${editor && html`<div class="row wrap gap-6">
        <${Button} icon="edit" onClick=${() => setWriting(true)}>منشور يدوي</${Button}>
        <${Button} variant="primary" icon="wand" onClick=${() => setAsking(true)}>اطلب محتوى من صانع المحتوى</${Button}>
      </div>`}
    </div>
    <div class="ct-bar">
      <div class="ct-view"><${Seg} options=${viewOptions()} value=${view} label="طريقة العرض"
        onChange=${(v) => setQuery({ view: v === 'board' ? null : v })} /></div>
      <${ChannelFilter} value=${channel} />
      <${SearchBox} value=${q} placeholder="ابحث في العناوين والنصوص" onCommit=${(v) => setQuery({ q: v || null })} />
    </div>
    ${view === 'board'
      ? html`<${BoardView} channel=${channel} q=${q} tick=${tick} onOpen=${open} onAsk=${() => setAsking(true)} onWrite=${() => setWriting(true)} />`
      : html`<${Calendar} week=${week} channel=${channel} q=${q} tick=${tick} onOpen=${open}
          onWeek=${(w) => setQuery({ week: w && w !== weekStart(todayYmd()) ? w : null })} />`}
    ${query.post && html`<${PostDrawer} key=${query.post} id=${query.post} onClose=${() => setQuery({ post: null })} onChanged=${refresh} />`}
    ${asking && html`<${RequestDrawer} onClose=${() => setAsking(false)} onStarted=${refresh} />`}
    ${writing && html`<${NewPostDrawer} onClose=${() => setWriting(false)}
      onCreated=${(p) => { setWriting(false); refresh(); setQuery({ post: p.id }); }} />`}`;
}
