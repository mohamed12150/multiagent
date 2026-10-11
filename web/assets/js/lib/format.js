// Formatting and shared vocabulary (Arabic labels for every status the API returns).

const NF = new Intl.NumberFormat('en-US');
export const num = (v) => (v === null || v === undefined || Number.isNaN(+v) ? '—' : NF.format(Math.round(+v)));
export const dec = (v, d = 1) => (v === null || v === undefined ? '—' : (+v).toFixed(d));
export const money = (v, cur = 'ر.س') => `${NF.format(Math.round(+v || 0))} ${cur}`;
export const usd = (v) => `$${(+v || 0).toFixed((+v || 0) < 1 ? 3 : 2)}`;

export function compact(v) {
  const n = +v || 0;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return NF.format(Math.round(n));
}

const parse = (iso) => (iso ? new Date(iso.endsWith('Z') ? iso : `${iso}Z`) : null);

export function ago(iso) {
  const d = parse(iso);
  if (!d) return '';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'الآن';
  const m = Math.round(s / 60);
  if (m < 60) return `قبل ${m} د`;
  const h = Math.round(m / 60);
  if (h < 24) return `قبل ${h} س`;
  const days = Math.round(h / 24);
  if (days === 1) return 'أمس';
  if (days === 2) return 'قبل يومين';
  if (days <= 10) return `قبل ${days} أيام`;
  if (days < 30) return `قبل ${days} يومًا`;
  return date(iso);
}

export function until(iso) {
  const d = parse(iso);
  if (!d) return '';
  const m = Math.round((d.getTime() - Date.now()) / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return `بعد ${m} د`;
  const h = Math.round(m / 60);
  if (h < 24) return `بعد ${h} س`;
  return dateTime(iso);
}

let TZ = 'Asia/Riyadh';
let F_ = null;
function fmts() {
  if (!F_) {
    const loc = 'ar-SA-u-nu-latn-ca-gregory';
    F_ = {
      date: new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', timeZone: TZ }),
      dateTime: new Intl.DateTimeFormat(loc, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ }),
      time: new Intl.DateTimeFormat('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit', timeZone: TZ }),
      long: new Intl.DateTimeFormat(loc, { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }),
      hour: new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: TZ }),
    };
  }
  return F_;
}
/** The company's timezone (Settings › عام); every date on screen follows it. */
export function setTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return; }
  TZ = tz;
  F_ = null;
}
export const timeZone = () => TZ;
export const date = (iso) => (parse(iso) ? fmts().date.format(parse(iso)) : '');
export const dateTime = (iso) => (parse(iso) ? fmts().dateTime.format(parse(iso)) : '');
export const time = (iso) => (parse(iso) ? fmts().time.format(parse(iso)) : '');
export const longToday = () => fmts().long.format(new Date());

function offsetMinutes(at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at).map((p) => [p.type, p.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((local - at.getTime()) / 60000);
}

/** "YYYY-MM-DDTHH:MM" in the company's timezone for <input type=datetime-local>. */
export function localInput(iso) {
  const d = iso ? parse(iso) : new Date(Date.now() + 3600e3);
  return new Date(d.getTime() + offsetMinutes(d) * 60000).toISOString().slice(0, 16);
}

export function greeting() {
  const h = +fmts().hour.format(new Date());
  return h < 12 ? 'صباح الخير' : 'مساء الخير';
}

export const CHANNELS = ['tiktok', 'instagram', 'x', 'whatsapp', 'linkedin'];
export const CHANNEL_LABEL = { tiktok: 'تيك توك', instagram: 'إنستقرام', x: 'إكس', whatsapp: 'واتساب', linkedin: 'لينكدإن' };
export const CHANNEL_ICON = { tiktok: 'tiktok', instagram: 'instagram', x: 'xlogo', whatsapp: 'whatsapp', linkedin: 'linkedin' };

export const AGENT_NAME = {
  ceo: 'القائد', campaigns: 'مدير الحملات', content: 'صانع المحتوى', coordinator: 'المنسّق', guardian: 'الحارس', system: 'النظام',
  ...Object.fromEntries(Object.entries(CHANNEL_LABEL).map(([id, l]) => [id, `وكيل ${l}`])),
};

export const POST_STATUS = {
  idea: ['فكرة', ''], draft: ['مسودة', ''], review: ['بانتظار الاعتماد', 'warn'], approved: ['معتمد', 'accent'],
  scheduled: ['مجدول', 'live'], publishing: ['قيد النشر', 'live'], published: ['منشور', 'ok'], failed: ['تعذر النشر', 'bad'],
  rejected: ['مرفوض', 'bad'],
};
export const TASK_STATUS = {
  queued: ['بالطابور', ''], running: ['قيد التنفيذ', 'live'], waiting: ['بانتظار الفريق', 'warn'], done: ['منجز', 'ok'],
  failed: ['متعثر', 'bad'], cancelled: ['ملغى', ''],
};
export const AGENT_STATUS = {
  idle: ['جاهز', 'ok'], working: ['يعمل الآن', 'live'], waiting: ['بانتظار', 'warn'], error: ['تعثّر', 'bad'], paused: ['موقوف', ''],
};
export const CAMPAIGN_STATUS = {
  proposed: ['مقترحة', 'warn'], approved: ['معتمدة', 'accent'], active: ['نشطة', 'ok'], paused: ['موقوفة', ''],
  completed: ['مكتملة', ''], rejected: ['مرفوضة', 'bad'],
};
export const OBJECTIVE = { awareness: 'الوعي', engagement: 'التفاعل', leads: 'عملاء محتملون', sales: 'المبيعات' };
export const CONV_STATUS = {
  open: ['جديدة', 'accent'], pending: ['بانتظار الاعتماد', 'warn'], answered: ['تم الرد', 'ok'], escalated: ['تحتاجك', 'bad'],
  closed: ['مغلقة', ''],
};
export const CATEGORY = {
  inquiry: ['استفسار', 'accent'], lead: ['فرصة بيع', 'ok'], complaint: ['شكوى', 'bad'], praise: ['إشادة', 'live'], spam: ['مزعج', ''],
  other: ['أخرى', ''],
};
export const APPROVAL_KIND = {
  post: ['محتوى', 'file'], asset: ['تصميم', 'image'], reply: ['رد على عميل', 'message'], campaign: ['حملة', 'megaphone'],
  limit: ['رفع ليمت', 'gauge'], broadcast: ['رسالة جماعية', 'send'], fix: ['إصلاح', 'shield'], spend: ['صرف', 'coins'],
};
export const PERM_VALUE = { auto: 'تلقائي', approve: 'باعتمادك', off: 'موقوف' };
export const AUTONOMY = {
  manual: ['يدوي', 'كل خطوة تمر عليك'], assisted: ['شبه آلي', 'المحتوى والحملات والصرف باعتمادك'],
  autopilot: ['طيار آلي', 'الشبكة تعمل وحدها ضمن الليمت'],
};
export const EFFORT = { low: 'سريع', medium: 'متوازن', high: 'عميق', xhigh: 'أعمق' };

export const label = (map, key) => (map[key] ? map[key][0] : key);
export const tone = (map, key) => (map[key] ? map[key][1] : '');

export const FORMAT = {
  post: 'منشور', reel: 'ريلز', carousel: 'كاروسيل', story: 'ستوري', video: 'فيديو', photo: 'صور', thread: 'سلسلة',
  article: 'مقال', broadcast: 'رسالة جماعية',
};
export const formatLabel = (f) => FORMAT[f] || f;
