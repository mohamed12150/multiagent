// One report (/reports/:id): headline and summary, KPIs against the day before, channels, the four section blocks,
// top posts, conversations, deliveries; plus resend, the email preview and the WhatsApp text.
import { html, cls, useState } from '../../lib/h.js';
import { api, useApi } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { can } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Badge, SimTag, Card, Empty, Skeleton, Loader, Stat, Meter, ChannelMark, AgentMark, KeyVal } from '../../ui/core.js';
import { Modal, toast, confirm } from '../../ui/overlays.js';
import { DELIVERY, DELIVERY_CH, Money, longDay } from './parts.js';

const BLOCKS = [
  ['highlights', 'الإنجازات', 'checkCircle', 'ok'],
  ['issues', 'تحتاج انتباهك', 'alert', 'warn'],
  ['recommendations', 'التوصيات', 'lightbulb', 'accent'],
  ['tomorrow', 'خطة الغد', 'calendar', 'neutral'],
];

const round = (v, dp = 0) => Math.round((+v || 0) * 10 ** dp) / 10 ** dp;

function delta(t, p, key, dp = 0) {
  if (!p || p[key] === undefined || p[key] === null) return undefined;
  return round((+t[key] || 0) - (+p[key] || 0), dp);
}

function Kpis({ data }) {
  const t = data.totals || {};
  const p = data.previous;
  const c = data.conversations || {};
  const pct = (v) => `${F.dec(v || 0, 2)}٪`;
  const vsYesterday = (label, icon, key, fmt, dp = 0) => {
    const d = delta(t, p, key, dp);
    const hint = d === undefined ? '' : d === 0 ? 'مثل أمس' : `أمس ${fmt(p[key])}`;
    return html`<${Stat} label=${label} icon=${icon} value=${fmt(t[key])} delta=${d === 0 ? undefined : d} hint=${hint} />`;
  };
  return html`<div class="card pad rp-kpis">
    ${vsYesterday('المنشورات', 'send', 'posts', F.num)}
    ${vsYesterday('الوصول', 'eye', 'reach', F.compact)}
    ${vsYesterday('التفاعل', 'heart', 'engagement', F.compact)}
    ${vsYesterday('معدل التفاعل', 'activity', 'engagement_rate', pct, 2)}
    <${Stat} label="الردود على العملاء" icon="message" value=${F.num(c.replies)} hint=${`رسائل واردة: ${F.num(c.inbound || 0)}`} />
    <${Stat} label="فرص بيع" icon="target" value=${F.num(c.leads)} hint=${c.complaints ? `شكاوى: ${F.num(c.complaints)}` : 'بلا شكاوى'} />
  </div>`;
}

function ChannelTable({ data, notes }) {
  const chans = data.channels || {};
  const fd = data.followers_delta || {};
  const noteBy = Object.fromEntries((notes || []).filter((n) => n && n.channel).map((n) => [n.channel, n.note]));
  const rows = F.CHANNELS.filter((ch) => chans[ch]).map((ch) => ({ ch, ...chans[ch] }));
  if (!rows.length) return null;
  return html`<${Card} title="أداء القنوات" icon="chart">
    <div class="rp-table-wrap"><table class="table rp-table">
      <thead><tr><th>القناة</th><th>منشورات</th><th>الوصول</th><th>التفاعل</th><th>المعدل</th><th>المتابعون</th><th>ملاحظة المنسّق</th></tr></thead>
      <tbody>${rows.map((r) => {
        const quiet = !r.posts && !r.reach && !r.engagement;
        const f = fd[r.ch];
        return html`<tr key=${r.ch} class=${quiet ? 'rp-quiet' : ''}>
          <td class="rp-ch" data-label="القناة"><span class="row gap-6"><${ChannelMark} ch=${r.ch} size="sm" /><b class="small">${F.CHANNEL_LABEL[r.ch]}</b></span></td>
          <td class="num" data-label="منشورات">${F.num(r.posts)}</td>
          <td class="num" data-label="الوصول">${F.compact(r.reach)}</td>
          <td class="num" data-label="التفاعل">${F.compact(r.engagement)}</td>
          <td class="num" data-label="المعدل">${F.dec(r.engagement_rate || 0, 2)}٪</td>
          <td class="num" data-label="المتابعون">${F.compact(r.followers)}${typeof f === 'number' && f !== 0
            ? html` <span class=${cls('rp-fd', f > 0 ? 'up' : 'down')}>${f > 0 ? '+' : ''}${F.num(f)}</span>` : ''}</td>
          <td class="rp-note" data-label="ملاحظة المنسّق">${noteBy[r.ch] || html`<span class="faint">لا ملاحظة</span>`}</td>
        </tr>`;
      })}</tbody></table></div>
  </${Card}>`;
}

function Blocks({ sections }) {
  return html`<div class="rp-blocks">${BLOCKS.map(([key, title, icon, tone]) => {
    const items = (sections[key] || []).filter(Boolean).map(String);
    return html`<section class=${cls('rp-block', tone)} key=${key}>
      <div class="rp-block-head"><span class="rp-block-icon"><${Icon} name=${icon} size="16" /></span><h3>${title}</h3>
        <span class="rp-block-n num">${items.length}</span></div>
      ${items.length ? html`<ul>${items.map((x, i) => html`<li key=${i}>${x}</li>`)}</ul>` : html`<p class="small faint mt-8">لا شيء مسجّل في هذا القسم.</p>`}
    </section>`;
  })}</div>`;
}

function TopPosts({ posts }) {
  return html`<${Card} title="أفضل منشورات اليوم" icon="trophy">
    ${posts.length ? html`<ol class="rp-top">${posts.map((p, i) => html`<li key=${p.id || i}>
      <${Link} href=${`/content?post=${encodeURIComponent(p.id)}`} class="rp-top-item">
        <span class=${cls('rp-rank num', i === 0 && 'first')}>${i + 1}</span><${ChannelMark} ch=${p.channel} size="sm" />
        <div class="grow"><p class="small strong clamp-2">${p.title || 'منشور بلا عنوان'}</p>
          <div class="rp-totals"><span><${Icon} name="heart" size="13" />${F.compact(p.engagement)}</span>
            <span><${Icon} name="eye" size="13" />${F.compact(p.reach)}</span><span>${F.dec(p.rate || 0, 2)}٪</span></div></div>
      </${Link}></li>`)}</ol>`
      : html`<${Empty} icon="trophy" title="لا منشورات منشورة في هذا اليوم" text="عندما تُنشر المنشورات وتتجمع أرقامها، يرتّب المنسّق أفضلها هنا." />`}
  </${Card}>`;
}

const CONV = [['inbound', 'رسائل واردة', 'inbox'], ['replies', 'ردود الفريق', 'send'], ['leads', 'فرص بيع', 'target'],
  ['complaints', 'شكاوى', 'alert'], ['waiting', 'بانتظار الرد الآن', 'clock']];

function Conversations({ c }) {
  return html`<${Card} title="المحادثات مع العملاء" icon="message" actions=${html`<${Link} href="/inbox" class="small">افتح صندوق العملاء</${Link}>`}>
    <div class="rp-conv">${CONV.map(([k, label, icon]) => html`<div key=${k}
      class=${cls('rp-conv-item', k === 'complaints' && c[k] > 0 && 'warn', k === 'leads' && c[k] > 0 && 'ok')}>
      <${Icon} name=${icon} size="16" /><b class="num">${F.num(c[k] || 0)}</b><span>${label}</span></div>`)}</div>
  </${Card}>`;
}

function Operations({ data }) {
  const tasks = Object.values(data.tasks || {});
  const done = tasks.reduce((a, s) => a + (s.done || 0), 0);
  const failed = tasks.reduce((a, s) => a + (s.failed || 0), 0);
  const camps = data.campaigns || [];
  return html`<${Card} title="تشغيل اليوم" icon="workflow">
    <${KeyVal} items=${[
      ['صرف الترويج', html`<${Money} v=${data.spend_today} />`],
      ['مجدول للغد', html`<span class="num">${F.num(data.scheduled_tomorrow || 0)}</span>`],
      ['بانتظار اعتمادك', html`<span class="num">${F.num(data.pending_review || 0)}</span>`],
      ['مهام منجزة', html`<span class="num">${F.num(done)}</span>${failed ? html` <span class="rp-failed">ومتعثرة ${F.num(failed)}</span>` : ''}`],
      data.ai_cost_usd !== undefined && ['تكلفة الذكاء الاصطناعي', html`<span class="num">${F.usd(data.ai_cost_usd)}</span>`],
    ]} />
    ${camps.length > 0 && html`<h3 class="small muted mt-16">الحملات النشطة</h3><div class="rp-camps">${camps.map((c, i) => html`<div key=${i}>
      <div class="row between small"><span class="ellipsis">${c.name}</span><span class="rp-amount"><${Money} v=${c.spent} /><span class="faint">من</span>${c.budget ? html`<${Money} v=${c.budget} />` : html`<span class="faint">بلا سقف</span>`}</span></div>
      <${Meter} value=${c.spent} max=${c.budget || 1} /></div>`)}</div>`}
  </${Card}>`;
}

function Deliveries({ list }) {
  return html`<${Card} title="سجل الإرسال" icon="send">
    ${list.length ? html`<div class="rp-dlist">${[...list].reverse().map((d, i) => {
      const [chLabel, icon] = DELIVERY_CH[d.channel] || [d.channel || 'قناة', 'send'];
      const [stLabel, tone] = DELIVERY[d.status] || [d.status, ''];
      return html`<div class="rp-drow" key=${i}>
        <span class=${cls('mark sm', d.channel === 'whatsapp' && 'ch-whatsapp')}><${Icon} name=${icon} size="14" /></span>
        <div class="grow"><div class="row gap-6 wrap"><b class="small">${chLabel}</b><${Badge} tone=${tone}>${stLabel}</${Badge}></div>
          ${d.to && html`<p class="tiny muted ltr ellipsis rp-to">${d.to}</p>`}${d.error && html`<p class="tiny rp-err">${d.error}</p>`}</div>
        <span class="tiny faint">${d.at ? F.dateTime(d.at) : ''}</span></div>`;
    })}</div>` : html`<${Empty} icon="send" title="لم يُرسل هذا التقرير بعد"
      text="الإرسال التلقائي يتبع صلاحية «إرسال التقارير» للمنسّق. يمكنك إرساله الآن من زر «أرسل مجددًا»." />`}
  </${Card}>`;
}

function EmailModal({ id, onClose }) {
  return html`<${Modal} title="معاينة البريد" wide onClose=${onClose}>
    <p class="tiny faint">هكذا يصل التقرير إلى بريدك، معروضًا في إطار معزول لا تعمل فيه أي سكربتات.</p>
    <iframe class="rp-frame mt-8" sandbox="" src=${`/api/reports/${encodeURIComponent(id)}/email`} title="معاينة بريد التقرير" />
  </${Modal}>`;
}

function WhatsAppModal({ text, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text || '');
      setCopied(true);
      toast('نُسخ نص التقرير، الصقه في واتساب');
    } catch { toast('تعذّر النسخ التلقائي، حدّد النص وانسخه يدويًا', 'warn'); }
  };
  return html`<${Modal} title="نص التقرير على واتساب" onClose=${onClose} footer=${html`
    <${Button} variant="primary" icon=${copied ? 'check' : 'copy'} onClick=${copy}>${copied ? 'نُسخ النص' : 'انسخ النص'}</${Button}>
    <${Button} variant="ghost" onClick=${onClose}>إغلاق</${Button}>`}>
    <p class="tiny faint">هذا النص كما يصلك على واتساب. الكلمات بين النجوم تظهر عريضة في التطبيق.</p>
    <pre class="rp-wa mt-8">${text || 'لا يوجد نص لهذا التقرير.'}</pre>
  </${Modal}>`;
}

function resultMessage(fresh) {
  if (!fresh.length) return ['لا توجد قنوات تقارير مفعّلة. اخترها من الإعدادات › الإشعارات.', 'warn'];
  if (fresh.some((d) => d.status === 'failed')) return ['تعذّر الإرسال عبر بعض القنوات، راجع سجل الإرسال.', 'warn'];
  if (fresh.every((d) => d.status === 'skipped')) return [`لم يُرسل: ${fresh[0].error || 'القنوات غير مهيأة'}`, 'warn'];
  if (fresh.some((d) => d.status === 'sandbox')) return ['أُرسل في وضع المحاكاة. أضف مفاتيح واتساب والبريد للإرسال الحقيقي.', 'warn'];
  return ['وصل التقرير إلى القنوات المحددة.', 'ok'];
}

function Hero({ r, onModal, onResent }) {
  const [busy, setBusy] = useState(false);
  const resend = async () => {
    const yes = await confirm({ title: 'إرسال التقرير مجددًا؟', ok: 'أرسل الآن',
      text: 'سيصل التقرير الآن إلى قنوات التقارير المحددة في إعدادات الإشعارات (واتساب والبريد).' });
    if (!yes) return;
    setBusy(true);
    try {
      const before = (r.deliveries || []).length;
      const out = await api.post(`/reports/${encodeURIComponent(r.id)}/send`);
      onResent(out);
      const [msg, tone] = resultMessage((out.deliveries || []).slice(before));
      toast(msg, tone, 'إرسال التقرير');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return html`<section class="card rp-hero">
    <div class="rp-kicker"><${AgentMark} id="coordinator" size="sm" /><span>المنسّق</span><span aria-hidden="true">·</span>
      <span class="ellipsis">${r.title || 'تقرير الإنجاز'}</span>${r.simulated && html`<${SimTag} />`}</div>
    <p class="rp-longdate">${longDay(r.day)}</p>
    <h2 class="rp-headline">${r.headline || r.title || 'تقرير اليوم'}</h2>
    ${r.summary && html`<p class="rp-summary">${r.summary}</p>`}
    <div class="rp-hero-acts">
      <${Button} size="sm" icon="mail" onClick=${() => onModal('email')}>معاينة البريد</${Button}>
      <${Button} size="sm" icon="whatsapp" onClick=${() => onModal('wa')}>نص واتساب</${Button}>
      ${can('reports') && html`<${Button} size="sm" variant="primary" icon="send" loading=${busy} onClick=${resend}>أرسل مجددًا</${Button}>`}
    </div>
  </section>`;
}

function DetailSkeleton() {
  return html`<div class="card pad"><${Skeleton} w="40%" h=${14} /><div class="mt-16"><${Skeleton} lines=${2} h=${26} /></div>
    <div class="mt-16"><${Skeleton} lines=${3} h=${15} /></div></div>
    <div class="card pad rp-kpis mt-16">${[0, 1, 2, 3, 4, 5].map((i) => html`<${Skeleton} key=${i} lines=${2} h=${18} />`)}</div>
    <div class="rp-blocks mt-16">${[0, 1, 2, 3].map((i) => html`<div class="card pad" key=${i}><${Skeleton} lines=${3} h=${16} /></div>`)}</div>`;
}

export function ReportDetail({ id }) {
  const st = useApi(`/reports/${encodeURIComponent(id)}`, [id]);
  const [modal, setModal] = useState('');
  const resent = (out) => st.setData((r) => (r ? { ...r, ...out, whatsapp_text: out?.whatsapp_text ?? r.whatsapp_text } : r));
  return html`<div class="rp-doc">
    <${Link} href="/reports" class="rp-back"><${Icon} name="arrowRight" size="16" />كل التقارير</${Link}>
    <${Loader} state=${st} skeleton=${html`<${DetailSkeleton} />`}>${(r) => {
      const data = r.data || {};
      const sec = r.sections || {};
      return html`
        <${Hero} r=${r} onModal=${setModal} onResent=${resent} />
        <${Kpis} data=${data} />
        <${ChannelTable} data=${data} notes=${sec.channel_notes} />
        <${Blocks} sections=${sec} />
        <div class="rp-pair">
          <${TopPosts} posts=${data.top_posts || []} />
          <div class="rp-stack"><${Conversations} c=${data.conversations || {}} /><${Operations} data=${data} /></div>
        </div>
        <${Deliveries} list=${r.deliveries || []} />
        ${modal === 'email' && html`<${EmailModal} id=${r.id} onClose=${() => setModal('')} />`}
        ${modal === 'wa' && html`<${WhatsAppModal} text=${r.whatsapp_text} onClose=${() => setModal('')} />`}`;
    }}</${Loader}>
  </div>`;
}
