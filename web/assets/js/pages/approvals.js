// مكتب الاعتماد — everything waiting on the owner's decision, one desk: designs, content, replies, campaigns, limits, fixes.
import { html, cls, useState, useEffect } from '../lib/h.js';
import { api, useApi } from '../lib/api.js';
import { useLive } from '../lib/live.js';
import { Link, setQuery } from '../lib/router.js';
import { can, capLabel } from '../lib/store.js';
import { ago, money, formatLabel, APPROVAL_KIND, CHANNEL_LABEL, POST_STATUS } from '../lib/format.js';
import { Icon, Button, Badge, StatusBadge, AgentMark, ChannelMark, Empty, Skeleton, Loader, Seg, SimTag } from '../ui/core.js';
import { confirm, toast } from '../ui/overlays.js';
import { PlanBody } from './network/steering.js';

const KINDS = ['plan', 'post', 'asset', 'reply', 'campaign', 'limit', 'broadcast', 'fix'];
// Approving these applies limit or system changes, so they follow the capability that owns them (server: DECIDE_CAP).
const DECIDE_CAP = { limit: 'autonomy', plan: 'autonomy', fix: 'agents' };
const canDecide = (kind) => can('approve') && can(DECIDE_CAP[kind] || 'approve');

function PostPreview({ id }) {
  const [p, setP] = useState(null);
  useEffect(() => { api.get(`/posts/${id}`).then(setP).catch(() => setP(false)); }, [id]);
  if (p === null) return html`<${Skeleton} lines=${3} />`;
  if (p === false) return html`<p class="muted small">تعذر تحميل المنشور.</p>`;
  return html`<div class="ap-post">
    ${p.assets.length > 0 && html`<div class="ap-media">${p.assets.slice(0, 4).map((a) => (a.kind === 'video'
      ? html`<video src=${a.url} controls preload="metadata" />` : html`<img src=${a.thumb} alt=${a.title} loading="lazy" />`))}</div>`}
    <div class="col gap-6">
      <div class="row wrap gap-6"><${ChannelMark} ch=${p.channel} size="sm" /><b>${p.title || CHANNEL_LABEL[p.channel]}</b>
        <${Badge} tone="outline">${formatLabel(p.format)}</${Badge}><${StatusBadge} map=${POST_STATUS} value=${p.status} />${p.sandbox && html`<${SimTag} />`}</div>
      <p class="pre">${p.caption}</p>
      ${p.hashtags.length > 0 && html`<p class="small" style="color:var(--accent-text)">${p.hashtags.join(' ')}</p>`}
      ${p.script && html`<details class="ap-script"><summary>السكربت</summary><p class="pre small mt-8">${p.script}</p></details>`}
      ${!p.assets.length && ['instagram', 'tiktok'].includes(p.channel) && html`<div class="notice warn small"><${Icon} name="alert" size="16" />
        <div class="grow">لا يوجد تصميم مرفق، اعتمد ملفات في المكتبة أولًا.</div></div>`}
    </div>
  </div>`;
}

function Body({ a, text, setText }) {
  const p = a.payload || {};
  if (a.kind === 'post') return html`<${PostPreview} id=${a.ref_id} />`;
  if (a.kind === 'plan') return html`<${PlanBody} a=${a} />`;
  if (a.kind === 'asset') {
    return html`<div class="ap-asset">${p.thumb && html`<img src=${p.thumb} alt=${a.title} loading="lazy" />`}
      <div><p>${a.summary}</p><${Link} href="/library?status=pending" class="small">افتح المكتبة</${Link}></div></div>`;
  }
  if (a.kind === 'reply') {
    return html`<div class="col">
      <div class="ap-bubble in"><span class="tiny faint">رسالة العميل</span><p class="pre">${p.incoming}</p></div>
      <div class="ap-bubble out"><span class="tiny faint">رد صانع المحتوى المقترح (يمكنك تعديله)</span>
        <textarea class="textarea" value=${text} onInput=${(e) => setText(e.currentTarget.value)} disabled=${!can('approve')} /></div>
      <${Link} href=${`/inbox?c=${p.conversation_id}`} class="small">افتح المحادثة كاملة</${Link}>
    </div>`;
  }
  if (a.kind === 'limit') {
    return html`<div class="ap-limit"><div class="ap-from num">${p.old}</div><${Icon} name="arrowLeft" size="20" /><div class="ap-to num">${p.new}</div>
      <div class="grow"><p>${a.summary}</p><p class="tiny faint mt-4">${p.within_authority ? 'ضمن السقف الذي منحته، لكن صلاحية هذا الوكيل عندك «باعتمادك».' : 'يتجاوز خطوة الرفع أو السقف الذي منحته للوكلاء.'}</p></div></div>`;
  }
  if (a.kind === 'campaign') {
    return html`<div class="col"><p>${a.summary}</p>
      <div class="row wrap gap-6">${(p.channels || []).map((ch) => html`<${ChannelMark} ch=${ch} size="sm" />`)}
        ${p.budget_total ? html`<${Badge} icon="wallet">ميزانية ${money(p.budget_total)}</${Badge}>` : null}</div>
      <${Link} href="/campaigns?tab=proposals" class="small">التفاصيل الكاملة للمقترح</${Link}></div>`;
  }
  return html`<p class="pre">${a.summary}</p>`;
}

const VERBS = {
  post: ['اعتماد للنشر', 'اطلب تعديل'], asset: ['اعتماد التصميم', 'رفض'], reply: ['اعتماد وإرسال', 'تجاهل الرد'],
  campaign: ['اعتماد الحملة', 'رفض'], limit: ['موافقة على الرفع', 'رفض'], fix: ['نفّذ الإصلاح', 'تجاهل'],
  broadcast: ['اعتماد الإرسال', 'رفض'], spend: ['موافقة', 'رفض'], plan: ['اعتمد الخطة ونفّذ', 'رفض الخطة'],
};

function ApprovalCard({ a, onDone }) {
  const [busy, setBusy] = useState('');
  const [text, setText] = useState(a.summary || '');
  const [leaving, setLeaving] = useState(false);
  const decide = async (approve) => {
    let note = '';
    if (!approve) {
      const isRevise = a.kind === 'post';
      const typed = await confirm({ title: isRevise ? 'ما التعديل المطلوب؟' : 'سبب الرفض (اختياري)', input: true,
        placeholder: isRevise ? 'مثال: اجعل الافتتاحية أقوى واذكر التوصيل المجاني' : '', ok: isRevise ? 'أرسل لصانع المحتوى' : 'رفض',
        danger: !isRevise });
      if (typed === false) return;
      note = typed || '';
    }
    setBusy(approve ? 'yes' : 'no');
    try {
      await api.post(`/approvals/${a.id}/decide`, { approve, note, text: a.kind === 'reply' ? text : undefined });
      setLeaving(true);
      toast(approve ? 'تم الاعتماد' : (a.kind === 'post' && note ? 'أُعيد لصانع المحتوى للتعديل' : 'تم الرفض'));
      setTimeout(() => onDone(a.id), 260);
    } catch (e) { toast.error(e); setBusy(''); }
  };
  const [yes, no] = VERBS[a.kind] || ['اعتماد', 'رفض'];
  const [kindLabel, kindIcon] = APPROVAL_KIND[a.kind] || [a.kind, 'checkCircle'];
  const decided = a.status !== 'pending';
  return html`<article class=${cls('card ap-card', leaving && 'leaving', `k-${a.kind}`)}>
    <header class="ap-head"><span class="mark agent sm"><${Icon} name=${kindIcon} size="15" /></span>
      <div class="grow"><b class="ellipsis" style="display:block">${a.title}</b>
        <span class="tiny faint row gap-6">${kindLabel} · من <${AgentMark} id=${a.agent_id} size="sm" /> ${a.agent_name} · ${ago(a.created_at)}</span></div>
      ${decided && html`<${Badge} tone=${a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'bad' : ''}>${{ approved: 'معتمد', rejected: 'مرفوض', expired: 'منتهٍ' }[a.status] || a.status}</${Badge}>`}
    </header>
    <div class="ap-body"><${Body} a=${a} text=${text} setText=${setText} /></div>
    ${decided ? a.note && html`<p class="small muted ap-note">ملاحظتك: ${a.note}</p>`
      : canDecide(a.kind) ? html`<footer class="ap-foot">
        <${Button} variant="ok" icon="check" loading=${busy === 'yes'} onClick=${() => decide(true)}>${yes}</${Button}>
        <${Button} variant=${a.kind === 'post' ? '' : 'danger'} icon=${a.kind === 'post' ? 'edit' : 'x'} loading=${busy === 'no'} onClick=${() => decide(false)}>${no}</${Button}>
        ${a.kind === 'post' && html`<${Button} variant="ghost" onClick=${async () => {
          if (await confirm({ title: 'رفض نهائي؟', text: 'لن يُنشر هذا المحتوى ولن يُعاد كتابته.', ok: 'رفض', danger: true })) {
            try { await api.post(`/approvals/${a.id}/decide`, { approve: false, note: '' }); setLeaving(true); setTimeout(() => onDone(a.id), 260); } catch (e) { toast.error(e); }
          }
        }}>رفض نهائي</${Button}>`}
      </footer>` : html`<p class="tiny faint ap-note">يعتمده من يملك صلاحية «${capLabel(DECIDE_CAP[a.kind] || 'approve')}».</p>`}
  </article>`;
}

export default function ApprovalsPage({ query }) {
  const kind = query.kind || '';
  const status = query.status || 'pending';
  const path = `/approvals?status=${status}${kind ? `&kind=${kind}` : ''}`;
  const st = useApi(path, [path]);
  useLive('approvals', () => st.reload(true));
  const counts = st.meta?.counts || {};
  const total = Object.values(counts).reduce((x, y) => x + y, 0);
  const options = [{ value: '', label: `الكل${total ? ` ${total}` : ''}` },
    ...KINDS.filter((k) => counts[k] || k === kind).map((k) => ({ value: k, label: `${APPROVAL_KIND[k][0]} ${counts[k] || ''}`.trim() }))];
  const remove = (id) => st.setData((rows) => rows.filter((r) => r.id !== id));
  return html`
    <div class="page-head"><div class="grow"><p>كل ما يحتاج قرارك في مكان واحد. ما تعتمده يكمل طريقه تلقائيًا: التصميم يصبح متاحًا لصانع المحتوى، والمحتوى يُجدول، والرد يُرسل.</p></div>
      <${Seg} size="sm" value=${status} onChange=${(v) => setQuery({ status: v === 'pending' ? null : v })}
        options=${[{ value: 'pending', label: 'بانتظارك' }, { value: 'approved', label: 'المعتمد' }, { value: 'rejected', label: 'المرفوض' }]} /></div>
    ${status === 'pending' && options.length > 1 && html`<div class="row wrap gap-6" style="margin-bottom:16px">${options.map((o) => html`
      <button class=${cls('chip', o.value === kind && 'on')} onClick=${() => setQuery({ kind: o.value || null })}>${o.label}</button>`)}</div>`}
    <${Loader} state=${st} skeleton=${html`<div class="ap-grid">${[1, 2, 3, 4].map(() => html`<div class="card pad"><${Skeleton} lines=${5} h=${16} /></div>`)}</div>`}>
      ${(rows) => (rows.length ? html`<div class="ap-grid">${rows.map((a) => html`<${ApprovalCard} key=${a.id} a=${a} onDone=${remove} />`)}</div>`
        : html`<div class="card"><${Empty} icon="checkCircle" title=${status === 'pending' ? 'لا شيء بانتظارك' : 'لا يوجد سجل بعد'}
          text=${status === 'pending' ? 'الشبكة تعمل ضمن الصلاحيات التي منحتها. ستصلك هنا التصاميم والمحتوى والردود التي تحتاج قرارك.' : 'ستظهر هنا قراراتك السابقة.'} /></div>`)}
    </${Loader}>`;
}
