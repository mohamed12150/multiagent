// Uploading designs: type check, batches under the server cap, per-file state, and page-wide drag and drop.
import { html, cls, useState, useEffect, useRef, useCallback } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { Icon, Button, Meter } from '../../ui/core.js';
import { toast } from '../../ui/overlays.js';
import { counted, FILES } from '../content/kit.js';
import { fileSize } from './media.js';

export const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.webm,image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm';
const EXT = /\.(jpe?g|png|webp|gif|mp4|mov|webm)$/i;
const MIME = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|quicktime|webm))$/;
const VIDEO = /^video\/|\.(mp4|mov|webm)$/i;
const BATCH_FILES = 20; // qsm/api/library.py MAX_FILES
const BATCH_BYTES = 40 * 1024 * 1024; // keeps each request well inside the client timeout
const CLEAR_AFTER_MS = 5000;
const ACTIVE = new Set(['wait', 'up']);

const accepted = (f) => MIME.test(f.type) || EXT.test(f.name);

function batches(items) {
  const out = [];
  let cur = [];
  let bytes = 0;
  items.forEach((it) => {
    if (cur.length && (cur.length >= BATCH_FILES || bytes + it.size > BATCH_BYTES)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(it);
    bytes += it.size;
  });
  if (cur.length) out.push(cur);
  return out;
}

/** Match server errors back to files by name (first unclaimed match wins for duplicate names). */
function errorsByItem(group, errors) {
  const pool = [...errors];
  return new Map(group.map((it) => {
    const k = pool.findIndex((e) => e.name === it.name);
    return [it.id, k >= 0 ? pool.splice(k, 1)[0].error : ''];
  }));
}

export function useUploader(onSaved) {
  const [items, setItems] = useState([]);
  const urls = useRef(new Set());
  const seq = useRef(0);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const current = useRef(items);
  current.current = items;
  const update = (ids, patch) => setItems((xs) => xs.map((x) => (ids.includes(x.id) ? { ...x, ...patch } : x)));
  const clear = useCallback(() => {
    const gone = current.current.filter((x) => !ACTIVE.has(x.state));
    gone.forEach((x) => { if (x.preview) { URL.revokeObjectURL(x.preview); urls.current.delete(x.preview); } });
    const ids = new Set(gone.map((x) => x.id));
    setItems((xs) => xs.filter((x) => !ids.has(x.id)));
  }, []);

  const start = async (fileList, folder) => {
    const files = [...fileList];
    const skipped = files.filter((f) => !accepted(f));
    if (skipped.length) {
      toast(`${skipped.map((f) => f.name).join('، ')}: النوع غير مدعوم. المسموح: JPG, PNG, WEBP, GIF, MP4, MOV, WEBM`, 'bad',
        skipped.length > 1 ? `تعذر رفع ${counted(skipped.length, FILES)}` : 'تعذر رفع ملف');
    }
    const queue = files.filter(accepted).map((f) => {
      const isVideo = VIDEO.test(f.type) || VIDEO.test(f.name);
      const preview = isVideo ? '' : URL.createObjectURL(f);
      if (preview) urls.current.add(preview);
      seq.current += 1;
      return { id: `u${seq.current}`, file: f, name: f.name, size: f.size, kind: isVideo ? 'video' : 'image', preview, state: 'wait', error: '' };
    });
    if (!queue.length) return;
    setItems((xs) => [...xs, ...queue]);
    let ok = 0;
    for (const group of batches(queue)) {
      const ids = group.map((it) => it.id);
      update(ids, { state: 'up' });
      const fd = new FormData();
      group.forEach((it) => fd.append('files', it.file, it.name));
      fd.append('folder', folder);
      try {
        const res = await api.post('/library', fd, { raw: true });
        const errs = errorsByItem(group, res.meta?.errors || []);
        ok += (res.data || []).length;
        group.forEach((it) => update([it.id], errs.get(it.id) ? { state: 'bad', error: errs.get(it.id) } : { state: 'done' }));
        errs.forEach((error, id) => { if (error) toast(`${group.find((it) => it.id === id).name}: ${error}`, 'bad', 'تعذر رفع ملف'); });
      } catch (e) {
        update(ids, { state: 'bad', error: e.message });
        toast(`${counted(group.length, FILES)}: ${e.message}`, 'bad', 'تعذر الرفع');
      }
    }
    if (ok) {
      toast(`رُفع ${counted(ok, FILES)} إلى «${folder}» بحالة «بانتظار الاعتماد». يصفها صانع المحتوى الآن تلقائيًا.`, 'ok', 'اكتمل الرفع');
      saved.current?.();
    }
  };

  const busy = items.some((x) => ACTIVE.has(x.state));
  const failed = items.some((x) => x.state === 'bad');
  useEffect(() => {
    if (!items.length || busy || failed) return undefined;
    const t = setTimeout(clear, CLEAR_AFTER_MS);
    return () => clearTimeout(t);
  }, [items, busy, failed]);

  return { items, busy, start, clear };
}

const STATE = {
  wait: ['clock', 'بالانتظار'], up: ['upload', 'يُرفع الآن'], done: ['checkCircle', 'رُفع'], bad: ['alert', 'تعذر'],
};

export function UploadPanel({ items, busy, onClear }) {
  if (!items.length) return null;
  const done = items.filter((x) => !ACTIVE.has(x.state)).length;
  return html`<section class="lb-up card" aria-live="polite" aria-label="الرفع">
    <div class="lb-up-head">
      <b class="grow">${busy ? `يرفع ${done} من ${items.length}` : 'اكتمل الرفع'}</b>
      ${!busy && html`<${Button} size="xs" variant="ghost" icon="x" onClick=${onClear}>إخفاء</${Button}>`}
    </div>
    <${Meter} value=${done} max=${items.length} tone=${!busy && items.some((x) => x.state === 'bad') ? 'warn' : busy ? '' : 'ok'} />
    <ul class="lb-up-list">${items.map((it) => html`<li key=${it.id} class=${cls('lb-up-item', `is-${it.state}`)}>
      <span class="lb-up-prev">${it.preview ? html`<img src=${it.preview} alt="" />` : html`<${Icon} name=${it.kind === 'video' ? 'video' : 'image'} size="16" />`}</span>
      <span class="grow"><span class="ellipsis lb-up-name">${it.name}</span>
        <span class="tiny faint">${it.state === 'bad' ? it.error : fileSize(it.size)}</span></span>
      <span class="lb-up-state">${it.state === 'up' ? html`<span class="status-dot working" />` : html`<${Icon} name=${STATE[it.state][0]} size="16" />`}
        <span class="tiny">${STATE[it.state][1]}</span></span>
    </li>`)}</ul>
  </section>`;
}

/** Files dragged anywhere over the page: returns true while a drag with files is over the window. */
export function useFileDrop(enabled, onFiles) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const cb = useRef(onFiles);
  cb.current = onFiles;
  useEffect(() => {
    if (!enabled) return undefined;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const enter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current += 1; setOver(true); };
    const move = (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      if (e.dataTransfer.files?.length) cb.current(e.dataTransfer.files);
    };
    const reset = () => { depth.current = 0; setOver(false); };
    const pairs = [['dragenter', enter], ['dragover', move], ['dragleave', leave], ['drop', drop], ['dragend', reset]];
    pairs.forEach(([k, fn]) => window.addEventListener(k, fn));
    return () => pairs.forEach(([k, fn]) => window.removeEventListener(k, fn));
  }, [enabled]);
  return over;
}

export function DropOverlay({ folder }) {
  return html`<div class="lb-drop" aria-hidden="true"><div class="lb-drop-box">
    <span class="mark lg agent"><${Icon} name="upload" size="24" /></span>
    <h3>أفلت الملفات للرفع</h3>
    <p class="muted small">إلى مجلد «${folder}». صور JPG وPNG وWEBP وGIF، ومقاطع MP4 وMOV وWEBM.</p>
  </div></div>`;
}
