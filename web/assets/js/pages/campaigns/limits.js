// «الليمت والصلاحية» tab: today's usage against every limit, the campaign manager's raise authority, and the change log.
import { html, cls, useState, useEffect } from '../../lib/h.js';
import { api, useApi } from '../../lib/api.js';
import { useLive } from '../../lib/live.js';
import { Link, navigate } from '../../lib/router.js';
import { can } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Badge, Card, Empty, Skeleton, Loader, Meter, Toggle, ChannelMark, useDebounced } from '../../ui/core.js';
import { toast } from '../../ui/overlays.js';
import { Money, NumInput, actorLabel, dayLabel } from './shared.js';

const SAR = 'ر.س';
const KEY_LABEL = {
  organic_posts_per_day: 'منشورات اليوم بدون حملات', campaign_posts_per_day: 'سقف منشورات الحملة اليومي',
  daily_ad_spend_cap: 'سقف الصرف اليومي', monthly_ad_spend_cap: 'سقف الصرف الشهري', replies_per_hour: 'الردود في الساعة',
  whatsapp_broadcast_per_day: 'رسائل واتساب الجماعية يوميًا', ai_daily_cost_cap_usd: 'سقف تكلفة الذكاء الاصطناعي اليومية',
  raise_authority: 'صلاحية الرفع لمدير الحملات',
  'campaign.posts_per_day': 'منشورات الحملة اليومية', 'campaign.daily_budget_cap': 'سقف الحملة اليومي',
};
const RAISE_LABEL = {
  enabled: 'الرفع الذاتي', max_step_pct: 'أقصى خطوة', ceiling_daily_ad_spend: 'سقف الصرف اليومي',
  ceiling_organic_posts: 'سقف المنشورات بدون حملات', ceiling_campaign_posts: 'سقف منشورات الحملة',
};
const MONEY = new Set(['daily_ad_spend_cap', 'monthly_ad_spend_cap', 'ceiling_daily_ad_spend', 'campaign.daily_budget_cap']);
const CHANGE = { applied: ['طُبّق', 'ok', 'check'], pending: ['بانتظار الاعتماد', 'warn', 'clock'], rejected: ['مرفوض', 'bad', 'x'] };

function fmtValue(key, v) {
  if (v === null || v === undefined) return 'غير محدد';
  if (typeof v === 'boolean') return v ? 'مفعّل' : 'موقوف';
  if (MONEY.has(key)) return F.money(v);
  if (key === 'ai_daily_cost_cap_usd') return F.usd(v);
  if (key === 'max_step_pct') return `${F.num(v)}٪`;
  return F.num(v);
}

/** Split a change key: "organic_posts_per_day.tiktok", "daily_ad_spend_cap", "campaign.posts_per_day.<campaign_id>". */
function parseKey(key) {
  const parts = String(key || '').split('.');
  if (parts[0] === 'campaign') return { base: `campaign.${parts[1] || ''}`, campaignId: parts.slice(2).join('.') || null };
  return { base: parts[0], channel: parts[1] || null };
}

/** A change row → a readable title and diff line (old/new are numbers, or whole objects for PUT /limits). */
function describe(c, names) {
  const { base, channel, campaignId } = parseKey(c.key);
  const scope = campaignId ? `: ${names[campaignId] || 'حملة'}` : channel ? `: ${F.CHANNEL_LABEL[channel] || channel}` : '';
  const title = `${KEY_LABEL[base] || base}${scope}`;
  const { old: o, new: n } = c;
  if (o && n && typeof o === 'object' && typeof n === 'object') {
    const raise = base === 'raise_authority';
    const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])].filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
    const diff = keys.map((k) => `${raise ? RAISE_LABEL[k] || k : F.CHANNEL_LABEL[k] || k} من ${fmtValue(raise ? k : base, o[k])} إلى ${fmtValue(raise ? k : base, n[k])}`);
    return { title, campaignId, diff: diff.join('، ') || 'بلا فرق في القيم' };
  }
  return { title, campaignId, diff: `من ${fmtValue(base, o)} إلى ${fmtValue(base, n)}` };
}

function History({ changes, names }) {
  if (!changes.length) {
    return html`<${Empty} icon="history" title="لا تغييرات بعد"
      text="سيظهر هنا كل تعديل على الليمت: من غيّره ومتى ولماذا، وحالة كل طلب رفع من مدير الحملات." />`;
  }
  return html`<ol class="cp-timeline">${changes.map((c) => {
    const d = describe(c, names);
    const s = CHANGE[c.status] || CHANGE.applied;
    return html`<li class="cp-tl" key=${c.id}>
      <span class=${cls('cp-tl-dot', c.status)}><${Icon} name=${s[2]} size="14" /></span>
      <div class="grow">
        <div class="row between gap-6 cp-start"><b class="small">${d.title}</b><${Badge} tone=${s[1]}>${s[0]}</${Badge}></div>
        ${d.campaignId && html`<${Link} href=${`/campaigns/${encodeURIComponent(d.campaignId)}`} class="tiny">افتح الحملة</${Link}>`}
        <p class="small muted mt-4">${d.diff}</p>
        ${c.reason && html`<p class="tiny cp-reason">${c.reason}</p>`}
        <p class="tiny faint mt-4">${actorLabel(c.by)} · ${F.ago(c.created_at)}</p>
      </div></li>`;
  })}</ol>`;
}

const money = (v) => html`<${Money} v=${v} />`;

/** "used من limit" (a slash would flip under RTL bidi and read backwards). */
function Usage({ used = 0, limit = 0, fmt = F.num, fullIsGood = false }) {
  const tone = fullIsGood && limit && used >= limit ? 'ok' : undefined;
  return html`<div class="cp-use"><${Meter} value=${used} max=${limit || 1} tone=${tone} />
    <span class="cp-use-t">${limit ? html`<span class="num">${fmt(used)}</span> من <span class="num">${fmt(limit)}</span>` : 'موقوف'}</span></div>`;
}

function LimitRow({ lead, title, hint, usage, children }) {
  return html`<div class="cp-lrow">
    <div class="cp-lrow-lead">${lead}</div>
    <div class="cp-lrow-main"><b>${title}</b>${hint && html`<span class="tiny faint">${hint}</span>`}${usage}</div>
    <div class="cp-lrow-input">${children}</div>
  </div>`;
}

const mark = (icon) => html`<span class="mark sm agent"><${Icon} name=${icon} size="14" /></span>`;

function RaisePanel({ draft, setRaise, editable, perm }) {
  const r = draft.raise_authority;
  const cap = draft.daily_ad_spend_cap;
  const alone = Math.min(cap * (1 + r.max_step_pct / 100), r.ceiling_daily_ad_spend);
  const permValue = perm?.permissions?.raise_limits;
  const example = !r.enabled ? 'الرفع الذاتي موقوف الآن، فكل طلب رفع من مدير الحملات يصل إلى مكتب الاعتماد.'
    : !cap ? 'سقف الصرف اليومي الآن صفر، ورفعه من الصفر يحتاج قرارك دائمًا.'
    : cap >= r.ceiling_daily_ad_spend ? `سقف الصرف اليومي (${F.money(cap)}) بلغ حد الصلاحية، فأي رفع إضافي يحتاج اعتمادك.`
      : `مثال: سقف الصرف اليومي الآن ${F.money(cap)}، فيستطيع رفعه وحده حتى ${F.money(alone)} في المرة الواحدة، ولن يتجاوز ${F.money(r.ceiling_daily_ad_spend)} مهما تكررت الزيادات.`;
  return html`<${Card} title="صلاحية مدير الحملات في الرفع" icon="crown" class="cp-raise"
    actions=${html`<${Toggle} checked=${r.enabled} disabled=${!editable} label="السماح بالرفع الذاتي" onChange=${(v) => setRaise('enabled', v)} />`}>
    <p class="small muted cp-explain">يرفع مدير الحملات الليمت وحده فقط عندما تكون صلاحيته «رفع الليمت» على «تلقائي» والطلب داخل الحدود أدناه،
      ويشمل ذلك ليمت كل حملة: منشوراتها اليومية وسقفها اليومي. أي طلب خارج هذه الحدود، أو عندما تكون الصلاحية «باعتمادك»، يصل إلى مكتب الاعتماد لتقرر فيه،
      وإذا كانت «موقوف» يُرفض الطلب.</p>
    <ul class="cp-rules small">
      <li>الخفض مسموح له دائمًا، لأنه يقلل الصرف ولا يزيده.</li>
      <li>رفع أي ليمت من الصفر يحتاج قرارك دائمًا، مهما كانت الصلاحية.</li>
      <li>تعديل هذه الحدود والليمت كله للمالك فقط.</li>
    </ul>
    ${perm && html`<div class="cp-perm"><span class="small">صلاحية «رفع الليمت» الآن</span>
      <${Badge} tone=${permValue === 'auto' ? 'ok' : permValue === 'off' ? 'bad' : 'warn'}>${F.PERM_VALUE[permValue] || 'حسب مستوى الاستقلالية'}</${Badge}>
      ${can('autonomy') && html`<${Button} size="xs" variant="ghost" iconEnd="arrowLeft" onClick=${() => navigate('/settings/agents?agent=campaigns')}>غيّرها</${Button}>`}</div>`}
    <div class=${cls('cp-raise-fields', !r.enabled && 'dim')}>
      <${LimitRow} lead=${mark('trend')} title="أقصى زيادة في المرة الواحدة" hint="نسبة من القيمة الحالية لكل طلب رفع">
        <${NumInput} value=${r.max_step_pct} min=${0} max=${200} suffix="٪" label="أقصى خطوة" disabled=${!editable} onChange=${(v) => setRaise('max_step_pct', v)} /></${LimitRow}>
      <${LimitRow} lead=${mark('coins')} title="حد سقف الصرف اليومي" hint="ولا يتجاوز سقف أي حملة السقف اليومي العام، ويُحسب حد الشهري 31 ضعفًا منه">
        <${NumInput} value=${r.ceiling_daily_ad_spend} min=${0} step=${10} int suffix=${SAR} label="حد سقف الصرف اليومي" disabled=${!editable} onChange=${(v) => setRaise('ceiling_daily_ad_spend', v)} /></${LimitRow}>
      <${LimitRow} lead=${mark('send')} title="حد المنشورات بدون حملات" hint="لكل قناة يوميًا">
        <${NumInput} value=${r.ceiling_organic_posts} min=${0} max=${50} suffix="يوميًا" label="حد المنشورات بدون حملات" disabled=${!editable} onChange=${(v) => setRaise('ceiling_organic_posts', v)} /></${LimitRow}>
      <${LimitRow} lead=${mark('megaphone')} title="حد منشورات الحملة اليومية" hint="لكل حملة، ولا يتجاوز سقف منشورات الحملة العام">
        <${NumInput} value=${r.ceiling_campaign_posts} min=${0} max=${100} suffix="يوميًا" label="حد منشورات الحملة" disabled=${!editable} onChange=${(v) => setRaise('ceiling_campaign_posts', v)} /></${LimitRow}>
    </div>
    <div class="notice mt-16"><${Icon} name="info" size="17" /><div class="grow small">${example}</div></div>
  </${Card}>`;
}

function LimitsForm({ snap, aiToday, perm, onSaved }) {
  const base = snap.limits;
  const baseKey = JSON.stringify(base);
  const [draft, setDraft] = useState(base);
  const [origin, setOrigin] = useState(baseKey);
  const [busy, setBusy] = useState(false);
  const editable = can('autonomy');
  const dirty = JSON.stringify(draft) !== origin;
  useEffect(() => { if (!dirty) { setDraft(base); setOrigin(baseKey); } }, [baseKey]);
  const stale = dirty && origin !== baseKey;

  const set = (key) => (v) => setDraft((d) => ({ ...d, [key]: v }));
  const setOrganic = (ch) => (v) => setDraft((d) => ({ ...d, organic_posts_per_day: { ...d.organic_posts_per_day, [ch]: v } }));
  const setRaise = (key, v) => setDraft((d) => ({ ...d, raise_authority: { ...d.raise_authority, [key]: v } }));
  const discard = () => { setDraft(base); setOrigin(baseKey); };
  const save = async () => {
    setBusy(true);
    try {
      const out = await api.put('/limits', draft);
      setDraft(out.limits);
      setOrigin(JSON.stringify(out.limits));
      toast('حُفظ الليمت ويُطبَّق فورًا على كل الوكلاء');
      onSaved();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  const names = Object.fromEntries((snap.campaigns || []).map((c) => [c.id, c.name]));
  const num = (key, opts) => html`<${NumInput} value=${draft[key]} disabled=${!editable} label=${KEY_LABEL[key]} onChange=${set(key)} ...${opts} />`;
  const monthlyLow = draft.monthly_ad_spend_cap < draft.daily_ad_spend_cap;
  return html`
    ${!editable && html`<div class="notice cp-gap"><${Icon} name="lock" size="17" /><div class="grow">تعديل الليمت وصلاحية الرفع للمالك فقط. تعرض لك هذه الصفحة الاستخدام الحالي وسجل التغييرات.</div></div>`}
    <div class="cp-limits">
      <div class="cp-limits-col">
        <${Card} title="النشر اليومي بدون حملات" icon="send" actions=${html`<span class="tiny faint">استخدام ${dayLabel(snap.day) || 'اليوم'}</span>`}>
          <p class="small muted">كم منشورًا ينشره وكيل كل قناة يوميًا خارج الحملات. الصفر يوقف النشر الحر على القناة.</p>
          ${F.CHANNELS.map((ch) => { const o = snap.organic?.[ch] || {}; return html`<${LimitRow} key=${ch} lead=${html`<${ChannelMark} ch=${ch} size="sm" />`}
            title=${F.CHANNEL_LABEL[ch]} usage=${html`<${Usage} used=${o.used} limit=${draft.organic_posts_per_day?.[ch]} fullIsGood />`}>
            <${NumInput} value=${draft.organic_posts_per_day?.[ch] ?? 0} min=${0} max=${50} suffix="يوميًا" label=${`منشورات ${F.CHANNEL_LABEL[ch]} اليومية`}
              disabled=${!editable} onChange=${setOrganic(ch)} /></${LimitRow}>`; })}
        </${Card}>
        <${Card} title="الحملات والإعلانات" icon="megaphone">
          <${LimitRow} lead=${mark('megaphone')} title="سقف منشورات الحملة اليومي" hint="لكل حملة، ويُطبَّق الأقل بينه وبين منشورات الحملة نفسها"
            usage=${snap.campaigns?.length > 0 && html`<div class="cp-camp-use">${snap.campaigns.map((c) => html`<div key=${c.id}>
              <span class="tiny ellipsis">${c.name}</span><${Usage} used=${c.used} limit=${c.limit} fullIsGood /></div>`)}</div>`}>
            ${num('campaign_posts_per_day', { min: 0, max: 100, suffix: 'يوميًا' })}</${LimitRow}>
          <${LimitRow} lead=${mark('coins')} title="سقف الصرف اليومي" hint="مجموع ترويج كل الحملات في اليوم"
            usage=${html`<${Usage} used=${snap.spend_today} limit=${draft.daily_ad_spend_cap} fmt=${money} />`}>
            ${num('daily_ad_spend_cap', { min: 0, step: 10, int: true, suffix: SAR })}</${LimitRow}>
          <${LimitRow} lead=${mark('wallet')} title="سقف الصرف الشهري" hint=${monthlyLow ? 'أقل من السقف اليومي، راجع القيمتين' : 'من أول الشهر حتى اليوم'}
            usage=${html`<${Usage} used=${snap.spend_month} limit=${draft.monthly_ad_spend_cap} fmt=${money} />`}>
            ${num('monthly_ad_spend_cap', { min: 0, step: 100, int: true, suffix: SAR })}</${LimitRow}>
        </${Card}>
        <${Card} title="التفاعل والتكلفة" icon="activity">
          <${LimitRow} lead=${mark('message')} title="الردود في الساعة" hint="حد الردود الآلية على العملاء، يُطبَّق لحظة الإرسال">
            ${num('replies_per_hour', { min: 0, max: 2000, suffix: 'بالساعة' })}</${LimitRow}>
          <${LimitRow} lead=${html`<${ChannelMark} ch="whatsapp" size="sm" />`} title="رسائل واتساب الجماعية يوميًا" hint="للعملاء الموافقين على الاستلام فقط">
            ${num('whatsapp_broadcast_per_day', { min: 0, max: 100000, suffix: 'رسالة' })}</${LimitRow}>
          <${LimitRow} lead=${mark('cpu')} title="سقف تكلفة الذكاء الاصطناعي اليومية" hint="بالدولار، لكل عقول الشبكة معًا"
            usage=${aiToday !== undefined && aiToday !== null && html`<${Usage} used=${aiToday} limit=${draft.ai_daily_cost_cap_usd} fmt=${F.usd} />`}>
            ${num('ai_daily_cost_cap_usd', { min: 0, step: 0.5, int: false, suffix: 'USD' })}</${LimitRow}>
        </${Card}>
      </div>
      <div class="cp-limits-col">
        <${RaisePanel} draft=${draft} setRaise=${setRaise} editable=${editable} perm=${perm} />
        <${Card} title="سجل التغييرات" icon="history"><${History} changes=${snap.changes || []} names=${names} /></${Card}>
      </div>
    </div>
    ${editable && dirty && html`<div class="cp-savebar" role="region" aria-label="حفظ الليمت">
      <${Icon} name=${stale ? 'alert' : 'edit'} size="18" />
      <div class="grow small">${stale ? 'تغيّر الليمت من جهة أخرى أثناء تعديلك. الحفظ سيعتمد قيمك أنت.' : 'لديك تعديلات لم تُحفظ بعد.'}</div>
      <${Button} variant="ghost" size="sm" onClick=${discard} disabled=${busy}>تراجع</${Button}>
      <${Button} variant="primary" size="sm" icon="check" loading=${busy} onClick=${save}>احفظ الليمت</${Button}>
    </div>`}`;
}

function LimitsSkeleton() {
  return html`<div class="cp-limits">${[0, 1].map((i) => html`<div class="cp-limits-col" key=${i}>
    <div class="card pad"><${Skeleton} lines=${6} h=${22} /></div><div class="card pad"><${Skeleton} lines=${4} h=${22} /></div></div>`)}</div>`;
}

export function LimitsTab() {
  const st = useApi('/limits');
  const usage = useApi('/usage?days=1');
  const perm = useApi('/agents/campaigns');
  const reload = useDebounced(() => { st.reload(true); usage.reload(true); }, 900);
  useLive('task', (d) => {
    const k = d.task?.kind || '';
    if ((d.event === 'done' || d.event === 'failed') && /^(campaigns|content|coordinator|channel)\./.test(k)) reload();
  });
  useLive('approvals', reload);
  return html`<${Loader} state=${st} skeleton=${html`<${LimitsSkeleton} />`}>${(snap) => html`<${LimitsForm} snap=${snap}
    aiToday=${usage.data?.cost_usd} perm=${perm.data} onSaved=${() => st.reload(true)} />`}</${Loader}>`;
}
