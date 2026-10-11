// The post drawer (?post=<id>): media and text, plus the one action that fits the post's stage.
import { html, cls, useState, useEffect } from '../../lib/h.js';
import { api, useApi } from '../../lib/api.js';
import { useLive } from '../../lib/live.js';
import { Link } from '../../lib/router.js';
import { can } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Badge, StatusBadge, SimTag, Stat, Skeleton, Loader, ChannelMark, KeyVal } from '../../ui/core.js';
import { Drawer, toast } from '../../ui/overlays.js';
import { useDebounced, useLayer } from './kit.js';
import { PostEditor, draftOf, patchOf, sameDraft } from './editor.js';
import { EDITABLE, NEEDS_MEDIA, METRICS, authorOf } from './shared.js';

const LIVE_RELOAD_MS = 800;
const NOTE_TITLE = { draft: 'ملاحظة على المسودة', approved: 'من المنسّق', published: 'ملاحظة النشر' };

function DrawerSkeleton() {
  return html`<div class="col gap-16"><div class="skeleton ct-stage-sk" />
    <div class="row gap-6"><${Skeleton} h=${60} w="64px" /><${Skeleton} h=${60} w="64px" /></div>
    <${Skeleton} lines=${2} h=${40} /><${Skeleton} h=${150} /><${Skeleton} lines=${2} h=${40} /></div>`;
}

// ---------------------------------------------------------------- stage panels

function StatusNotices({ post: p, stale, onLatest }) {
  return html`
    ${stale && html`<div class="notice warn"><${Icon} name="history" size="18" /><div class="grow"><b>وصلت نسخة أحدث</b>
      عُدّل هذا المنشور أثناء تحريرك. احفظ لتعتمد نسختك، أو حمّل الأحدث وتجاهل تعديلاتك.</div>
      <${Button} size="sm" onClick=${onLatest}>حمّل الأحدث</${Button}></div>`}
    ${p.status === 'failed' && html`<div class="notice bad"><${Icon} name="alert" size="18" /><div class="grow"><b>تعذر النشر</b>
      <span class="pre">${p.error || 'لم يكتمل النشر على القناة.'}</span></div></div>`}
    ${p.review_note && p.status !== 'failed' && html`<div class="notice warn"><${Icon} name=${p.status === 'approved' ? 'lightbulb' : 'alert'} size="18" />
      <div class="grow"><b>${NOTE_TITLE[p.status] || 'ملاحظة'}</b>${p.review_note}</div></div>`}
    ${p.status === 'review' && !can('manager') && html`<div class="notice"><${Icon} name="info" size="18" />
      <div class="grow">بانتظار اعتماد المدير. يمكنك تعديله حتى يُعتمد.</div></div>`}
    ${p.status === 'scheduled' && !can('editor') && html`<div class="notice"><${Icon} name="calendar" size="18" />
      <div class="grow">مجدول للنشر ${p.scheduled_human} بتوقيت الرياض.</div></div>`}
    ${p.status === 'publishing' && html`<div class="notice"><span class="status-dot working" />
      <div class="grow">وكيل ${p.channel_label} ينشر هذا المنشور الآن.</div></div>`}
    ${p.status === 'published' && html`<div class="notice ok"><${Icon} name="checkCircle" size="18" />
      <div class="grow"><b>نُشر على ${p.channel_label}</b>${F.dateTime(p.published_at)}</div>
      ${p.external_url && html`<a class="btn sm" href=${p.external_url} target="_blank" rel="noopener noreferrer">
        <${Icon} name="arrowUpRight" size="15" />افتح المنشور</a>`}</div>`}`;
}

function SchedulePanel({ post: p, busy, onSchedule, onUnschedule, onPublish }) {
  const [at, setAt] = useState(() => F.localInput(p.scheduled_at));
  useEffect(() => setAt(F.localInput(p.scheduled_at)), [p.scheduled_at]);
  const scheduled = p.status === 'scheduled';
  const suggested = !scheduled && !!p.scheduled_at;
  const untouched = at === F.localInput(p.scheduled_at);
  const label = scheduled ? 'غيّر الموعد' : suggested && untouched ? 'اعتمد الوقت المقترح' : 'جدول';
  return html`<section class="ct-sched" aria-label="الجدولة">
    <div class="row wrap gap-6">
      <b class="grow row gap-6"><${Icon} name="calendar" size="17" />${scheduled ? 'موعد النشر' : 'جدولة النشر'}</b>
      ${suggested && html`<${Badge} tone="accent" icon="lightbulb">اقترحه المنسّق</${Badge}>`}
      ${scheduled && html`<${Badge} tone="live" icon="clock">${F.until(p.scheduled_at)}</${Badge}>`}
    </div>
    <p class="small muted mt-4">${scheduled ? `سيُنشر ${p.scheduled_human} بتوقيت الرياض.`
      : suggested ? 'اختار المنسّق هذا الوقت من أفضل أوقات التفاعل في القناة. اعتمده أو اختر وقتًا آخر.'
        : 'اختر الوقت بتوقيت الرياض، أو اترك المنسّق يختار أفضل وقت تلقائيًا.'}</p>
    <div class="ct-sched-row mt-12">
      <input type="datetime-local" class="input ltr" value=${at} aria-label="وقت النشر بتوقيت الرياض"
        onInput=${(e) => setAt(e.currentTarget.value)} />
      <${Button} variant="primary" icon="calendar" loading=${busy === 'schedule'} disabled=${!at || !!busy}
        onClick=${() => onSchedule(at)}>${label}</${Button}>
      ${scheduled && html`<${Button} icon="x" loading=${busy === 'unschedule'} disabled=${!!busy} onClick=${onUnschedule}>ألغِ الجدولة</${Button}>`}
      ${can('manager') && html`<${Button} icon="rocket" loading=${busy === 'publish'} disabled=${!!busy} onClick=${onPublish}>انشر الآن</${Button}>`}
    </div>
  </section>`;
}

function Metrics({ post: p }) {
  const m = p.metrics || {};
  return html`<section aria-label="الأداء"><h3>الأداء</h3><div class="ct-metrics mt-8">
    ${METRICS.map(([k, label, icon]) => html`<${Stat} key=${k} label=${label} icon=${icon} value=${F.compact(m[k] || 0)} />`)}
    <${Stat} label="معدل التفاعل" icon="trend" value=${`${p.engagement_rate || 0}٪`} hint=${`${F.compact(p.engagement)} تفاعل`} />
  </div></section>`;
}

function Details({ post: p }) {
  const approver = p.approved_by ? (p.approved_by.startsWith('user:') ? 'أحد المديرين' : authorOf(p.approved_by).name) : '';
  return html`<section aria-label="التفاصيل"><h3>التفاصيل</h3><div class="mt-8"><${KeyVal} items=${[
    ['القناة', html`<span class="row gap-6"><${ChannelMark} ch=${p.channel} size="sm" />${p.channel_label} · ${F.formatLabel(p.format)}</span>`],
    ['كتبه', authorOf(p.author_agent).name],
    p.campaign_id && ['الحملة', html`<${Link} href=${`/campaigns/${p.campaign_id}`}>عرض الحملة</${Link}>`],
    ['الإصدار', html`<span class="num">${p.version}</span>`],
    ['أُنشئ', F.dateTime(p.created_at)],
    ['آخر تحديث', F.ago(p.updated_at)],
    approver && ['اعتمده', approver],
    p.promoted_budget > 0 && ['ميزانية الترويج', F.money(p.promoted_budget)],
  ]} /></div></section>`;
}

function Footer({ post: p, draft, dirty, editable, busy, act }) {
  const s = p.status;
  const ed = can('editor');
  const mgr = can('manager');
  const lacksMedia = NEEDS_MEDIA.has(p.channel) && !draft?.assets.length;
  const b = (key) => ({ loading: busy === key, disabled: !!busy && busy !== key });
  return html`
    ${ed && ['draft', 'idea', 'rejected'].includes(s) && html`<${Button} variant="primary" icon="send" ...${b('submit')}
      disabled=${!!busy || lacksMedia} title=${lacksMedia ? 'أرفق صورة أو مقطعًا معتمدًا أولًا' : undefined}
      onClick=${act.submit}>${s === 'rejected' ? 'أعد الإرسال للاعتماد' : 'أرسل للاعتماد'}</${Button}>`}
    ${mgr && s === 'review' && html`<${Button} variant="ok" icon="check" ...${b('approve')} onClick=${act.approve}>اعتماد</${Button}>
      <${Button} icon="edit" ...${b('edit')} onClick=${act.requestEdit}>اطلب تعديل</${Button}>
      <${Button} variant="danger" icon="x" ...${b('reject')} onClick=${act.reject}>رفض</${Button}>`}
    ${mgr && s === 'failed' && html`<${Button} variant="primary" icon="refresh" ...${b('publish')} onClick=${act.retry}>أعد المحاولة</${Button}>`}
    ${dirty && editable && html`<${Button} icon="save" ...${b('save')} onClick=${act.save}>احفظ التعديلات</${Button}>`}
    ${mgr && (s === 'approved' || s === 'scheduled') && html`<${Button} variant="ghost" icon="edit" ...${b('edit')} onClick=${act.requestEdit}>اطلب تعديل</${Button}>`}
    ${mgr && s !== 'publishing' && html`<${Button} variant="danger" class="ct-foot-end" icon="trash" title="حذف المنشور" aria-label="حذف المنشور"
      ...${b('delete')} onClick=${act.remove} />`}`;
}

// ---------------------------------------------------------------- drawer

export function PostDrawer({ id, onClose, onChanged }) {
  const st = useApi(`/posts/${id}`);
  const post = st.data;
  const [draft, setDraft] = useState(null);
  const [base, setBase] = useState(null);
  const [busy, setBusy] = useState('');
  const dirty = !!(draft && base && !sameDraft(draft, draftOf(base)));
  const stale = dirty && !!post && post.version !== base.version;
  const editable = !!post && can('editor') && EDITABLE.has(post.status);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  // Adopt server changes (agent revisions, scheduling) unless the user has unsaved edits.
  useEffect(() => { if (post && (!draft || !dirty)) { setDraft(draftOf(post)); setBase(post); } }, [post]);

  const reload = useDebounced(() => st.reload(true), LIVE_RELOAD_MS);
  useLive('task', (d) => {
    const t = d.task || {};
    if (d.event === 'created') return;
    if (t.input?.post_id === id || t.kind === 'coordinator.distribute' || t.kind === 'channel.publish') reload();
  });
  useLive('feed', (ev) => { if (ev.ref_id === id || ev.kind === 'content.scheduled') reload(); });
  useLive('approvals', reload);

  const layer = useLayer(() => requestClose());
  const requestClose = async () => {
    if (dirty && !(await layer.ask({ title: 'تجاهل التعديلات؟', text: 'لديك تعديلات لم تُحفظ على هذا المنشور.',
      ok: 'تجاهل وأغلق', danger: true }))) return;
    onClose();
  };

  const save = async (quiet = false) => {
    const updated = await api.patch(`/posts/${id}`, patchOf(draft));
    st.setData((p) => ({ ...updated, approval_id: p?.approval_id ?? null }));
    setDraft(draftOf(updated));
    setBase(updated);
    if (!quiet) toast('حُفظت التعديلات');
    onChanged();
    return updated;
  };

  /** Save pending edits first, then run the stage action, then refresh quietly. */
  const run = async (key, fn, done) => {
    setBusy(key);
    try {
      if (dirty && editable) await save(true);
      const out = await fn();
      const msg = typeof done === 'function' ? done(out) : done;
      if (msg) toast(msg);
      onChanged();
      st.reload(true);
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };

  const act = {
    save: () => run('save', () => null, 'حُفظت التعديلات'),
    submit: () => run('submit', () => api.post(`/posts/${id}/submit`), 'أُرسل المنشور للاعتماد'),
    approve: () => run('approve', () => api.post(`/posts/${id}/approve`, { note: '' }), 'اعتُمد المنشور، وسيجدوله المنسّق في أفضل وقت'),
    async requestEdit() {
      const note = await layer.ask({ title: 'اطلب تعديلًا من صانع المحتوى', ok: 'أرسل الملاحظة', input: true,
        text: 'اكتب ما تريد تغييره، وسيعيد صانع المحتوى كتابة المنشور ثم يرسله لك من جديد.',
        placeholder: 'مثال: اجعل الافتتاحية أقصر واذكر عرض نهاية الأسبوع' });
      if (note === false) return;
      if (!note.trim()) { toast('اكتب ملاحظتك حتى يعرف صانع المحتوى المطلوب', 'warn'); return; }
      run('edit', () => api.post(`/posts/${id}/reject`, { note: note.trim() }), 'وصلت ملاحظتك لصانع المحتوى، وسيعيد المنشور للاعتماد بعد التعديل');
    },
    async reject() {
      if (!(await layer.ask({ title: 'رفض المنشور؟', text: 'سيُنقل إلى المرفوضات ولن يُنشر. يمكن تعديله وإعادة إرساله لاحقًا.',
        ok: 'ارفض المنشور', danger: true }))) return;
      run('reject', () => api.post(`/posts/${id}/reject`, { note: '' }), 'رُفض المنشور');
    },
    schedule: (at) => run('schedule', () => api.post(`/posts/${id}/schedule`, { at }), (p) => `جُدول المنشور: ${p.scheduled_human}`),
    unschedule: () => run('unschedule', () => api.post(`/posts/${id}/unschedule`), 'أُلغيت الجدولة وعاد المنشور إلى المعتمد'),
    async publishNow() {
      if (!(await layer.ask({ title: 'النشر الآن؟', text: `سيبدأ وكيل ${post.channel_label} النشر فورًا على الحساب المتصل.`,
        ok: 'انشر الآن' }))) return;
      run('publish', () => api.post(`/posts/${id}/publish-now`), `بدأ وكيل ${post.channel_label} النشر الآن`);
    },
    retry: () => run('publish', () => api.post(`/posts/${id}/publish-now`), `بدأ وكيل ${post.channel_label} محاولة النشر من جديد`),
    async remove() {
      const text = post.status === 'published' ? 'يُحذف من المنصة فقط، ويبقى منشورًا على القناة.' : 'سيُحذف المنشور نهائيًا مع طلب اعتماده إن وُجد.';
      if (!(await layer.ask({ title: 'حذف المنشور؟', text, ok: 'احذف', danger: true }))) return;
      setBusy('delete');
      try {
        await api.del(`/posts/${id}`);
        toast('حُذف المنشور');
        onChanged();
        onClose();
      } catch (e) { toast.error(e); setBusy(''); }
    },
  };

  const latest = () => { setDraft(draftOf(post)); setBase(post); };
  return html`<${Drawer} wide title=${post ? post.title || 'منشور بلا عنوان' : 'المنشور'} onClose=${layer.close}
    icon=${post && html`<${ChannelMark} ch=${post.channel} size="sm" />`}
    head=${post && html`<span class="row gap-6 ct-drawer-head">${post.sandbox && html`<${SimTag} />`}<${StatusBadge} map=${F.POST_STATUS} value=${post.status} /></span>`}
    footer=${post && html`<${Footer} post=${post} draft=${draft} dirty=${dirty} editable=${editable} busy=${busy} act=${act} />`}>
    <${Loader} state=${st} skeleton=${html`<${DrawerSkeleton} />`}>${(p) => html`<div class=${cls('col gap-20', busy && 'ct-busy')}>
      <${StatusNotices} post=${p} stale=${stale} onLatest=${latest} />
      ${p.status === 'published' && html`<${Metrics} post=${p} />`}
      ${(p.status === 'approved' || p.status === 'scheduled') && can('editor') && html`<${SchedulePanel} post=${p} busy=${busy}
        onSchedule=${act.schedule} onUnschedule=${act.unschedule} onPublish=${act.publishNow} />`}
      ${draft && html`<${PostEditor} draft=${draft} set=${set} editable=${editable} />`}
      <${Details} post=${p} />
    </div>`}</${Loader}>
  </${Drawer}>`;
}
