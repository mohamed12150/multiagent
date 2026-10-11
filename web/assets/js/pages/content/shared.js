// Content vocabulary: board columns, formats per channel (mirrors qsm/agents/content.py FORMATS), text limits.
import { CHANNEL_LABEL, timeZone } from '../../lib/format.js';

export const FORMATS = {
  tiktok: ['video', 'photo'], instagram: ['reel', 'post', 'carousel', 'story'], x: ['post', 'thread'],
  linkedin: ['post', 'article'], whatsapp: ['broadcast'],
};

export const VIDEO_FORMATS = new Set(['video', 'reel', 'story']);
export const NEEDS_MEDIA = new Set(['tiktok', 'instagram']);
export const EDITABLE = new Set(['idea', 'draft', 'review', 'approved', 'scheduled', 'rejected', 'failed']);
export const MAX_ASSETS = 10;
export const X_LIMIT = 280;

/** Text limits per channel, applied to the text the channel agent actually sends (see agents/channels.py compose). */
export const TEXT_LIMIT = { x: X_LIMIT, instagram: 2200, tiktok: 2200, linkedin: 3000, whatsapp: 1024 };
export const TEXT_HINT = {
  x: 'حد إكس 280 حرفًا للتغريدة، والوسوم تُحسب ضمن النص.',
  instagram: 'حد إنستقرام 2,200 حرف، وأول سطر هو ما يظهر قبل «المزيد».',
  tiktok: 'حد تيك توك 2,200 حرف، والأفضل وصف قصير مع 3 إلى 5 وسوم.',
  linkedin: 'حد لينكدإن 3,000 حرف، وأول سطرين يظهران قبل «عرض المزيد».',
  whatsapp: 'الرسالة الجماعية حتى 1,024 حرفًا، بلا وسوم، مع خيار إيقاف الرسائل.',
};

const chars = (s) => [...(s || '')].length;

/** Length of the published text: caption, then CTA (not on X), then hashtags (not on WhatsApp). */
export function composedLength(d) {
  let body = (d.caption || '').trim();
  if (d.cta && !body.includes(d.cta) && d.channel !== 'x') body = `${body}\n\n${d.cta}`;
  const tags = d.channel === 'whatsapp' ? '' : (d.hashtags || []).join(' ');
  return chars(tags ? `${body}\n\n${tags}`.trim() : body);
}

export const COLUMNS = [
  { id: 'drafts', label: 'مسودات', statuses: ['idea', 'draft'], tone: 'draft', by: 'updated',
    empty: 'اطلب من صانع المحتوى أو اكتب منشورًا يدويًا.' },
  { id: 'review', label: 'بانتظار الاعتماد', statuses: ['review'], tone: 'warn', by: 'updated',
    empty: 'لا شيء ينتظر قرارك الآن.' },
  { id: 'approved', label: 'معتمد', statuses: ['approved'], tone: 'accent', by: 'updated',
    empty: 'المعتمد ينتقل للمنسّق ليجدوله في أفضل وقت.' },
  { id: 'scheduled', label: 'مجدول', statuses: ['scheduled', 'publishing'], tone: 'live', by: 'soonest',
    empty: 'لا منشورات مجدولة حاليًا.' },
  { id: 'published', label: 'منشور', statuses: ['published'], tone: 'ok', by: 'published',
    empty: 'تظهر هنا المنشورات بعد نشرها مع أرقام أدائها.' },
  { id: 'failed', label: 'متعثر أو مرفوض', statuses: ['failed', 'rejected'], tone: 'bad', by: 'updated',
    empty: 'لا أخطاء، كل شيء يسير كما يجب.' },
];

const ts = (iso) => (iso ? Date.parse(iso) : 0);
export const SORTS = {
  updated: (a, b) => ts(b.updated_at) - ts(a.updated_at),
  soonest: (a, b) => (ts(a.scheduled_at) || Infinity) - (ts(b.scheduled_at) || Infinity),
  published: (a, b) => ts(b.published_at) - ts(a.published_at),
};

const AGENT_NAME = { content: 'صانع المحتوى', ceo: 'القائد', campaigns: 'مدير الحملات', coordinator: 'المنسّق', guardian: 'الحارس' };

/** Who wrote it: an agent id, or `user:<id>` for a team member. */
export function authorOf(actor = '') {
  if (!actor || actor.startsWith('user:')) return { user: true, name: 'كتبه أحد أعضاء الفريق' };
  return { id: actor, name: AGENT_NAME[actor] || (CHANNEL_LABEL[actor] ? `وكيل ${CHANNEL_LABEL[actor]}` : actor) };
}

export const METRICS = [
  ['reach', 'الوصول', 'eye'], ['views', 'المشاهدات', 'play'], ['likes', 'الإعجابات', 'heart'],
  ['comments', 'التعليقات', 'message'], ['shares', 'المشاركات', 'send'], ['saves', 'الحفظ', 'save'],
  ['clicks', 'النقرات', 'link'],
];

// ---- company calendar days (the API speaks UTC ISO; the business runs on Settings › عام › المنطقة الزمنية) ----
let ymdZone = '';
let ymdFmt = null;
const YMD = { format: (d) => {
  if (ymdZone !== timeZone()) { ymdZone = timeZone(); ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: ymdZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  return ymdFmt.format(d);
} };
const WEEKDAY = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { weekday: 'long', timeZone: 'UTC' });
const DAY_MONTH = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { month: 'short', timeZone: 'UTC' });

const utcNoon = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
export const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(utcNoon(v).getTime());
export const todayYmd = () => YMD.format(new Date());
export const riyadhDay = (iso) => (iso ? YMD.format(new Date(iso)) : '');
export const addDays = (ymd, n) => { const d = utcNoon(ymd); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** Saudi working week: starts Sunday. */
export const weekStart = (ymd) => addDays(ymd, -utcNoon(ymd).getUTCDay());
export const weekdayName = (ymd) => WEEKDAY.format(utcNoon(ymd));
export const dayNumber = (ymd) => utcNoon(ymd).getUTCDate();
export const monthShort = (ymd) => MONTH.format(utcNoon(ymd));
export const dayMonth = (ymd) => DAY_MONTH.format(utcNoon(ymd));
