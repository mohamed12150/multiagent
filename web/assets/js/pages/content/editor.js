// The post editor: media from the library, then the text the channel agent will publish.
import { html, cls, useState, useEffect } from '../../lib/h.js';
import { num, formatLabel } from '../../lib/format.js';
import { Icon, Button, Badge, Field, Thumb } from '../../ui/core.js';
import { MediaView, duration } from '../library/media.js';
import { ChipsInput } from './kit.js';
import { LibraryPicker } from './picker.js';
import {
  FORMATS, VIDEO_FORMATS, NEEDS_MEDIA, TEXT_LIMIT, TEXT_HINT, X_LIMIT, composedLength,
} from './shared.js';

const MAX_TAGS = 30;
const X_MEDIA = 4;
const SCRIPT_PLACEHOLDER = '[0-2ث] خطّاف: سؤال مباشر على الشاشة\n[2-8ث] المشكلة بلقطة قريبة\n[8-20ث] الحل أثناء الاستخدام…';

export const blankDraft = (channel) => ({
  channel, format: FORMATS[channel][0], title: '', caption: '', script: '', hashtags: [], cta: '', assets: [],
});
export const draftOf = (p) => ({
  channel: p.channel, format: p.format, title: p.title || '', caption: p.caption || '', script: p.script || '',
  hashtags: p.hashtags || [], cta: p.cta || '', assets: p.assets || [],
});
/** The PATCH /posts/{id} body (also the shape POST /posts takes, minus channel/campaign/submit). */
export const patchOf = (d) => ({
  title: d.title.trim(), caption: d.caption, script: d.script, hashtags: d.hashtags, cta: d.cta.trim(),
  format: d.format, asset_ids: d.assets.map((a) => a.id),
});
export const sameDraft = (a, b) => JSON.stringify(patchOf(a)) === JSON.stringify(patchOf(b));
export const showsScript = (d) => VIDEO_FORMATS.has(d.format) || !!d.script.trim() || d.assets.some((a) => a.kind === 'video');

// ---------------------------------------------------------------- media

function MediaArea({ draft, set, editable }) {
  const [sel, setSel] = useState(0);
  const [picking, setPicking] = useState(false);
  const { assets } = draft;
  const index = Math.min(sel, Math.max(assets.length - 1, 0));
  const cur = assets[index];
  useEffect(() => { if (sel > assets.length - 1) setSel(0); }, [assets.length]);
  const remove = (id) => set({ assets: assets.filter((a) => a.id !== id) });
  const makeCover = () => { set({ assets: [cur, ...assets.filter((a) => a.id !== cur.id)] }); setSel(0); };
  const needs = NEEDS_MEDIA.has(draft.channel);
  const picker = picking && html`<${LibraryPicker} selected=${assets} onClose=${() => setPicking(false)}
    onPick=${(list) => { set({ assets: list }); setSel(0); setPicking(false); }} />`;

  if (!cur) {
    return html`<div class=${cls('ct-media-empty', needs && 'need')}>
      <span class="mark"><${Icon} name="image" size="22" /></span>
      <div class="grow"><b>لا توجد ملفات مرفقة</b>
        <p class="small muted">${needs ? `${draft.channel === 'tiktok' ? 'تيك توك' : 'إنستقرام'} يحتاج صورة أو مقطعًا معتمدًا قبل الإرسال للاعتماد.`
          : 'أرفق تصميمًا معتمدًا من المكتبة لرفع التفاعل، أو انشر نصًا فقط.'}</p></div>
      ${editable && html`<${Button} size="sm" icon="image" onClick=${() => setPicking(true)}>اختر من المكتبة</${Button}>`}
      ${picker}
    </div>`;
  }
  return html`<div class="ct-media">
    <div class="ct-stage"><${MediaView} asset=${cur} />
      <div class="ct-stage-meta">
        <span class="ellipsis">${cur.title}</span>
        ${cur.kind === 'video' && cur.duration ? html`<span class="num">${duration(cur.duration)}</span>` : null}
        ${cur.width ? html`<span class="num ltr">${cur.width}×${cur.height}</span>` : null}
      </div>
    </div>
    <div class="ct-strip">
      ${assets.map((a, i) => html`<div class=${cls('ct-strip-item', i === index && 'on')} key=${a.id}>
        <${Thumb} asset=${a} onClick=${() => setSel(i)} />
        ${i === 0 && assets.length > 1 && html`<span class="ct-cover-tag">الغلاف</span>`}
        ${editable && html`<button type="button" class="ct-x" aria-label=${`إزالة ${a.title}`} onClick=${() => remove(a.id)}><${Icon} name="x" size="12" /></button>`}
      </div>`)}
      ${editable && html`<button type="button" class="ct-add" onClick=${() => setPicking(true)}><${Icon} name="plus" size="18" /><span>المكتبة</span></button>`}
    </div>
    ${(editable && index > 0) || (draft.channel === 'x' && assets.length > X_MEDIA) ? html`<div class="row wrap gap-6 mt-8">
      ${editable && index > 0 && html`<${Button} size="xs" variant="ghost" icon="star" onClick=${makeCover}>اجعله الغلاف</${Button}>`}
      ${draft.channel === 'x' && assets.length > X_MEDIA && html`<span class="tiny faint">إكس ينشر أول ${X_MEDIA} ملفات فقط.</span>`}
    </div>` : null}
    ${picker}
  </div>`;
}

// ---------------------------------------------------------------- text

function CaptionMeter({ draft }) {
  const len = composedLength(draft);
  const limit = TEXT_LIMIT[draft.channel];
  const isX = draft.channel === 'x';
  const over = len > limit;
  const parts = Math.ceil(len / X_LIMIT);
  let note = TEXT_HINT[draft.channel];
  if (isX && draft.format === 'thread') note = 'تُقسَّم السلسلة تلقائيًا إلى تغريدات كل 280 حرفًا.';
  else if (isX && over) note = `أطول من تغريدة واحدة، فسيُنشر كسلسلة من ${parts === 2 ? 'تغريدتين' : `${parts} تغريدات`}. اختصره أو حوّل الصيغة إلى سلسلة.`;
  else if (over) note = 'النص أطول من حد القناة، اختصره قبل الإرسال.';
  const tone = over ? (isX ? 'warn' : 'bad') : len > limit * 0.9 ? 'warn' : '';
  return html`<div class="ct-meter">
    <span class=${cls('ct-meter-note', tone)}>${note}</span>
    <span class=${cls('ct-meter-n num', tone)} title="طول النص كما سيُنشر، مع الوسوم">${num(len)} / ${num(limit)}</span>
  </div>`;
}

const ctaHelp = (ch) => (ch === 'x' ? 'في إكس لا تُضاف تلقائيًا، اكتبها داخل النص إن أردت.'
  : ch === 'whatsapp' ? 'تُضاف في نهاية الرسالة.' : 'تُضاف بعد النص إن لم تكن مكتوبة فيه.');

export function PostFields({ draft, set }) {
  const ch = draft.channel;
  return html`<div class="ct-fields">
    <div class="grid grid-2">
      <${Field} label="الصيغة">
        <select class="select" value=${draft.format} onChange=${(e) => set({ format: e.currentTarget.value })}>
          ${FORMATS[ch].map((f) => html`<option value=${f} key=${f}>${formatLabel(f)}</option>`)}
        </select>
      </${Field}>
      <${Field} label="عنوان داخلي" help="للتنظيم فقط، لا يُنشر">
        <input class="input" value=${draft.title} maxLength="200" placeholder="مثال: نصيحة الأسبوع"
          onInput=${(e) => set({ title: e.currentTarget.value })} />
      </${Field}>
    </div>
    <${Field} label=${ch === 'whatsapp' ? 'نص الرسالة' : 'النص'}>
      <textarea class="textarea ct-caption" rows="7" maxLength="6000" value=${draft.caption}
        placeholder=${ch === 'x' ? 'رأي حاد أو رقم لافت أو سؤال مباشر…' : 'أول سطر يوقف التمرير، ثم الفكرة باختصار، ثم الدعوة…'}
        onInput=${(e) => set({ caption: e.currentTarget.value })} />
      <${CaptionMeter} draft=${draft} />
    </${Field}>
    ${showsScript(draft) && html`<${Field} label="سكربت الفيديو" help="المشاهد بالتوقيت والنص الظاهر على الشاشة، يستخدمه فريق التصوير والمونتاج.">
      <textarea class="textarea ct-script" rows="6" maxLength="6000" value=${draft.script}
        placeholder=${SCRIPT_PLACEHOLDER}
        onInput=${(e) => set({ script: e.currentTarget.value })} />
    </${Field}>`}
    ${ch !== 'whatsapp' && html`<${Field} label="الوسوم" help="اضغط Enter أو مسافة بعد كل وسم.">
      <${ChipsInput} prefix="#" value=${draft.hashtags} max=${MAX_TAGS} onChange=${(hashtags) => set({ hashtags })}
        placeholder="#السعودية" label="الوسوم" />
    </${Field}>`}
    <${Field} label="الدعوة لاتخاذ إجراء" help=${ctaHelp(ch)}>
      <input class="input" value=${draft.cta} maxLength="200" placeholder="مثال: اطلب الآن من الرابط في الحساب"
        onInput=${(e) => set({ cta: e.currentTarget.value })} />
    </${Field}>
  </div>`;
}

/** What will be published, for viewers and for locked posts (publishing or published). */
export function PostText({ draft }) {
  return html`<div class="col gap-16">
    <div><span class="label">${draft.channel === 'whatsapp' ? 'نص الرسالة' : 'النص'}</span>
      <div class="well mt-8 pre">${draft.caption || html`<span class="faint">بلا نص</span>`}</div></div>
    ${draft.script && html`<div><span class="label">سكربت الفيديو</span><div class="well mt-8 pre ct-script">${draft.script}</div></div>`}
    ${draft.hashtags.length > 0 && html`<div><span class="label">الوسوم</span><div class="row wrap gap-6 mt-8">
      ${draft.hashtags.map((t) => html`<${Badge} tone="accent" key=${t}>${t}</${Badge}>`)}</div></div>`}
    ${draft.cta && html`<div><span class="label">الدعوة لاتخاذ إجراء</span><p class="mt-4">${draft.cta}</p></div>`}
  </div>`;
}

export function PostEditor({ draft, set, editable }) {
  return html`<div class="col gap-20">
    <section aria-label="الوسائط"><${MediaArea} draft=${draft} set=${set} editable=${editable} /></section>
    <section aria-label="النص">${editable ? html`<${PostFields} draft=${draft} set=${set} />` : html`<${PostText} draft=${draft} />`}</section>
  </div>`;
}
