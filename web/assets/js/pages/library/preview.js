// The file drawer (?asset=<id>): full media, metadata the content agent reads, «اعتماد التصميم», delete.
import { html, useState, useEffect } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { can } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Badge, StatusBadge, Field, KeyVal } from '../../ui/core.js';
import { Drawer, toast } from '../../ui/overlays.js';
import { ChipsInput, useLayer } from '../content/kit.js';
import { MediaView, ASSET_STATUS, KIND_LABEL, DEFAULT_FOLDER, duration, fileSize, usedLabel } from './media.js';

const MAX_TAGS = 30;
const FOLDER_LIST_ID = 'lb-folder-options';

const formOf = (a) => ({ title: a.title || '', description: a.description || '', tags: a.tags || [], folder: a.folder || DEFAULT_FOLDER });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uploader = (by) => (!by || by.startsWith('user:') ? 'أحد أعضاء الفريق' : by);

function StatusNotice({ asset: a }) {
  if (a.status === 'pending') {
    return html`<div class="notice warn"><${Icon} name="clock" size="18" /><div class="grow"><b>بانتظار «اعتماد التصميم»</b>
      لن يستخدمه صانع المحتوى حتى يُعتمد من صاحب صلاحية الاعتماد.</div></div>`;
  }
  if (a.status === 'rejected') {
    return html`<div class="notice bad"><${Icon} name="xCircle" size="18" /><div class="grow"><b>مرفوض</b>
      ${a.review_note || 'لن يُستخدم في أي منشور.'}</div></div>`;
  }
  return html`<div class="notice ok"><${Icon} name="checkCircle" size="18" /><div class="grow"><b>معتمد</b>
    متاح لصانع المحتوى ليختاره في المنشورات. ${usedLabel(a.used_count)}.</div></div>`;
}

function MetaForm({ form, set, folders }) {
  return html`<div class="col gap-16">
    <${Field} label="العنوان"><input class="input" value=${form.title} maxLength="200" onInput=${(e) => set({ title: e.currentTarget.value })} /></${Field}>
    <${Field} label="الوصف" help="يكتبه صانع المحتوى تلقائيًا عند الرفع، ويعتمد عليه لاختيار الملف المناسب لكل منشور.">
      <textarea class="textarea" rows="4" maxLength="2000" value=${form.description}
        placeholder="ماذا يظهر في التصميم، ولأي مناسبة أو منتج يصلح؟" onInput=${(e) => set({ description: e.currentTarget.value })} />
    </${Field}>
    <${Field} label="الوسوم" help="افصل بين الوسوم بفاصلة أو Enter.">
      <${ChipsInput} value=${form.tags} max=${MAX_TAGS} onChange=${(tags) => set({ tags })} placeholder="مثال: رمضان، عرض، منتج" label="الوسوم" />
    </${Field}>
    <${Field} label="المجلد">
      <input class="input" value=${form.folder} maxLength="80" list=${FOLDER_LIST_ID} onInput=${(e) => set({ folder: e.currentTarget.value })} />
      <datalist id=${FOLDER_LIST_ID}>${folders.map((f) => html`<option value=${f} key=${f} />`)}</datalist>
    </${Field}>
  </div>`;
}

function MetaView({ asset: a }) {
  return html`<${KeyVal} items=${[
    ['العنوان', a.title],
    ['الوصف', a.description || html`<span class="faint">بلا وصف بعد</span>`],
    ['الوسوم', a.tags?.length ? html`<span class="row wrap gap-6">${a.tags.map((t) => html`<span class="ct-tag" key=${t}>${t}</span>`)}</span>` : html`<span class="faint">لا توجد</span>`],
    ['المجلد', a.folder],
  ]} />`;
}

export function AssetDrawer({ asset, folders, onClose, onChanged, onDeleted }) {
  const [form, setForm] = useState(() => formOf(asset));
  const [base, setBase] = useState(asset);
  const [busy, setBusy] = useState('');
  const [blocked, setBlocked] = useState('');
  const dirty = !same(form, formOf(base));
  const editor = can('library');
  const mgr = can('approve');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // Follow list refreshes (e.g. صانع المحتوى just described it) unless there are unsaved edits.
  useEffect(() => { if (!dirty) { setForm(formOf(asset)); setBase(asset); } }, [asset]);

  const layer = useLayer(() => requestClose());
  const requestClose = async () => {
    if (dirty && !(await layer.ask({ title: 'تجاهل التعديلات؟', text: 'لم تُحفظ بيانات الملف بعد.', ok: 'تجاهل وأغلق', danger: true }))) return;
    onClose();
  };

  const save = async () => {
    if (!form.title.trim()) { toast('اكتب عنوانًا للملف', 'warn'); return; }
    setBusy('save');
    try {
      const updated = await api.patch(`/library/${asset.id}`, { ...form, title: form.title.trim(), folder: form.folder.trim() || DEFAULT_FOLDER });
      setBase(updated);
      setForm(formOf(updated));
      onChanged(updated);
      toast('حُفظت بيانات الملف');
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };

  const review = async (approve) => {
    let note = '';
    if (!approve) {
      const r = await layer.ask({ title: 'رفض التصميم', ok: 'ارفض التصميم', danger: true, input: true,
        text: 'لن يستخدمه صانع المحتوى. اكتب السبب ليعرف المصمم ما المطلوب (اختياري).',
        placeholder: 'مثال: الشعار غير واضح، والألوان لا تطابق الهوية' });
      if (r === false) return;
      note = r.trim();
    }
    setBusy(approve ? 'approve' : 'reject');
    try {
      const updated = await api.post(`/library/${asset.id}/review`, { approve, note });
      onChanged(updated);
      toast(approve ? 'اعتُمد التصميم وأصبح متاحًا لصانع المحتوى' : 'رُفض التصميم');
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };

  const remove = async () => {
    if (!(await layer.ask({ title: 'حذف الملف نهائيًا؟', text: 'سيُحذف من المكتبة والتخزين، ولا يمكن التراجع.', ok: 'احذف الملف', danger: true }))) return;
    setBusy('delete');
    setBlocked('');
    try {
      await api.del(`/library/${asset.id}`);
      toast('حُذف الملف');
      onDeleted(asset.id);
    } catch (e) {
      if (e.status === 409) { setBlocked(e.message); toast(e.message, 'warn', 'لا يمكن حذفه الآن'); } else toast.error(e);
      setBusy('');
    }
  };

  const a = asset;
  const b = (key) => ({ loading: busy === key, disabled: !!busy && busy !== key });
  const footer = html`
    ${mgr && a.status !== 'approved' && html`<${Button} variant="ok" icon="check" ...${b('approve')} onClick=${() => review(true)}>اعتماد التصميم</${Button}>`}
    ${mgr && a.status === 'pending' && html`<${Button} variant="danger" icon="x" ...${b('reject')} onClick=${() => review(false)}>ارفض مع ملاحظة</${Button}>`}
    ${editor && dirty && html`<${Button} variant=${mgr && a.status !== 'approved' ? '' : 'primary'} icon="save" ...${b('save')} onClick=${save}>احفظ البيانات</${Button}>`}
    <a class="btn ghost" href=${a.url} download=${a.original_name || a.title}><${Icon} name="download" size="16" />تنزيل</a>
    ${mgr && html`<${Button} variant="danger" class="ct-foot-end" icon="trash" title="حذف الملف" aria-label="حذف الملف" ...${b('delete')} onClick=${remove} />`}`;

  return html`<${Drawer} wide title=${a.title} onClose=${layer.close} footer=${footer}
    icon=${html`<span class="mark sm agent"><${Icon} name=${a.kind === 'video' ? 'video' : 'image'} size="15" /></span>`}
    head=${html`<${StatusBadge} map=${ASSET_STATUS} value=${a.status} />`}>
    <div class="col gap-20">
      <div class="lb-preview"><${MediaView} asset=${a} /></div>
      <div class="row wrap gap-6">
        <${Badge} icon=${a.kind === 'video' ? 'video' : 'image'}>${KIND_LABEL[a.kind] || a.kind}</${Badge}>
        ${a.ai_described && html`<${Badge} tone="accent" icon="sparkles">وصفه صانع المحتوى</${Badge}>`}
        <${Badge} icon="archive">${a.folder}</${Badge}>
      </div>
      <${StatusNotice} asset=${a} />
      ${blocked && html`<div class="notice bad"><${Icon} name="lock" size="18" /><div class="grow"><b>الملف مستخدم</b>${blocked}</div></div>`}
      <section aria-label="البيانات"><h3>البيانات</h3><div class="mt-12">
        ${editor ? html`<${MetaForm} form=${form} set=${set} folders=${folders} />` : html`<${MetaView} asset=${a} />`}</div></section>
      <section aria-label="معلومات الملف"><h3>معلومات الملف</h3><div class="mt-8"><${KeyVal} items=${[
        a.mime && ['الصيغة', html`<span class="ltr num">${a.mime.split('/')[1]?.toUpperCase()}</span>`],
        a.width > 0 && ['الأبعاد', html`<span class="ltr num">${a.width}×${a.height}</span>`],
        a.kind === 'video' && ['المدة', html`<span class="num">${a.duration ? duration(a.duration) : 'غير معروفة'}</span>`],
        ['الحجم', html`<span class="ltr num">${fileSize(a.size)}</span>`],
        ['رُفع', `${F.dateTime(a.created_at)} · ${uploader(a.uploaded_by)}`],
        a.original_name && ['الاسم الأصلي', html`<span class="ltr ellipsis lb-orig" title=${a.original_name}>${a.original_name}</span>`],
        ['الاستخدام', usedLabel(a.used_count)],
      ]} /></div></section>
    </div>
  </${Drawer}>`;
}
