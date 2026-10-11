// التفاعل مع العملاء: one inbox for the five channels, answered by صانع المحتوى with the owner in the loop.
// Desktop: list · thread · contact. Phones: the list, then the thread (?c=<id>) with a back button.
import { html, cls, useState, useEffect, useRef, useCallback } from '../lib/h.js';
import { useApi } from '../lib/api.js';
import { useLive } from '../lib/live.js';
import { navigate, setQuery } from '../lib/router.js';
import { session, useStore } from '../lib/store.js';
import * as F from '../lib/format.js';
import { Button, Empty, ErrorBox, Skeleton, Seg, ChannelMark, StatusBadge, useDebounced } from '../ui/core.js';
import { Drawer } from '../ui/overlays.js';
import { STATUS_TABS, SENTIMENT, contactName, authorLabel } from './inbox/vocab.js';
import { Thread, ThreadSkeleton } from './inbox/thread.js';
import { ContactPanel } from './inbox/contact.js';

const RELOAD_MS = 700;
const PHONE = '(max-width: 980px)';
const REPLY_KINDS = ['content.reply', 'content.send_reply'];


// ---------------------------------------------------------------- list

function Row({ c, on, showStatus, meId, onSelect }) {
  const who = c.contact;
  const last = c.last;
  const lead = !last || last.direction !== 'out' ? '' : last.status === 'pending' ? 'رد مقترح: ' : `${authorLabel(last.author, who, meId)}: `;
  const senti = SENTIMENT[c.sentiment];
  const open = c.status !== 'closed';
  return html`<button type="button" class=${cls('ib-row', on && 'on', open && c.priority <= 2 && 'hot', open && c.priority === 1 && 'p1',
    !open && 'closed', c.unread > 0 && 'unread')} aria-current=${on ? 'true' : undefined} onClick=${() => onSelect(c.id)}>
    <${ChannelMark} ch=${c.channel} size="sm" />
    <span class="ib-rmain">
      <span class="ib-rtop"><b class="ellipsis">${contactName(who)}</b><span class="tiny faint ib-ago">${F.ago(c.last_message_at)}</span></span>
      ${who?.handle && who.handle !== contactName(who) && html`<span class="tiny faint ltr ellipsis ib-rhandle">${who.handle}</span>`}
      <span class="small muted clamp-2 ib-prev">${last ? `${lead}${last.text}` : 'لا رسائل بعد'}</span>
      <span class="ib-rtags">
        ${showStatus && c.status !== 'open' && html`<${StatusBadge} map=${F.CONV_STATUS} value=${c.status} />`}
        ${c.category && html`<${StatusBadge} map=${F.CATEGORY} value=${c.category} />`}
        ${senti && html`<span class=${cls('ib-senti', senti[1])}>${senti[0]}</span>`}
        ${c.unread > 0 && html`<span class="count ib-unread" aria-label=${`${c.unread} غير مقروءة`}>${c.unread}</span>`}
      </span>
    </span>
  </button>`;
}

function Filters({ status, channel, category, counts }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const options = STATUS_TABS.map((t) => {
    const n = t.value === 'all' ? total : counts[t.value] || 0;
    return { value: t.value, label: html`${t.label}${n ? html`<span class=${cls('ib-n', t.value === 'escalated' && 'hot')}>${F.num(n)}</span>` : ''}` };
  });
  return html`<div class="ib-filters">
    <div class="ib-scroll"><${Seg} size="sm" label="حالة المحادثة" value=${status} options=${options}
      onChange=${(v) => setQuery({ status: v === 'all' ? null : v })} /></div>
    <div class="ib-scroll ib-chips">
      <button type="button" class=${cls('chip', !channel && 'on')} onClick=${() => setQuery({ channel: null })}>كل القنوات</button>
      ${F.CHANNELS.map((ch) => html`<button type="button" key=${ch} class=${cls('chip', channel === ch && 'on')} title=${F.CHANNEL_LABEL[ch]}
        onClick=${() => setQuery({ channel: channel === ch ? null : ch })}><${ChannelMark} ch=${ch} size="sm" />${F.CHANNEL_LABEL[ch]}</button>`)}
    </div>
    <select class="select ib-cat" value=${category} aria-label="تصنيف المحادثة" onChange=${(e) => setQuery({ category: e.currentTarget.value || null })}>
      <option value="">كل التصنيفات</option>
      ${Object.entries(F.CATEGORY).map(([k, v]) => html`<option value=${k}>${v[0]}</option>`)}
    </select>
  </div>`;
}

function ListPane({ list, status, channel, category, selected, meId, onSelect }) {
  const filtered = status !== 'all' || channel || category;
  const rows = list.data;
  let body;
  if (list.error && !rows) body = html`<div class="ib-pad"><${ErrorBox} error=${list.error} retry=${list.reload} /></div>`;
  else if (!rows) body = html`<div class="ib-pad col gap-16">${[0, 1, 2, 3, 4].map((i) => html`<div class="row top" key=${i}><${Skeleton} w="26px" h=${26} /><div class="grow"><${Skeleton} lines=${2} h=${13} /></div></div>`)}</div>`;
  else if (!rows.length) {
    body = filtered
      ? html`<${Empty} icon="filter" title="لا محادثات بهذه التصفية" text="جرّب حالة أو قناة أخرى، أو اعرض كل المحادثات."
          action=${html`<${Button} size="sm" icon="x" onClick=${() => setQuery({ status: null, channel: null, category: null })}>إزالة التصفية</${Button}>`} />`
      : html`<${Empty} icon="message" title="لا محادثات بعد" text="حين يجلب وكلاء القنوات التعليقات والرسائل تظهر هنا، ويصنّفها صانع المحتوى ويرد عليها. شغّل «اجلب الرسائل» من صفحة أي قناة." />`;
  } else {
    body = html`<div class="ib-rows">${rows.map((c) => html`<${Row} key=${c.id} c=${c} on=${c.id === selected} showStatus=${status === 'all'}
      meId=${meId} onSelect=${onSelect} />`)}</div>`;
  }
  return html`<section class=${cls('ib-pane ib-list', list.loading && rows && 'busy')} aria-label="المحادثات">
    <div class="ib-lhead"><h2>المحادثات</h2><span class="tiny faint">يرد عليها صانع المحتوى، والشكاوى تصلك دائمًا</span></div>
    <${Filters} status=${status} channel=${channel} category=${category} counts=${list.meta?.counts || {}} />
    ${body}
  </section>`;
}

// ---------------------------------------------------------------- page

export default function InboxPage({ query = {} }) {
  const status = STATUS_TABS.some((t) => t.value === query.status) ? query.status : 'all';
  const channel = F.CHANNELS.includes(query.channel) ? query.channel : '';
  const category = F.CATEGORY[query.category] ? query.category : '';
  const selected = query.c || '';
  const qs = new URLSearchParams(Object.entries({ status: status === 'all' ? '' : status, channel, category }).filter(([, v]) => v));
  const list = useApi(`/inbox?${qs}`);
  const thread = useApi(selected ? `/inbox/${selected}` : null);
  const approvals = useApi('/approvals?kind=reply&status=pending');
  const me = useStore(session).user;
  const [contactOpen, setContactOpen] = useState(false);
  const pushed = useRef(false);

  const reloadAll = useDebounced(() => {
    list.reload(true);
    approvals.reload(true);
    if (selected) thread.reload(true);
  }, RELOAD_MS);
  useLive('inbox', reloadAll);
  useLive('approvals', reloadAll);
  useLive('task', (d) => { if (REPLY_KINDS.includes(d.task?.kind) && !['created', 'started'].includes(d.event)) reloadAll(); });

  const conv = thread.data && thread.data.id === selected ? thread.data : null;
  useEffect(() => {
    if (!conv) return;
    list.setData((rows) => rows && rows.map((r) => (r.id === conv.id && r.unread ? { ...r, unread: 0 } : r)));
  }, [conv?.id]);
  useEffect(() => { if (!selected) setContactOpen(false); }, [selected]);

  const select = (id) => {
    if (id === selected) return;
    if (matchMedia(PHONE).matches) {
      const url = new URL(location.href);
      url.searchParams.set('c', id);
      pushed.current = true;
      navigate(url.pathname + url.search);
    } else setQuery({ c: id });
  };
  const back = () => {
    if (pushed.current) { pushed.current = false; history.back(); } else setQuery({ c: null });
  };
  const saveContact = (c) => {
    thread.setData((t) => t && ({ ...t, contact: c }));
    list.setData((rows) => rows && rows.map((r) => (r.contact?.id === c.id ? { ...r, contact: c } : r)));
  };

  let threadBody;
  if (!selected) {
    threadBody = html`<${Empty} icon="message" title="اختر محادثة" text="اختر محادثة من القائمة لقراءتها والرد عليها أو اعتماد الرد الذي جهّزه صانع المحتوى." />`;
  } else if (thread.error && !conv) {
    threadBody = html`<div class="ib-pad"><${ErrorBox} error=${thread.error} retry=${thread.reload} />
      <${Button} class="mt-12" size="sm" variant="ghost" icon="arrowRight" onClick=${back}>العودة إلى المحادثات</${Button}></div>`;
  } else if (!conv) {
    threadBody = html`<${ThreadSkeleton} />`;
  } else {
    threadBody = html`<${Thread} key=${conv.id} conv=${conv} setConv=${thread.setData} approvals=${approvals.data} meId=${me?.id}
      onBack=${back} onContact=${() => setContactOpen(true)} onChanged=${reloadAll} />`;
  }

  return html`<div class=${cls('ib', selected && 'has-thread')}>
    <${ListPane} list=${list} status=${status} channel=${channel} category=${category} selected=${selected} meId=${me?.id} onSelect=${select} />
    <section class="ib-pane ib-thread" aria-label="المحادثة">${threadBody}</section>
    <aside class="ib-pane ib-contact" aria-label="بيانات العميل">
      ${conv ? html`<${ContactPanel} key=${conv.contact?.id || conv.id} contact=${conv.contact} onSaved=${saveContact} />`
        : selected ? html`<div class="ib-pad"><${Skeleton} lines=${6} h=${14} /></div>`
          : html`<${Empty} icon="user" title="بطاقة العميل" text="تظهر هنا بيانات العميل ومرحلته وموافقته على الرسائل عند فتح محادثة." />`}
    </aside>
    ${contactOpen && conv && html`<${Drawer} title=${contactName(conv.contact)} onClose=${() => setContactOpen(false)}
      icon=${html`<${ChannelMark} ch=${conv.channel} size="sm" />`}>
      <${ContactPanel} key=${conv.contact?.id || conv.id} contact=${conv.contact} onSaved=${saveContact} /></${Drawer}>`}
  </div>`;
}
