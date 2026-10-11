// Library vocabulary and media rendering, shared with the content page (post media and the library picker).
import { html, cls } from '../../lib/h.js';

export const ASSET_STATUS = {
  pending: ['بانتظار الاعتماد', 'warn'], approved: ['معتمد', 'ok'], rejected: ['مرفوض', 'bad'],
};
export const KIND_LABEL = { image: 'صورة', video: 'مقطع' };
export const DEFAULT_FOLDER = 'عام';

const BYTES_KB = 1024;
const BYTES_MB = BYTES_KB * 1024;
const SECONDS_HOUR = 3600;

/** 15.4 → «0:15», 3725 → «1:02:05». */
export function duration(s) {
  const t = Math.max(0, Math.round(+s || 0));
  const h = Math.floor(t / SECONDS_HOUR);
  const m = Math.floor((t % SECONDS_HOUR) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function fileSize(bytes) {
  const b = +bytes || 0;
  if (b >= BYTES_MB) return `${(b / BYTES_MB).toFixed(b >= 100 * BYTES_MB ? 0 : 1)} MB`;
  if (b >= BYTES_KB) return `${Math.round(b / BYTES_KB)} KB`;
  return `${b} B`;
}

export const usedLabel = (n) => (!n ? 'لم يُستخدم بعد' : n === 1 ? 'استُخدم مرة واحدة' : n === 2 ? 'استُخدم مرتين'
  : `استُخدم ${n} ${n % 100 >= 3 && n % 100 <= 10 ? 'مرات' : 'مرة'}`);

/** Full-size media: the original file (not the thumbnail), with native controls for video. */
export function MediaView({ asset, class: c }) {
  if (asset.kind === 'video') {
    return html`<video class=${cls('lb-media', c)} key=${asset.id} src=${asset.url} controls preload="metadata" playsinline
      poster=${asset.has_thumb ? asset.thumb : undefined} aria-label=${asset.title} />`;
  }
  return html`<img class=${cls('lb-media', c)} key=${asset.id} src=${asset.url} alt=${asset.title} />`;
}
