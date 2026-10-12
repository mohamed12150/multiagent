// The pipeline board: one column per stage, from draft to published.
import { html, cls } from '../../lib/h.js';
import { can } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Badge, SimTag, ChannelMark, AgentMark, Thumb, Skeleton } from '../../ui/core.js';
import { COLUMNS, SORTS, authorOf } from './shared.js';

const NEAR_MS = 24 * 3600e3;

function Author({ actor }) {
  const a = authorOf(actor);
  return html`<span class="ct-author" title=${a.name} aria-label=${a.name}>
    ${a.user ? html`<span class="mark sm"><${Icon} name="user" size="13" /></span>` : html`<${AgentMark} id=${a.id} size="sm" />`}</span>`;
}

function MetaLine({ post: p }) {
  if (p.status === 'published') {
    return html`<span class="ct-meta ok"><${Icon} name="checkCircle" size="14" />${F.ago(p.published_at)}</span>
      <span class="ct-meta" title="التفاعل"><${Icon} name="heart" size="14" /><span class="num">${F.compact(p.engagement)}</span></span>
      <span class="ct-meta" title="الوصول"><${Icon} name="eye" size="14" /><span class="num">${F.compact(p.metrics?.reach || p.metrics?.views || 0)}</span></span>`;
  }
  if (p.status === 'publishing') return html`<span class="ct-meta live"><span class="status-dot working" />يُنشر الآن</span>`;
  if (p.status === 'scheduled' && p.scheduled_at) {
    const near = Date.parse(p.scheduled_at) - Date.now() < NEAR_MS;
    return html`<span class="ct-meta live" title=${p.scheduled_human}><${Icon} name="clock" size="14" />${near ? F.until(p.scheduled_at) : p.scheduled_human}</span>`;
  }
  if (p.status === 'approved' && p.scheduled_at) {
    return html`<span class="ct-meta" title="وقت مقترح من المنسّق"><${Icon} name="lightbulb" size="14" />مقترح: ${p.scheduled_human}</span>`;
  }
  if (p.status === 'failed') return html`<span class="ct-meta bad"><${Icon} name="alert" size="14" />تعذر النشر ${F.ago(p.updated_at)}</span>`;
  return html`<span class="ct-meta"><${Icon} name="history" size="14" />${F.ago(p.updated_at)}</span>`;
}

export function PostCard({ post: p, onOpen, onApprove, approving }) {
  const cover = p.assets[0];
  const open = () => onOpen(p.id);
  const extra = p.assets.length - 1;
  return html`<article class=${cls('ct-card', `ct-c-${p.channel}`)} tabindex="0" aria-label=${p.title || 'منشور بلا عنوان'}
      onClick=${open} onKeyDown=${(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}>
    <div class="ct-card-top">
      <${ChannelMark} ch=${p.channel} size="sm" />
      <${Badge}>${F.formatLabel(p.format)}</${Badge}>
      ${p.sandbox && html`<${SimTag} />`}
      <span class="grow" />
      <${Author} actor=${p.author_agent} />
    </div>
    ${cover && html`<div class="ct-cover"><${Thumb} asset=${cover} />${extra > 0 && html`<span class="ct-more num">+${extra}</span>`}</div>`}
    <h3 class="ct-card-title clamp-2">${p.title || 'منشور بلا عنوان'}</h3>
    ${p.caption && html`<p class="ct-card-text clamp-2">${p.caption}</p>`}
    ${p.review_note && p.status !== 'published' && html`<p class="ct-card-note"><${Icon} name=${p.status === 'approved' ? 'lightbulb' : 'alert'} size="14" />
      <span class="clamp-2">${p.review_note}</span></p>`}
    ${p.status === 'failed' && p.error && html`<p class="ct-card-note bad"><${Icon} name="alert" size="14" /><span class="clamp-2">${p.error}</span></p>`}
    <div class="ct-card-meta"><${MetaLine} post=${p} /></div>
    ${onApprove && p.status === 'review' && html`<div class="ct-card-act">
      <${Button} size="xs" variant="ok" icon="check" loading=${approving} onClick=${(e) => { e.stopPropagation(); onApprove(p); }}>اعتماد</${Button}>
      <${Button} size="xs" variant="ghost" onClick=${(e) => { e.stopPropagation(); open(); }}>راجع</${Button}>
    </div>`}
  </article>`;
}

export function Board({ posts, counts, filtered, onOpen, onApprove, approving }) {
  const mgr = can('approve');
  return html`<div class="ct-board">${COLUMNS.map((col) => {
    const rows = posts.filter((p) => col.statuses.includes(p.status)).sort(SORTS[col.by]);
    const total = col.statuses.reduce((sum, k) => sum + (counts?.[k] || 0), 0);
    const shown = filtered ? rows.length : Math.max(total, rows.length);
    return html`<section class=${cls('ct-col', `ct-tone-${col.tone}`)} key=${col.id} aria-label=${col.label}>
      <header class="ct-col-head"><i class="ct-col-dot" /><h2>${col.label}</h2><span class="ct-col-n num">${F.num(shown)}</span></header>
      <div class="ct-col-body">
        ${rows.length ? rows.map((p) => html`<${PostCard} key=${p.id} post=${p} onOpen=${onOpen}
            onApprove=${mgr ? onApprove : null} approving=${approving === p.id} />`)
          : html`<p class="ct-col-empty">${filtered ? 'لا شيء يطابق الفلاتر هنا.' : col.empty}</p>`}
        ${!filtered && total > rows.length && html`<p class="tiny faint ct-col-more">يظهر ${F.num(rows.length)} من ${F.num(total)}، استخدم البحث للوصول للباقي.</p>`}
      </div>
    </section>`;
  })}</div>`;
}

export function BoardSkeleton() {
  return html`<div class="ct-board" aria-busy="true">${COLUMNS.map((col, i) => html`<section class="ct-col" key=${col.id}>
    <header class="ct-col-head"><${Skeleton} h=${14} w="96px" /></header>
    <div class="ct-col-body">${Array.from({ length: 3 - (i % 2) }, (_, j) => html`<div class="ct-card ct-card-sk" key=${j}>
      <div class="row gap-6"><${Skeleton} h=${26} w="26px" /><${Skeleton} h=${18} w="56px" /></div>
      ${j === 0 && html`<div class="skeleton ct-cover-sk" />`}
      <${Skeleton} lines=${2} h=${12} gap=${8} />
    </div>`)}</div>
  </section>`)}</div>`;
}
