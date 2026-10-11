// «اختر من المكتبة»: approved library files only, multi-select (selection order = publish order, first = cover).
import { html, cls, useState } from '../../lib/h.js';
import { useApi } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { Icon, Button, Seg, Empty, Skeleton, Loader, Thumb } from '../../ui/core.js';
import { Modal, toast } from '../../ui/overlays.js';
import { duration, usedLabel, KIND_LABEL } from '../library/media.js';
import { SearchBox, useTopEscape, counted, FILES } from './kit.js';
import { MAX_ASSETS } from './shared.js';

const KINDS = [{ value: '', label: 'الكل' }, { value: 'image', label: 'صور' }, { value: 'video', label: 'مقاطع' }];
const SKELETON_TILES = 8;

function PickerSkeleton() {
  return html`<div class="ct-pick-grid">${Array.from({ length: SKELETON_TILES }, (_, i) => html`<div key=${i}>
    <div class="skeleton ct-pick-sk" /><div class="mt-8"><${Skeleton} h=${12} w="70%" /></div></div>`)}</div>`;
}

export function LibraryPicker({ selected = [], onPick, onClose }) {
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(selected);
  const params = new URLSearchParams({ status: 'approved', limit: '300' });
  if (kind) params.set('kind', kind);
  if (q) params.set('q', q);
  const st = useApi(`/library?${params}`);
  useTopEscape(onClose);

  const toggle = (a) => {
    if (picked.some((x) => x.id === a.id)) { setPicked(picked.filter((x) => x.id !== a.id)); return; }
    if (picked.length >= MAX_ASSETS) { toast(`يمكن إرفاق ${MAX_ASSETS} ملفات كحد أقصى للمنشور الواحد`, 'warn'); return; }
    setPicked([...picked, a]);
  };

  const footer = html`
    <${Button} variant="primary" icon="check" onClick=${() => onPick(picked)}>
      ${picked.length ? `أرفق ${counted(picked.length, FILES)}` : 'بدون ملفات'}</${Button}>
    <${Button} variant="ghost" onClick=${onClose}>إلغاء</${Button}>
    <span class="tiny faint ct-pick-hint">الترتيب حسب اختيارك، والأول هو الغلاف. حتى ${MAX_ASSETS} ملفات.</span>`;

  return html`<${Modal} title="اختر من المكتبة" wide onClose=${onClose} footer=${footer}>
    <p class="small muted">تظهر هنا التصاميم المعتمدة فقط، لأنها الوحيدة المسموح باستخدامها في المنشورات.</p>
    <div class="ct-pick-bar mt-12">
      <${Seg} size="sm" options=${KINDS} value=${kind} onChange=${setKind} label="نوع الملف" />
      <${SearchBox} value=${q} onCommit=${setQ} placeholder="ابحث بالعنوان أو الوصف" />
    </div>
    <div class="mt-16">
      <${Loader} state=${st} skeleton=${html`<${PickerSkeleton} />`}>${(rows) => (rows.length
        ? html`<div class="ct-pick-grid">${rows.map((a) => {
          const order = picked.findIndex((x) => x.id === a.id);
          return html`<button type="button" key=${a.id} class=${cls('ct-pick', order >= 0 && 'on')} aria-pressed=${order >= 0}
              onClick=${() => toggle(a)} title=${a.title}>
            <span class="ct-pick-media"><${Thumb} asset=${a} />
              <span class="ct-pick-check">${order >= 0 ? html`<b class="num">${order + 1}</b>` : html`<${Icon} name="plus" size="14" />`}</span>
              ${a.kind === 'video' && a.duration ? html`<span class="ct-pick-dur num">${duration(a.duration)}</span>` : null}
            </span>
            <span class="ct-pick-title ellipsis">${a.title}</span>
            <span class="tiny faint">${KIND_LABEL[a.kind] || a.kind} · ${usedLabel(a.used_count)}</span>
          </button>`;
        })}</div>`
        : html`<${Empty} icon="image" title=${q || kind ? 'لا ملفات معتمدة تطابق البحث' : 'لا توجد تصاميم معتمدة بعد'}
            text=${q || kind ? 'جرّب كلمة أخرى أو اعرض كل الأنواع.' : 'ارفع التصاميم النهائية في المكتبة، وبعد «اعتماد التصميم» تظهر هنا مباشرة.'}
            action=${!q && !kind && html`<${Link} href="/library" class="btn sm"><${Icon} name="upload" size="15" />افتح المكتبة</${Link}>`} />`)}</${Loader}>
    </div>
  </${Modal}>`;
}
