// The open conversation: bubbles, inline approval of a pending AI reply, status actions and the composer.
import { html, cls, useState, useEffect, useRef, useMemo, Fragment } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { can } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Button, StatusBadge, SimTag, ChannelMark, Empty, Skeleton } from '../../ui/core.js';
import { toast } from '../../ui/overlays.js';
import { AGENT_NAME, KIND, OUT_STATUS, authorLabel, contactName } from './vocab.js';

const DAY_MS = 864e5;
const at = (iso) => (iso ? new Date(iso.endsWith('Z') ? iso : `${iso}Z`).getTime() : 0);

const STATUS_ACTIONS = {
  escalate: { to: 'escalated', label: 'حوّلها لي', icon: 'flag', ok: 'نُقلت المحادثة إلى «تحتاجك»' },
  deescalate: { to: 'open', label: 'إلغاء التصعيد', icon: 'refresh', ok: 'أُعيدت المحادثة إلى الجديدة' },
  reopen: { to: 'open', label: 'إعادة فتح', icon: 'refresh', ok: 'أُعيد فتح المحادثة' },
  close: { to: 'closed', label: 'إغلاق', icon: 'check', ok: 'أُغلقت المحادثة' },
};
const actionsFor = (status) => (status === 'closed' ? ['reopen'] : status === 'escalated' ? ['deescalate', 'close'] : ['escalate', 'close']);

function lastInboundAge(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.direction === 'in');
  return last ? Date.now() - at(last.created_at) : 0;
}

// ---------------------------------------------------------------- pending AI reply

function PendingReply({ m, approval, onDecided }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  const [busy, setBusy] = useState('');
  if (!can('approve')) return html`<p class="tiny faint ib-pnote">ينتظر هذا الرد الاعتماد قبل إرساله.</p>`;
  if (!approval) {
    return html`<p class="tiny faint ib-pnote">طلب الاعتماد في <${Link} href="/approvals?kind=reply">مكتب الاعتماد</${Link}>.</p>`;
  }
  const decide = async (key, approve, body) => {
    setBusy(key);
    try {
      await api.post(`/approvals/${approval.id}/decide`, { approve, note: '', ...(body !== undefined ? { text: body } : {}) });
      toast(approve ? 'اعتُمد الرد وسيُرسل للعميل خلال لحظات' : 'تجاهلنا الرد المقترح ولن يُرسل');
      setEditing(false);
      onDecided?.();
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  if (editing) {
    return html`<div class="ib-pending">
      <textarea class="textarea" rows="4" value=${text} aria-label="نص الرد قبل الاعتماد" onInput=${(e) => setText(e.currentTarget.value)} />
      <div class="row wrap gap-6 mt-8">
        <${Button} size="sm" variant="primary" icon="send" loading=${busy === 'edit'} disabled=${!text.trim()}
          onClick=${() => decide('edit', true, text.trim())}>اعتمد النص المعدّل وأرسله</${Button}>
        <${Button} size="sm" variant="ghost" onClick=${() => { setEditing(false); setText(m.text); }}>إلغاء</${Button}>
      </div></div>`;
  }
  return html`<div class="ib-pending row wrap gap-6">
    <${Button} size="sm" variant="ok" icon="check" loading=${busy === 'ok'} disabled=${!!busy} onClick=${() => decide('ok', true)}>اعتماد وإرسال</${Button}>
    <${Button} size="sm" icon="edit" disabled=${!!busy} onClick=${() => setEditing(true)}>تعديل ثم اعتماد</${Button}>
    <${Button} size="sm" variant="ghost" icon="x" loading=${busy === 'no'} disabled=${!!busy} onClick=${() => decide('no', false)}>تجاهل</${Button}>
  </div>`;
}

// ---------------------------------------------------------------- bubbles

function AiNote({ meta, author }) {
  if (meta.consent) return html`<p class="ib-ainote"><${Icon} name="lock" size="12" />رسالة تأكيد اشتراك أرسلها الوكيل تلقائيًا</p>`;
  if (!meta.category) return null;
  return html`<p class="ib-ainote"><${Icon} name="sparkles" size="12" />
    <span>صنّفها ${AGENT_NAME[author] || 'الوكيل'}: <b>${F.label(F.CATEGORY, meta.category)}</b>${meta.summary ? `. ${meta.summary}` : ''}</span></p>`;
}

function Bubble({ m, contact, meId, approval, onDecided }) {
  const ours = m.direction === 'out';
  const st = ours ? OUT_STATUS[m.status] : null;
  const meta = m.meta || {};
  const pendingLabel = m.status === 'pending' && !can('approve') ? 'بانتظار الاعتماد' : null;
  return html`<div class=${cls('ib-msg', ours ? 'out' : 'in', ours && `st-${m.status}`)}>
    <span class="ib-author">${authorLabel(m.author, contact, meId)}</span>
    <div class="ib-bubble"><p class="pre">${m.text}</p></div>
    <div class="ib-mfoot">
      <span class="tiny faint" title=${F.dateTime(m.created_at)}>${F.time(m.created_at)}</span>
      ${st && html`<span class=${cls('ib-st', st[1])}><${Icon} name=${st[2]} size="12" />${pendingLabel || st[0]}</span>`}
      ${ours && (meta.sandbox || meta.simulated) && html`<${SimTag} />`}
    </div>
    ${m.status === 'failed' && meta.error && html`<p class="tiny ib-err">${meta.error}</p>`}
    ${ours && html`<${AiNote} meta=${meta} author=${m.author} />`}
    ${m.status === 'pending' && html`<${PendingReply} m=${m} approval=${approval} onDecided=${onDecided} />`}
  </div>`;
}

function Messages({ conv, approvals, meId, onDecided }) {
  const box = useRef(null);
  const msgs = conv.messages || [];
  const byRef = useMemo(() => Object.fromEntries((approvals || []).map((a) => [a.ref_id, a])), [approvals]);
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs.length, conv.id]);
  return html`<div class="ib-msgs" ref=${box}>
    ${conv.post_id && html`<${Link} href=${`/content?post=${conv.post_id}`} class="ib-onpost"><${Icon} name="file" size="14" />هذه المحادثة تعليق على منشور، افتحه</${Link}>`}
    ${msgs.length ? msgs.map((m, i) => {
      const day = F.date(m.created_at);
      const sep = i === 0 || day !== F.date(msgs[i - 1].created_at);
      return html`<${Fragment} key=${m.id}>${sep && html`<div class="ib-day"><span>${day}</span></div>`}
        <${Bubble} m=${m} contact=${conv.contact} meId=${meId} approval=${byRef[m.id]} onDecided=${onDecided} /></${Fragment}>`;
    }) : html`<${Empty} icon="message" title="لا رسائل في هذه المحادثة" text="ستظهر الرسائل هنا فور وصولها من القناة." />`}
  </div>`;
}

// ---------------------------------------------------------------- composer

function Composer({ conv, hasPending, onSent }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  if (!can('inbox')) return html`<div class="ib-composer ro small faint">صلاحيتك للمشاهدة فقط، فلا يمكنك الرد من حسابك.</div>`;
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy('send');
    try { await api.post(`/inbox/${conv.id}/reply`, { text: body }); setText(''); toast('أُرسل ردك وسيصل للعميل خلال لحظات'); onSent?.(); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const suggest = async () => {
    setBusy('ai');
    try { await api.post(`/inbox/${conv.id}/ai-reply`); toast('بدأ صانع المحتوى تجهيز رد مقترح، وسيظهر هنا بعد لحظات'); } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const stale = conv.channel === 'whatsapp' && lastInboundAge(conv.messages) > DAY_MS;
  return html`<div class="ib-composer">
    ${stale && html`<div class="notice warn ib-cnotice"><${Icon} name="clock" size="16" /><div class="grow">مرّت أكثر من 24 ساعة على آخر رسالة من العميل، وواتساب لا يسمح حينها إلا بقالب معتمد، فقد يتعذر إرسال رد نصي حر.</div></div>`}
    <textarea class="ib-input" rows="2" value=${text} placeholder="اكتب ردك على العميل…" aria-label="نص الرد"
      onInput=${(e) => setText(e.currentTarget.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
    <div class="ib-cbar">
      <${Button} size="sm" icon="sparkles" loading=${busy === 'ai'} disabled=${!!busy} onClick=${suggest}>اقترح ردًا</${Button}>
      <span class="tiny faint ib-hint">${hasPending ? 'إرسال ردك يلغي الرد المقترح المعلق' : 'Ctrl + Enter للإرسال'}</span>
      <${Button} size="sm" variant="primary" icon="send" loading=${busy === 'send'} disabled=${!!busy || !text.trim()} onClick=${send}>إرسال</${Button}>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- thread

function Head({ conv, onBack, onContact, onStatus, busy }) {
  const c = conv.contact;
  return html`<header class="ib-thead">
    <button type="button" class="icon-btn ib-back" aria-label="العودة إلى المحادثات" onClick=${onBack}><${Icon} name="arrowRight" size="19" /></button>
    <${ChannelMark} ch=${conv.channel} />
    <div class="grow">
      <div class="row gap-6"><b class="ellipsis">${contactName(c)}</b>
        ${c?.handle && c.handle !== contactName(c) && html`<span class="tiny faint ltr ellipsis">${c.handle}</span>`}</div>
      <div class="row wrap gap-6 mt-4">
        <${StatusBadge} map=${F.CONV_STATUS} value=${conv.status} />
        ${conv.category && html`<${StatusBadge} map=${F.CATEGORY} value=${conv.category} />`}
        <span class="tiny faint">${conv.kind === 'whatsapp' ? KIND.whatsapp : `${KIND[conv.kind] || conv.kind} على ${conv.channel_label}`}</span>
      </div>
    </div>
    <div class="ib-tactions">
      ${can('inbox') && actionsFor(conv.status).map((k) => { const a = STATUS_ACTIONS[k]; return html`<${Button} key=${k} size="sm"
        variant=${k === 'escalate' ? '' : 'ghost'} icon=${a.icon} title=${a.label} loading=${busy === k} disabled=${!!busy}
        onClick=${() => onStatus(k)}><span class="ib-btxt">${a.label}</span></${Button}>`; })}
      <button type="button" class="icon-btn ib-info" aria-label="بيانات العميل" title="بيانات العميل" onClick=${onContact}><${Icon} name="user" size="18" /></button>
    </div>
  </header>`;
}

export function ThreadSkeleton() {
  return html`<div class="ib-thread-skel"><${Skeleton} h=${44} /><div class="col gap-16 mt-24">
    <${Skeleton} w="62%" h=${54} /><div class="ib-skel-out"><${Skeleton} w="55%" h=${72} /></div><${Skeleton} w="48%" h=${40} /></div></div>`;
}

/** conv = GET /inbox/{id}; setConv patches the loaded thread; onChanged reloads list + thread. */
export function Thread({ conv, setConv, approvals, meId, onBack, onContact, onChanged }) {
  const [busy, setBusy] = useState('');
  const setStatus = async (key) => {
    const a = STATUS_ACTIONS[key];
    setBusy(key);
    try {
      const next = await api.patch(`/inbox/${conv.id}`, { status: a.to });
      setConv((t) => t && ({ ...t, status: next.status }));
      toast(a.ok);
      onChanged?.();
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const hasPending = (conv.messages || []).some((m) => m.status === 'pending');
  return html`<div class="ib-thread-in">
    <${Head} conv=${conv} onBack=${onBack} onContact=${onContact} onStatus=${setStatus} busy=${busy} />
    <${Messages} conv=${conv} approvals=${approvals} meId=${meId} onDecided=${onChanged} />
    <${Composer} key=${conv.id} conv=${conv} hasPending=${hasPending} onSent=${onChanged} />
  </div>`;
}
