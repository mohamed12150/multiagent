// المكتبة: designers upload finished files, a manager gives «اعتماد التصميم», and agents use approved files only.
import { html, cls, useState, useEffect, useRef } from '../lib/h.js';
import { api, useApi } from '../lib/api.js';
import { useLive } from '../lib/live.js';
import { setQuery } from '../lib/router.js';
import { can } from '../lib/store.js';
import * as F from '../lib/format.js';
import { Icon, Button, Seg, Empty, Loader } from '../ui/core.js';
import { toast, confirm } from '../ui/overlays.js';
import { useDebounced, SearchBox } from './content/kit.js';
import { DEFAULT_FOLDER } from './library/media.js';
import { AssetTile, GridSkeleton } from './library/grid.js';
import { AssetDrawer } from './library/preview.js';
import { ACCEPT, useUploader, useFileDrop, UploadPanel, DropOverlay } from './library/upload.js';

const STATUSES = ['pending', 'approved', 'rejected'];
const KINDS = ['image', 'video'];
const LIVE_RELOAD_MS = 1200;
const FOLDER_MAX = 80;

const kindOptions = () => [
  { value: '', label: 'الكل' },
  { value: 'image', label: html`<${Icon} name="image" size="14" />صور` },
  { value: 'video', label: html`<${Icon} name="video" size="14" />مقاطع` },
];
const statusOptions = (counts, total) => [
  { value: '', label: html`الكل <span class="lb-n num">${F.num(total)}</span>` },
  { value: 'pending', label: html`بانتظار الاعتماد ${counts.pending ? html`<span class="lb-n warn num">${F.num(counts.pending)}</span>` : null}` },
  { value: 'approved', label: html`معتمد <span class="lb-n num">${F.num(counts.approved || 0)}</span>` },
  { value: 'rejected', label: html`مرفوض <span class="lb-n num">${F.num(counts.rejected || 0)}</span>` },
];

function RuleNotice({ pending, onReview }) {
  return html`<div class="notice lb-rule">
    <${Icon} name="shield" size="18" />
    <div class="grow"><b>الوكلاء يستخدمون الملفات المعتمدة فقط</b>
      لا يرى صانع المحتوى أي ملف قبل «اعتماد التصميم» ممن يملك صلاحية الاعتماد، والملفات الجديدة تصل بحالة «بانتظار الاعتماد».
      <ol class="lb-flow">
        <li><${Icon} name="upload" size="14" />يرفع المصمم التصميم النهائي</li>
        <li><${Icon} name="sparkles" size="14" />يصفه صانع المحتوى ويضع وسومه</li>
        <li><${Icon} name="checkCircle" size="14" />يعتمده صاحب صلاحية الاعتماد</li>
        <li><${Icon} name="wand" size="14" />يُستخدم في المنشورات</li>
      </ol>
    </div>
    ${pending > 0 && onReview && html`<${Button} size="sm" icon="checkCircle" onClick=${onReview}>راجع ما ينتظر (${F.num(pending)})</${Button}>`}
  </div>`;
}

function FolderNav({ folders, current, total, onPick, onCreate }) {
  return html`<nav class="lb-folders" aria-label="المجلدات">
    <button type="button" class=${cls('lb-folder', !current && 'on')} aria-current=${!current ? 'true' : undefined} onClick=${() => onPick('')}>
      <${Icon} name="layers" size="16" /><span class="grow ellipsis">كل الملفات</span><span class="lb-folder-n num">${F.num(total)}</span></button>
    ${folders.map((f) => html`<button type="button" key=${f} class=${cls('lb-folder', current === f && 'on')}
        aria-current=${current === f ? 'true' : undefined} onClick=${() => onPick(f)} title=${f}>
      <${Icon} name="archive" size="16" /><span class="grow ellipsis">${f}</span></button>`)}
    ${onCreate && html`<button type="button" class="lb-folder lb-folder-new" onClick=${onCreate}><${Icon} name="plus" size="16" /><span>مجلد جديد</span></button>`}
  </nav>`;
}

export default function LibraryPage({ query }) {
  const folder = (query.folder || '').trim();
  const status = STATUSES.includes(query.status) ? query.status : '';
  const kind = KINDS.includes(query.kind) ? query.kind : '';
  const q = (query.q || '').trim();
  const params = new URLSearchParams();
  [['folder', folder], ['status', status], ['kind', kind], ['q', q]].forEach(([k, v]) => { if (v) params.set(k, v); });
  const st = useApi(`/library${params.toString() ? `?${params}` : ''}`);
  const [localFolders, setLocalFolders] = useState([]);
  const [reviewing, setReviewing] = useState({});
  const [shown, setShown] = useState(null);
  const picker = useRef(null);
  const editor = can('library');
  const mgr = can('approve');
  const upFolder = folder || DEFAULT_FOLDER;

  const reload = useDebounced(() => st.reload(true), LIVE_RELOAD_MS);
  const uploads = useUploader(() => st.reload(true));
  const dragging = useFileDrop(editor, (files) => uploads.start(files, upFolder));
  useLive('task', (d) => { if (d.event === 'done' && d.task?.kind === 'content.describe_asset') reload(); });
  useLive('feed', (ev) => { if ((ev.kind || '').startsWith('library.') || ev.ref_kind === 'asset') reload(); });
  useLive('approvals', reload);

  const rows = st.data || [];
  const counts = st.meta?.counts || {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const folders = [...new Set([DEFAULT_FOLDER, ...(st.meta?.folders || []), ...localFolders, folder].filter(Boolean))]
    .sort((a, b) => (a === DEFAULT_FOLDER ? -1 : b === DEFAULT_FOLDER ? 1 : a.localeCompare(b, 'ar')));
  const filtered = !!(folder || status || kind || q);

  // The drawer keeps the last known copy, so approving from a «بانتظار الاعتماد» view does not yank it away.
  const openId = query.asset || '';
  const found = openId ? rows.find((a) => a.id === openId) : null;
  useEffect(() => { if (found) setShown(found); }, [found]);
  const current = found || (shown?.id === openId ? shown : null);
  useEffect(() => { if (openId && st.data && !current) setQuery({ asset: null }); }, [openId, st.data, current]);

  const pick = () => picker.current?.click();
  const replace = (updated) => st.setData((xs) => (xs || []).map((a) => (a.id === updated.id ? updated : a)));
  const changed = (updated) => { replace(updated); setShown(updated); reload(); };

  const review = async (a, approve) => {
    let note = '';
    if (!approve) {
      const r = await confirm({ title: 'رفض التصميم', ok: 'ارفض التصميم', danger: true, input: true,
        text: 'لن يستخدمه صانع المحتوى. اكتب السبب ليعرف المصمم ما المطلوب (اختياري).',
        placeholder: 'مثال: الشعار غير واضح، والألوان لا تطابق الهوية' });
      if (r === false) return;
      note = r.trim();
    }
    setReviewing((m) => ({ ...m, [a.id]: approve ? 'approve' : 'reject' }));
    try {
      replace(await api.post(`/library/${a.id}/review`, { approve, note }));
      toast(approve ? `اعتُمد «${a.title}» وأصبح متاحًا لصانع المحتوى` : `رُفض «${a.title}»`);
      reload();
    } catch (e) { toast.error(e); } finally { setReviewing(({ [a.id]: _done, ...rest }) => rest); }
  };

  const newFolder = async () => {
    const name = await confirm({ title: 'مجلد جديد', ok: 'أنشئ المجلد', input: true, placeholder: 'مثال: رمضان 2026',
      text: 'اكتب اسم المجلد ثم ارفع الملفات إليه. يظهر المجلد لبقية الفريق بعد أول ملف يُرفع فيه.' });
    if (name === false) return;
    const clean = name.trim().slice(0, FOLDER_MAX);
    if (!clean) { toast('اكتب اسمًا للمجلد', 'warn'); return; }
    setLocalFolders((fs) => (fs.includes(clean) ? fs : [...fs, clean]));
    setQuery({ folder: clean, asset: null });
  };

  const emptyState = () => {
    if (!filtered) {
      return html`<${Empty} icon="upload" title="المكتبة فارغة"
        text="ارفع التصاميم النهائية من فريقك، صورًا أو مقاطع. يصفها صانع المحتوى تلقائيًا، وبعد «اعتماد التصميم» يستخدمها في المنشورات. يمكنك أيضًا سحب الملفات وإفلاتها في أي مكان بالصفحة."
        action=${editor && html`<${Button} variant="primary" icon="upload" onClick=${pick}>ارفع ملفات</${Button}>`} />`;
    }
    if (folder && !status && !kind && !q) {
      return html`<${Empty} icon="archive" title=${`مجلد «${folder}» فارغ`} text="ارفع الملفات الآن لتُحفظ في هذا المجلد."
        action=${editor && html`<${Button} variant="primary" icon="upload" onClick=${pick}>ارفع إلى «${folder}»</${Button}>`} />`;
    }
    if (status === 'pending' && !kind && !q) {
      return html`<${Empty} icon="checkCircle" title="لا شيء بانتظار الاعتماد" text="رُوجعت كل التصاميم المرفوعة. أي ملف جديد يظهر هنا حتى يُعتمد." />`;
    }
    return html`<${Empty} icon="search" title="لا ملفات تطابق الفلاتر" text="جرّب كلمة أخرى أو اعرض كل الملفات."
      action=${html`<${Button} size="sm" icon="x" onClick=${() => setQuery({ folder: null, status: null, kind: null, q: null })}>اعرض كل الملفات</${Button}>`} />`;
  };

  return html`
    <div class="page-head">
      <div class="grow"><h2 class="lb-title">مكتبة التصاميم</h2>
        <p>هنا تُرفع التصاميم النهائية من فريقك، صورًا ومقاطع. يصف صانع المحتوى كل ملف جديد تلقائيًا، وبعد اعتماده يصبح متاحًا للمنشورات.</p></div>
      ${editor && html`<div class="row wrap gap-6">
        <span class="tiny faint lb-dest"><${Icon} name="archive" size="14" />الرفع إلى «${upFolder}»</span>
        <${Button} variant="primary" icon="upload" onClick=${pick}>ارفع ملفات</${Button}>
        <input ref=${picker} type="file" multiple accept=${ACCEPT} hidden aria-hidden="true" tabindex="-1"
          onChange=${(e) => { const el = e.currentTarget; if (el.files?.length) uploads.start(el.files, upFolder); el.value = ''; }} />
      </div>`}
    </div>
    <${RuleNotice} pending=${counts.pending || 0} onReview=${mgr && status !== 'pending' ? () => setQuery({ status: 'pending', asset: null }) : null} />
    <div class="lb-layout">
      <aside class="lb-side">
        <h3 class="lb-side-title">المجلدات</h3>
        <${FolderNav} folders=${folders} current=${folder} total=${total} onCreate=${editor ? newFolder : null}
          onPick=${(f) => setQuery({ folder: f || null, asset: null })} />
      </aside>
      <div class="lb-main">
        <div class="lb-bar">
          <div class="lb-seg"><${Seg} options=${statusOptions(counts, total)} value=${status} label="حالة الاعتماد"
            onChange=${(v) => setQuery({ status: v || null, asset: null })} /></div>
          <div class="lb-seg"><${Seg} options=${kindOptions()} value=${kind} label="نوع الملف"
            onChange=${(v) => setQuery({ kind: v || null, asset: null })} /></div>
          <${SearchBox} value=${q} placeholder="ابحث بالعنوان أو الوصف أو اسم الملف" onCommit=${(v) => setQuery({ q: v || null })} />
        </div>
        <${UploadPanel} items=${uploads.items} busy=${uploads.busy} onClear=${uploads.clear} />
        <${Loader} state=${st} skeleton=${html`<${GridSkeleton} />`}>${(list) => (list.length
          ? html`<div class=${cls('lb-grid', st.loading && 'ct-loading')}>
              ${editor && html`<button type="button" class="lb-add" onClick=${pick}>
                <span class="mark agent"><${Icon} name="upload" size="20" /></span><b>ارفع ملفات</b>
                <span class="tiny faint">أو اسحبها وأفلتها هنا</span></button>`}
              ${list.map((a) => html`<${AssetTile} key=${a.id} asset=${a} showFolder=${!folder} reviewing=${reviewing[a.id]}
                onOpen=${(id) => setQuery({ asset: id })} onReview=${mgr ? review : null} />`)}
            </div>`
          : html`<div class="card">${emptyState()}</div>`)}</${Loader}>
      </div>
    </div>
    ${dragging && html`<${DropOverlay} folder=${upFolder} />`}
    ${current && html`<${AssetDrawer} key=${current.id} asset=${current} folders=${folders}
      onClose=${() => setQuery({ asset: null })} onChanged=${changed}
      onDeleted=${(id) => { setQuery({ asset: null }); setShown(null); st.setData((xs) => (xs || []).filter((a) => a.id !== id)); reload(); }} />`}`;
}
