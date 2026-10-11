// Library tiles: preview, review state, usage; managers approve pending designs right from the grid.
import { html, cls } from '../../lib/h.js';
import { Icon, Button, StatusBadge, Thumb, Skeleton } from '../../ui/core.js';
import { ASSET_STATUS, duration, usedLabel } from './media.js';

const SKELETON_TILES = 12;

export function AssetTile({ asset: a, showFolder, onOpen, onReview, reviewing }) {
  return html`<article class=${cls('lb-tile', `is-${a.status}`)}>
    <button type="button" class="lb-tile-media" onClick=${() => onOpen(a.id)} aria-label=${`معاينة ${a.title}`}>
      <${Thumb} asset=${a} />
      <span class="lb-flag"><${StatusBadge} map=${ASSET_STATUS} value=${a.status} /></span>
      ${a.ai_described && html`<span class="lb-ai" title="وصفه صانع المحتوى تلقائيًا"><${Icon} name="sparkles" size="13" /></span>`}
      ${a.kind === 'video' && a.duration ? html`<span class="lb-dur num">${duration(a.duration)}</span>` : null}
    </button>
    <div class="lb-tile-body">
      <b class="lb-tile-title ellipsis" title=${a.title}>${a.title}</b>
      <span class="lb-tile-meta">${showFolder && html`<span class="ellipsis">${a.folder}</span><i aria-hidden="true">·</i>`}
        <span class=${cls(a.used_count > 0 && 'lb-used')}>${usedLabel(a.used_count)}</span></span>
    </div>
    ${onReview && a.status === 'pending' && html`<div class="lb-quick">
      <${Button} size="xs" variant="ok" icon="check" loading=${reviewing === 'approve'} disabled=${!!reviewing}
        onClick=${() => onReview(a, true)}>اعتماد التصميم</${Button}>
      <${Button} size="xs" variant="ghost" icon="x" title="رفض" aria-label=${`رفض ${a.title}`} loading=${reviewing === 'reject'}
        disabled=${!!reviewing} onClick=${() => onReview(a, false)} />
    </div>`}
  </article>`;
}

export function GridSkeleton() {
  return html`<div class="lb-grid" aria-busy="true">${Array.from({ length: SKELETON_TILES }, (_, i) => html`<div class="lb-tile lb-tile-sk" key=${i}>
    <div class="skeleton lb-sk-media" /><div class="lb-tile-body"><${Skeleton} h=${13} w="72%" /><${Skeleton} h=${10} w="44%" /></div>
  </div>`)}</div>`;
}
