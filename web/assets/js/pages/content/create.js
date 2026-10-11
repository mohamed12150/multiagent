// New content: ask صانع المحتوى to write (a task per channel), or write a post by hand.
import { html, cls, useState } from '../../lib/h.js';
import { api, useApi } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Seg, Field, ChannelMark, AgentMark } from '../../ui/core.js';
import { Drawer, toast } from '../../ui/overlays.js';
import { useLayer, counted } from './kit.js';
import { PostEditor, blankDraft, patchOf } from './editor.js';
import { FORMATS, NEEDS_MEDIA } from './shared.js';

const COUNTS = [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }));
const POSTS_ACC = ['منشورًا واحدًا', 'منشورين', 'منشورات', 'منشورًا']; // object of «يكتب»
const BRIEF_IDEAS = ['عرض نهاية الأسبوع', 'نصيحة عملية لعملائنا', 'قصة عميل سعيد', 'خلف الكواليس في فريقنا', 'إطلاق منتج جديد'];
const DEFAULT_CHANNEL = 'instagram';

/** Single: onChange(channel). Multiple: onChange(updater) so fast taps never drop a choice (pass a setState). */
export function ChannelPicker({ value, onChange, multiple = false }) {
  const isOn = (ch) => (multiple ? value.includes(ch) : value === ch);
  const flip = (ch) => {
    if (!multiple) { onChange(ch); return; }
    onChange((cur) => (cur.includes(ch) ? cur.filter((c) => c !== ch) : [...cur, ch]));
  };
  return html`<div class="ct-chan-pick" role="group" aria-label="القنوات">${F.CHANNELS.map((ch) => html`
    <button type="button" key=${ch} class=${cls('ct-chan', isOn(ch) && 'on')} aria-pressed=${isOn(ch)} onClick=${() => flip(ch)}>
      <${ChannelMark} ch=${ch} size="sm" /><span>${F.CHANNEL_LABEL[ch]}</span>
      ${isOn(ch) && html`<${Icon} name="check" size="14" class="ct-chan-ok" />`}
    </button>`)}</div>`;
}

function CampaignSelect({ state, value, onChange }) {
  const rows = state.data || [];
  return html`<${Field} label="الحملة" help=${state.error ? 'تعذر تحميل الحملات، يمكنك المتابعة بدونها.' : 'اختياري. يربط المنشورات بحملة نشطة ويستفيد من جمهورها وعرضها.'}>
    <select class="select" value=${value} disabled=${!state.data} onChange=${(e) => onChange(e.currentTarget.value)}>
      <option value="">${!state.data && !state.error ? 'يحمّل الحملات…' : rows.length ? 'بدون حملة' : 'لا توجد حملات نشطة'}</option>
      ${rows.map((c) => html`<option value=${c.id} key=${c.id}>${c.name}</option>`)}
    </select>
  </${Field}>`;
}

// ---------------------------------------------------------------- ask the content agent

export function RequestDrawer({ onClose, onStarted }) {
  const [channels, setChannels] = useState([]);
  const [count, setCount] = useState(3);
  const [brief, setBrief] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState(false);
  const camps = useApi('/campaigns?status=active');
  const lib = useApi('/library?status=approved&limit=1');
  const approved = lib.meta ? lib.meta.counts?.approved || 0 : null;
  const needMedia = channels.some((c) => NEEDS_MEDIA.has(c));

  const pickCampaign = (cid) => {
    setCampaignId(cid);
    const c = (camps.data || []).find((x) => x.id === cid);
    if (c && !channels.length) setChannels((c.channels || []).filter((ch) => F.CHANNELS.includes(ch)));
  };
  const addIdea = (idea) => setBrief((b) => (b.trim() ? `${b.trim()}، ${idea}` : idea));

  const send = async () => {
    if (!channels.length) { toast('اختر قناة واحدة على الأقل', 'warn'); return; }
    setBusy(true);
    const body = (channel) => ({ channel, brief: brief.trim(), count, campaign_id: campaignId || null });
    const results = await Promise.allSettled(channels.map((ch) => api.post('/posts/generate', body(ch))));
    const started = channels.filter((_, i) => results[i].status === 'fulfilled');
    results.forEach((r) => { if (r.status === 'rejected') toast.error(r.reason); });
    setBusy(false);
    if (!started.length) return;
    const names = started.map((ch) => F.CHANNEL_LABEL[ch]).join('، ');
    toast(`يكتب الآن ${counted(count, POSTS_ACC)} ${started.length > 1 ? 'لكل قناة من' : 'لـ'} ${names}. تظهر في اللوحة فور جاهزيتها.`,
      'ok', 'بدأ صانع المحتوى');
    onStarted();
    onClose();
  };

  const footer = html`<${Button} variant="primary" icon="wand" loading=${busy} disabled=${!channels.length} onClick=${send}>ابدأ الكتابة</${Button}>
    <${Button} variant="ghost" onClick=${onClose}>إلغاء</${Button}>`;
  return html`<${Drawer} title="اطلب محتوى من صانع المحتوى" onClose=${onClose} icon=${html`<${AgentMark} id="content" size="sm" />`} footer=${footer}>
    <div class="col gap-20">
      <p class="muted">يكتب صانع المحتوى النص والسكربت والوسوم بأسلوب كل قناة، ويختار لكل منشور تصميمًا معتمدًا من المكتبة.</p>
      <${Field} label="القنوات" help="تُكتب منشورات مستقلة لكل قناة تختارها.">
        <${ChannelPicker} multiple value=${channels} onChange=${setChannels} />
      </${Field}>
      <${Field} label="عدد المنشورات لكل قناة">
        <div><${Seg} options=${COUNTS} value=${count} onChange=${setCount} label="عدد المنشورات" /></div>
      </${Field}>
      <${Field} label="الفكرة أو التوجيه" help="اختياري. اتركه فارغًا ليختار صانع المحتوى الأنسب لعلامتك اليوم.">
        <textarea class="textarea" rows="4" maxLength="1500" value=${brief} onInput=${(e) => setBrief(e.currentTarget.value)}
          placeholder="مثال: خصم 20٪ على الطلب الأول حتى نهاية الأسبوع، بنبرة ودودة" />
        <div class="row wrap gap-6">${BRIEF_IDEAS.map((idea) => html`<button type="button" class="chip" key=${idea} onClick=${() => addIdea(idea)}>
          <${Icon} name="plus" size="13" />${idea}</button>`)}</div>
      </${Field}>
      <${CampaignSelect} state=${camps} value=${campaignId} onChange=${pickCampaign} />
      ${approved === 0 && needMedia ? html`<div class="notice warn"><${Icon} name="image" size="18" /><div class="grow">
          <b>لا توجد تصاميم معتمدة في المكتبة</b>منشورات تيك توك وإنستقرام ستصل كمسودات تنتظر صورة أو مقطعًا معتمدًا.</div>
          <${Link} href="/library" class="btn sm">افتح المكتبة</${Link}></div>`
        : approved > 0 ? html`<p class="small faint row gap-6"><${Icon} name="image" size="15" />الملفات المعتمدة المتاحة لصانع المحتوى: <b class="num">${F.num(approved)}</b></p>` : null}
    </div>
  </${Drawer}>`;
}

// ---------------------------------------------------------------- manual post

export function NewPostDrawer({ onClose, onCreated }) {
  const [draft, setDraft] = useState(() => blankDraft(DEFAULT_CHANNEL));
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState('');
  const camps = useApi('/campaigns?status=active');
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const touched = !!(draft.caption.trim() || draft.title.trim() || draft.script.trim() || draft.assets.length);
  const layer = useLayer(() => requestClose());
  const requestClose = async () => {
    if (touched && !(await layer.ask({ title: 'تجاهل المنشور؟', text: 'لم يُحفظ ما كتبته بعد.', ok: 'تجاهل وأغلق', danger: true }))) return;
    onClose();
  };
  const pickChannel = (ch) => set({ channel: ch, format: FORMATS[ch].includes(draft.format) ? draft.format : FORMATS[ch][0] });
  const lacksMedia = NEEDS_MEDIA.has(draft.channel) && !draft.assets.length;

  const create = async (submit) => {
    if (!draft.caption.trim()) { toast('اكتب نص المنشور أولًا', 'warn'); return; }
    if (submit && lacksMedia) { toast('أرفق صورة أو مقطعًا معتمدًا قبل الإرسال للاعتماد', 'warn'); return; }
    setBusy(submit ? 'submit' : 'draft');
    try {
      const post = await api.post('/posts', { ...patchOf(draft), channel: draft.channel, campaign_id: campaignId || null, submit });
      toast(submit ? 'أُرسل المنشور للاعتماد' : 'حُفظ المنشور في المسودات');
      onCreated(post);
    } catch (e) { toast.error(e); setBusy(''); }
  };

  const footer = html`<${Button} variant="primary" icon="send" loading=${busy === 'submit'} disabled=${!!busy}
      title=${lacksMedia ? 'أرفق صورة أو مقطعًا معتمدًا أولًا' : undefined} onClick=${() => create(true)}>احفظ وأرسل للاعتماد</${Button}>
    <${Button} icon="save" loading=${busy === 'draft'} disabled=${!!busy} onClick=${() => create(false)}>احفظ كمسودة</${Button}>
    <${Button} variant="ghost" onClick=${requestClose}>إلغاء</${Button}>`;
  return html`<${Drawer} wide title="منشور يدوي" onClose=${layer.close} icon=${html`<span class="mark sm agent"><${Icon} name="edit" size="15" /></span>`} footer=${footer}>
    <div class="col gap-20">
      <${Field} label="القناة"><${ChannelPicker} value=${draft.channel} onChange=${pickChannel} /></${Field}>
      <${PostEditor} draft=${draft} set=${set} editable />
      <${CampaignSelect} state=${camps} value=${campaignId} onChange=${setCampaignId} />
    </div>
  </${Drawer}>`;
}
