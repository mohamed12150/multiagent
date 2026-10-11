// الإعدادات › العلامة: the brief every agent reads before it writes, plans or replies to a customer.
import { html, useMemo } from '../../lib/h.js';
import { api } from '../../lib/api.js';
import { can, session } from '../../lib/store.js';
import { num } from '../../lib/format.js';
import { Icon, Button, Card, Meter, Skeleton, Loader } from '../../ui/core.js';
import { useCachedApi, useForm, check, withSection, SettingsForm, Head, ReadOnly, TextField, ChipsField } from './kit.js';

const DIALECTS = ['سعودي أبيض', 'نجدي', 'حجازي', 'خليجي', 'فصحى مبسطة'];
const MAX_PRODUCTS = 40;
const MAX_TAGS = 20;
const SCORED = ['name', 'tagline', 'industry', 'description', 'audience', 'tone', 'dialect', 'values', 'dos', 'donts',
  'website', 'products', 'base_hashtags'];
const EMPTY_PRODUCT = { name: '', price: '', description: '' };

const filled = (v) => (Array.isArray(v) ? v.length > 0 : String(v ?? '').trim().length > 0);
const normTag = (v) => {
  const t = v.trim().replace(/^#+/, '').replace(/\s+/g, '_');
  return t ? `#${t}` : '';
};

function validate(d) {
  const errors = {};
  if (!d.name.trim()) errors.name = 'اسم العلامة مطلوب';
  if (d.website.trim() && !/^(https?:\/\/)?[^\s/]+\.[^\s]+$/i.test(d.website.trim())) errors.website = 'أدخل رابطًا صحيحًا، مثل https://company.sa';
  d.products.forEach((p, i) => {
    if (!p.name.trim() && (p.price.trim() || p.description.trim())) errors[`products.${i}.name`] = 'اسم المنتج مطلوب';
  });
  return errors;
}

/** Trim every text field and drop empty product rows; a new object, the draft is untouched. */
function clean(d) {
  const trimmed = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  const products = d.products.filter((p) => p.name.trim())
    .map((p) => ({ name: p.name.trim(), price: p.price.trim(), description: p.description.trim() }));
  return { ...trimmed, products };
}

function Completeness({ draft }) {
  const done = SCORED.filter((k) => filled(draft[k])).length;
  const pct = Math.round((done / SCORED.length) * 100);
  return html`<div class="card pad st-brief">
    <span class="mark lg agent"><${Icon} name="book" size="22" /></span>
    <div class="grow"><b>ملف واحد يقرؤه الفريق كله</b>
      <p class="small muted">قبل أي منشور أو حملة أو رد على عميل، يقرأ كل وكيل هذا الملف ليكتب بصوت علامتك ويلتزم بما تسمح به
        وما تمنعه. كلما كان أدق، جاءت النتائج أقرب لما تريد.</p></div>
    <div class="st-brief-meter"><div class="row between"><span class="tiny faint">اكتمال الملف</span><b class="num">${num(pct)}٪</b></div>
      <${Meter} value=${pct} max=${100} tone=${pct >= 80 ? 'ok' : 'warn'} /></div>
  </div>`;
}

function Products({ items, onChange, errors }) {
  const update = (i, key, value) => onChange(items.map((p, j) => (j === i ? { ...p, [key]: value } : p)));
  const remove = (i) => onChange(items.filter((_, j) => j !== i));
  const add = () => onChange([...items, EMPTY_PRODUCT]);
  return html`
    ${items.length ? html`<div class="st-prods">${items.map((p, i) => html`<div class="st-prod" key=${i}>
        <span class="st-prod-n num">${num(i + 1)}</span>
        <div class="st-prod-fields">
          <${TextField} label="الاسم" value=${p.name} maxLength=${120} error=${errors[`products.${i}.name`]}
            onInput=${(e) => update(i, 'name', e.currentTarget.value)} placeholder="مثل: باقة التصوير الشهرية" />
          <${TextField} label="السعر" value=${p.price} maxLength=${40} error=${errors[`products.${i}.price`]}
            onInput=${(e) => update(i, 'price', e.currentTarget.value)} placeholder="مثل: 499 ر.س" />
          <${TextField} class="st-prod-desc" label="الوصف" value=${p.description} maxLength=${600}
            error=${errors[`products.${i}.description`]} onInput=${(e) => update(i, 'description', e.currentTarget.value)}
            placeholder="ما الذي يحصل عليه العميل ولمن يناسب" />
        </div>
        <${Button} variant="ghost" size="sm" icon="trash" class="st-prod-x" aria-label=${`حذف المنتج ${i + 1}`} title="حذف"
          onClick=${() => remove(i)} />
      </div>`)}</div>`
      : html`<p class="muted small">لم تضف منتجات بعد. أضف ما تبيعه مع سعره المعتمد ليذكره الوكلاء بدقة.</p>`}
    <div class="row between wrap mt-12">
      <${Button} size="sm" icon="plus" onClick=${add} disabled=${items.length >= MAX_PRODUCTS}>إضافة منتج أو خدمة</${Button}>
      <span class="tiny faint">${num(items.length)} من ${num(MAX_PRODUCTS)}</span>
    </div>`;
}

function BrandForm({ initial, onSaved }) {
  const f = useForm(initial);
  const d = f.draft;
  const editable = can('manager');
  const submit = () => {
    if (!check(f, validate(d))) return;
    f.save(async () => {
      const obj = await api.put('/settings/brand', clean(d));
      onSaved(obj);
      return obj;
    }, 'حُفظ ملف العلامة، وسيقرؤه الوكلاء من المهمة القادمة');
  };
  const setProducts = (items) => {
    f.set('products', items);
    f.setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('products'))));
  };
  return html`<${Completeness} draft=${d} />
    <${SettingsForm} form=${f} onSubmit=${submit} canEdit=${editable} saveLabel="حفظ ملف العلامة">
      <${Card} title="الهوية" icon="building">
        <div class="st-grid">
          <${TextField} label="اسم العلامة" required maxLength=${120} ...${f.bind('name')} error=${f.errors.name}
            help="يظهر في التقارير وتوقيع الرسائل." />
          <${TextField} label="العبارة التعريفية" maxLength=${200} ...${f.bind('tagline')} error=${f.errors.tagline}
            placeholder="مثل: قهوة مختصة تصلك خلال ساعة" help="جملة واحدة تلخص ما تقدمه." />
          <${TextField} label="المجال" maxLength=${120} ...${f.bind('industry')} error=${f.errors.industry}
            placeholder="مثل: مطاعم، عقار، تجارة إلكترونية" />
          <${TextField} label="الموقع الإلكتروني" ltr type="url" inputMode="url" maxLength=${300} ...${f.bind('website')}
            error=${f.errors.website} placeholder="https://company.sa" help="يضعه الوكلاء في الدعوة لاتخاذ إجراء." />
          <${TextField} label="رقم التواصل" ltr type="tel" inputMode="tel" maxLength=${40} ...${f.bind('phone')}
            error=${f.errors.phone} placeholder="+966 5X XXX XXXX" help="يُذكر في الردود والمنشورات عند الحاجة." />
        </div>
      </${Card}>

      <${Card} title="القصة والجمهور" icon="users">
        <div class="col gap-16">
          <${TextField} area rows=${4} counter label="نبذة عن الشركة" maxLength=${2000} ...${f.bind('description')}
            error=${f.errors.description} help="ماذا تبيع، ولمن، وما الذي يميزك عن غيرك." />
          <${TextField} area rows=${3} counter label="الجمهور المستهدف" maxLength=${1000} ...${f.bind('audience')}
            error=${f.errors.audience} help="من هم عملاؤك: العمر والمدينة والاهتمامات وما يدفعهم للشراء." />
          <${TextField} area rows=${2} counter label="قيم العلامة" maxLength=${600} ...${f.bind('values')}
            error=${f.errors.values} placeholder="مثل: الجودة أولًا، الشفافية في الأسعار، خدمة سريعة" />
        </div>
      </${Card}>

      <${Card} title="صوت العلامة" icon="message">
        <div class="st-grid">
          <${TextField} label="نبرة الصوت" maxLength=${300} ...${f.bind('tone')} error=${f.errors.tone}
            help="كيف تبدو كلماتك، مثل: ودود، واثق، مختصر." />
          <${TextField} label="اللهجة" maxLength=${60} list="st-dialects" ...${f.bind('dialect')} error=${f.errors.dialect}
            help="اللهجة التي يكتب بها المحتوى ويرد بها على العملاء." />
          <datalist id="st-dialects">${DIALECTS.map((x) => html`<option value=${x} />`)}</datalist>
        </div>
        <div class="st-grid mt-16">
          <${TextField} area rows=${4} counter label="افعل دائمًا" maxLength=${1000} ...${f.bind('dos')} error=${f.errors.dos}
            placeholder="سطر لكل قاعدة، مثل: اذكر التوصيل المجاني فوق 200 ريال" />
          <${TextField} area rows=${4} counter label="خطوط حمراء" maxLength=${1000} ...${f.bind('donts')} error=${f.errors.donts}
            help="لا يتجاوزها أي وكيل في أي منشور أو رد." />
        </div>
        <div class="mt-16">
          <${ChipsField} label="الوسوم الأساسية" values=${d.base_hashtags} max=${MAX_TAGS} normalize=${normTag}
            onChange=${(v) => f.set('base_hashtags', v)} error=${f.errors.base_hashtags} placeholder="#اسم_علامتك"
            help="تُضاف إلى منشورات القنوات تلقائيًا. اضغط Enter بعد كل وسم." />
        </div>
      </${Card}>

      <${Card} title="المنتجات والخدمات" icon="store"
        actions=${html`<span class="tiny faint">يذكر الوكلاء هذه الأسعار فقط، فاحرص على دقتها</span>`}>
        <${Products} items=${d.products} onChange=${setProducts} errors=${f.errors} />
      </${Card}>
    </${SettingsForm}>`;
}

function BrandSkeleton() {
  return html`<div class="col gap-16">${[96, 260, 300, 200].map((h) => html`<div class="card pad"><${Skeleton} h=${h} /></div>`)}</div>`;
}

export default function BrandTab() {
  const st = useCachedApi('/settings');
  const initial = useMemo(() => st.data?.sections?.brand, [st.data]);
  const onSaved = (obj) => {
    st.setData(withSection('brand', obj));
    session.set({ company: obj.name });
  };
  return html`<${Head} title="ملف العلامة" text="هويتك وصوتك ومنتجاتك في مكان واحد. هذا هو الموجز الذي يبني عليه كل وكيل عمله." />
    ${!can('manager') && html`<${ReadOnly} />`}
    <${Loader} state=${st} skeleton=${html`<${BrandSkeleton} />`}>${() => html`<${BrandForm} initial=${initial} onSaved=${onSaved} />`}</${Loader}>`;
}
