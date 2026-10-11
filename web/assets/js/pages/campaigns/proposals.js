// «المقترحات» tab: every campaign مدير الحملات proposes, laid out as a decision card the manager can approve or reject.
import { html } from '../../lib/h.js';
import { Link } from '../../lib/router.js';
import { can } from '../../lib/store.js';
import * as F from '../../lib/format.js';
import { Icon, Button, Badge, SimTag, Empty, Skeleton, AgentMark, ChannelMark } from '../../ui/core.js';
import { Channels, DecisionActions, KPI, Label, Money, Pills, Sources, dateRange, daysText, durationOf } from './shared.js';

function Figure({ label, value, hint }) {
  return html`<div class="cp-fig"><span>${label}</span><b>${value}</b>${hint && html`<em>${hint}</em>`}</div>`;
}

const hasValue = (v) => v !== undefined && v !== null && v !== '' && v !== 0;

export function Goals({ kpis, results }) {
  const keys = Object.keys(KPI).filter((key) => hasValue(kpis?.[key]));
  if (!keys.length) return null;
  return html`<div class="cp-goals">${keys.map((key) => {
    const actual = results?.[key];
    const measured = hasValue(actual) || actual === 0;
    return html`<div class="cp-goal" key=${key}><${Icon} name=${KPI[key].icon} size="15" /><span class="grow">${KPI[key].label}</span>
      ${measured ? html`<span class="num small">${KPI[key].fmt(actual)}</span><span class="tiny faint">من</span>` : null}
      <b class=${measured ? 'num faint' : 'num'}>${KPI[key].fmt(kpis[key])}</b></div>`;
  })}</div>`;
}

function ProposalCard({ c, onDecided }) {
  const p = c.proposal || {};
  const days = durationOf(c);
  const firsts = (p.first_posts || []).filter((x) => x && x.brief);
  const sources = (p.sources || []).length > 0;
  return html`<article class="card cp-prop">
    <header class="cp-prop-head">
      <${AgentMark} id="campaigns" size="lg" />
      <div class="grow">
        <div class="row gap-6 wrap tiny faint"><span>اقتراح مدير الحملات</span><span aria-hidden="true">·</span>
          <span>${F.ago(c.created_at)}</span>${p.simulated && html`<${SimTag} />`}</div>
        <h3 class="cp-prop-name">${c.name}</h3>
        <div class="row gap-6 wrap mt-8"><${Badge} tone="accent" icon="target">هدفها: ${F.OBJECTIVE[c.objective] || c.objective}</${Badge}>
          <${Channels} list=${c.channels} labels /></div>
      </div>
    </header>
    <div class="cp-prop-body">
      <div class="cp-prop-main">
        ${p.rationale && html`<div class="cp-why"><${Label} icon="lightbulb">لماذا هذه الحملة الآن</${Label}><p>${p.rationale}</p></div>`}
        <div class="cp-pair">
          <div><${Label} icon="users">الجمهور</${Label}><p class="small">${c.audience || 'لم يُحدد'}</p></div>
          <div><${Label} icon="star">العرض</${Label}><p class="small">${c.offer || 'لم يُحدد'}</p></div>
        </div>
        ${p.content_pillars?.length > 0 && html`<div><${Label} icon="layers">محاور المحتوى</${Label}><${Pills} items=${p.content_pillars} /></div>`}
        ${firsts.length > 0 && html`<div><${Label} icon="send">أول منشورات الانطلاق</${Label}>
          <div class="cp-firsts">${firsts.map((x, i) => html`<div class="cp-first" key=${i}>
            ${F.CHANNEL_LABEL[x.channel] ? html`<${ChannelMark} ch=${x.channel} size="sm" />` : html`<span class="mark sm"><${Icon} name="send" size="13" /></span>`}
            <p class="small">${x.brief}</p></div>`)}</div></div>`}
      </div>
      <aside class="cp-prop-side">
        <div class="cp-figs">
          <${Figure} label="الميزانية الكلية" value=${c.budget_total ? html`<${Money} v=${c.budget_total} />` : 'غير محددة'} />
          <${Figure} label="السقف اليومي" value=${c.daily_budget_cap ? html`<${Money} v=${c.daily_budget_cap} />` : 'غير محدد'} />
          <${Figure} label="المدة" value=${days ? daysText(days) : 'مفتوحة'} hint=${dateRange(c.start_date, c.end_date)} />
          <${Figure} label="منشورات يوميًا" value=${F.num(c.posts_per_day)} />
        </div>
        ${Object.keys(KPI).some((key) => hasValue(c.kpis?.[key])) && html`<div><${Label} icon="trend">المؤشرات المستهدفة</${Label}><${Goals} kpis=${c.kpis} /></div>`}
        ${p.expected && html`<div class="cp-note ok"><${Label} icon="checkCircle">النتيجة المتوقعة</${Label}><p>${p.expected}</p></div>`}
        ${p.risks && html`<div class="cp-note warn"><${Label} icon="alert">المخاطر</${Label}><p>${p.risks}</p></div>`}
      </aside>
    </div>
    ${sources && html`<div class="cp-prop-src"><${Label} icon="globe">مصادر اعتمد عليها</${Label}><${Sources} items=${p.sources} /></div>`}
    <footer class="cp-prop-foot"><${DecisionActions} c=${c} onDone=${onDecided} />
      <${Link} href=${`/campaigns/${c.id}`} class="cp-more">التفاصيل الكاملة<${Icon} name="arrowLeft" size="15" /></${Link}></footer>
  </article>`;
}

export function ProposalsSkeleton() {
  return html`<div class="cp-props">${[0, 1].map((i) => html`<div class="card pad" key=${i}><div class="row gap-16 cp-start">
    <${Skeleton} w="44px" h=${44} /><div class="grow"><${Skeleton} lines=${2} h=${18} /></div></div>
    <div class="mt-16"><${Skeleton} lines=${4} h=${16} /></div></div>`)}</div>`;
}

export function ProposalsTab({ rows, proposing, onPropose, onDecided }) {
  return html`
    ${proposing && html`<div class="notice cp-working"><span class="status-dot working" /><div class="grow">
      <b>مدير الحملات يدرس السوق الآن</b>يراجع أداء آخر 14 يومًا وتحليل المنافسين والمواسم القادمة، وستظهر مقترحاته هنا تلقائيًا.</div></div>`}
    ${rows.length ? html`<div class="cp-props">${rows.map((c) => html`<${ProposalCard} key=${c.id} c=${c} onDecided=${onDecided} />`)}</div>`
      : !proposing && html`<div class="card"><${Empty} icon="lightbulb" title="لا توجد مقترحات بانتظارك"
          text="اطلب من مدير الحملات اقتراحًا، وسيدرس أداءك والمنافسين والمواسم السعودية القادمة ثم يعرض عليك خطة كاملة بميزانيتها ومؤشراتها لتعتمدها أو ترفضها."
          action=${can('editor') && html`<${Button} variant="primary" icon="wand" onClick=${onPropose}>اقترح حملة</${Button}>`} /></div>`}`;
}
