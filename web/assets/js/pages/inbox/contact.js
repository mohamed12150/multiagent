// The contact card beside a conversation: identity, stage, lead score, notes and WhatsApp consent.
import { html, cls, useState, useEffect } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { can } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Badge, Button, Meter, Toggle, Field, Empty, ChannelMark, KeyVal } from '../../ui/core.js';
import { toast, confirm } from '../../ui/overlays.js';
import { STAGE, contactName, consentSource } from './vocab.js';

const HOT_SCORE = 70;

function Consent({ contact, busy, onToggle }) {
  const on = !!contact.opted_in;
  return html`<section class=${cls('ib-consent', on ? 'on' : 'off')}>
    <div class="row between">
      <span class="row gap-6 strong small"><${Icon} name="lock" size="15" />موافقة الرسائل التسويقية</span>
      <${Toggle} checked=${on} label="موافقة العميل على الرسائل التسويقية" disabled=${!can('manager') || busy} onChange=${onToggle} />
    </div>
    ${on ? html`<p class="small mt-8">العميل موافق${contact.opted_in_at ? html` منذ <span class="num">${F.dateTime(contact.opted_in_at)}</span>` : ''}.</p>
        ${contact.opt_source && html`<p class="tiny faint mt-4">المصدر: ${consentSource(contact.opt_source)}</p>`}`
      : html`<p class="small muted mt-8">غير مشترك، فلا تصله أي رسالة جماعية.</p>
        ${contact.opt_source && html`<p class="tiny faint mt-4">${consentSource(contact.opt_source)}</p>`}`}
    <p class="tiny faint mt-8">نرسل فقط لمن وافق صراحة، ويستطيع العميل الإيقاف في أي وقت بإرسال «إيقاف».</p>
  </section>`;
}

export function ContactPanel({ contact, onSaved }) {
  const [name, setName] = useState(contact?.name || '');
  const [notes, setNotes] = useState(contact?.notes || '');
  const [busy, setBusy] = useState('');
  useEffect(() => { setName(contact?.name || ''); setNotes(contact?.notes || ''); }, [contact?.id]);
  if (!contact) {
    return html`<${Empty} icon="user" title="لا توجد بطاقة للعميل" text="لم يُربط هذا الحوار بجهة اتصال بعد. تُنشأ البطاقة تلقائيًا مع أول رسالة واردة." />`;
  }
  const editable = can('editor');
  const save = async (patch, key, okMsg) => {
    setBusy(key);
    try {
      const c = await api.patch(`/contacts/${contact.id}`, patch);
      onSaved?.(c);
      if (okMsg) toast(okMsg);
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const saveName = () => { const v = name.trim(); if (v && v !== contact.name) save({ name: v }, 'name', 'حُفظ اسم العميل'); };
  const toggleConsent = async (on) => {
    setBusy('consent');
    try {
      if (on) {
        const src = await confirm({ title: 'تسجيل موافقة العميل', ok: 'سجّل الموافقة', input: true,
          text: 'فعّل الرسائل التسويقية فقط إذا وافق العميل صراحة. اكتب مصدر الموافقة ليُحفظ مع وقتها كدليل عند أي مراجعة.',
          placeholder: 'مثل: نموذج الموقع، طلب موثق في المتجر' });
        if (src === false) return;
        if (!String(src).trim()) { toast('اكتب مصدر الموافقة أولًا، فهو دليلك عند أي مراجعة', 'warn', 'لم تُسجّل الموافقة'); return; }
        await save({ opted_in: true, opt_source: String(src).trim() }, 'consent', 'سُجّلت موافقة العميل على الرسائل التسويقية');
      } else {
        const yes = await confirm({ title: 'إيقاف الرسائل التسويقية', ok: 'أوقف الاشتراك', danger: true,
          text: 'لن تصل هذا العميل أي رسالة جماعية بعد الآن، وتبقى محادثاته المباشرة كما هي.' });
        if (!yes) return;
        await save({ opted_in: false }, 'consent', 'أُوقفت الرسائل التسويقية لهذا العميل');
      }
    } finally { setBusy(''); }
  };
  const score = contact.lead_score || 0;
  return html`<div class="ib-card">
    <div class="ib-chead">
      <span class="ib-avatar" aria-hidden="true">${contactName(contact).trim().charAt(0) || '؟'}</span>
      <div class="grow">
        ${editable ? html`<input class="ib-name" value=${name} aria-label="اسم العميل" placeholder="أضف اسم العميل"
            onInput=${(e) => setName(e.currentTarget.value)} onBlur=${saveName}
            onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />`
          : html`<b class="ellipsis ib-name-ro">${contactName(contact)}</b>`}
        <div class="row gap-6 mt-4"><${ChannelMark} ch=${contact.channel} size="sm" /><span class="tiny faint">${F.CHANNEL_LABEL[contact.channel] || contact.channel}</span></div>
      </div>
    </div>
    <div class="mt-16"><${KeyVal} items=${[
      contact.handle && ['المعرّف', html`<span class="ltr">${contact.handle}</span>`],
      contact.phone && ['الجوال', html`<span class="ltr num">${contact.phone}</span>`],
      contact.email && ['البريد', html`<span class="ltr">${contact.email}</span>`],
      ['آخر ظهور', contact.last_seen_at ? html`<span title=${F.dateTime(contact.last_seen_at)}>${F.ago(contact.last_seen_at)}</span>` : 'غير معروف'],
    ]} /></div>
    <${Field} label="مرحلة العميل" class="mt-16">
      <select class="select" value=${contact.stage} disabled=${!editable || busy === 'stage'} aria-label="مرحلة العميل"
        onChange=${(e) => save({ stage: e.currentTarget.value }, 'stage', 'حُدّثت مرحلة العميل')}>
        ${Object.entries(STAGE).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
      </select>
    </${Field}>
    <div class="mt-16">
      <div class="row between small"><span class="muted">درجة الاهتمام</span><b class="num">${F.num(score)}/100</b></div>
      <div class="mt-4"><${Meter} value=${score} max=${100} tone=${score >= HOT_SCORE ? 'ok' : ''} /></div>
      <p class="tiny faint mt-4">يرفعها صانع المحتوى كلما ظهرت نية شراء في المحادثة.</p>
    </div>
    ${contact.tags?.length > 0 && html`<div class="row wrap gap-6 mt-16">${contact.tags.map((t) => html`<${Badge} key=${t} tone="outline">${t}</${Badge}>`)}</div>`}
    ${contact.channel === 'whatsapp' && html`<${Consent} contact=${contact} busy=${busy === 'consent'} onToggle=${toggleConsent} />`}
    <${Field} label="ملاحظات الفريق" class="mt-16" help=${editable ? 'لا تظهر للعميل، ويقرؤها صانع المحتوى قبل الرد.' : ''}>
      <textarea class="textarea ib-notes" value=${notes} readOnly=${!editable} placeholder="مثل: يفضل التواصل مساءً، طلب عرض سعر للشركات"
        onInput=${(e) => setNotes(e.currentTarget.value)} />
    </${Field}>
    ${editable && notes !== (contact.notes || '') && html`<div class="row gap-6 mt-8">
      <${Button} size="sm" variant="primary" icon="check" loading=${busy === 'notes'} onClick=${() => save({ notes }, 'notes', 'حُفظت الملاحظات')}>احفظ الملاحظات</${Button}>
      <${Button} size="sm" variant="ghost" onClick=${() => setNotes(contact.notes || '')}>تراجع</${Button}></div>`}
  </div>`;
}
