// Inbox vocabulary shared by the list, the thread and the contact panel.
export { AGENT_NAME } from '../../lib/format.js';
import { AGENT_NAME } from '../../lib/format.js';

export const STATUS_TABS = [
  { value: 'escalated', label: 'تحتاجك' },
  { value: 'open', label: 'جديدة' },
  { value: 'pending', label: 'بانتظار الاعتماد' },
  { value: 'answered', label: 'تم الرد' },
  { value: 'all', label: 'الكل' },
];

export const KIND = { comment: 'تعليق عام', dm: 'رسالة خاصة', whatsapp: 'محادثة واتساب' };
export const STAGE = { new: 'جديد', lead: 'عميل محتمل', customer: 'عميل' };
export const SENTIMENT = { positive: ['نبرة إيجابية', 'pos'], negative: ['نبرة سلبية', 'neg'] };

/** Delivery state of one of our messages. [label, tone, icon] */
export const OUT_STATUS = {
  sent: ['أُرسل', 'ok', 'check'], queued: ['قيد الإرسال', '', 'clock'], pending: ['بانتظار اعتمادك', 'warn', 'clock'],
  failed: ['تعذر الإرسال', 'bad', 'alert'], discarded: ['استُبعد', '', 'x'],
};

export const contactName = (c) => c?.name || c?.handle || c?.phone || 'عميل';

/** Who wrote a message, in words: the customer, one of the agents, or a team member. */
export function authorLabel(author, contact, meId) {
  if (!author || author === 'contact') return contactName(contact);
  if (author.startsWith('user:')) return author.slice(5) === meId ? 'أنت' : 'أحد أعضاء الفريق';
  return AGENT_NAME[author] || author;
}

/** opt_source → readable origin of the WhatsApp consent. */
export function consentSource(src) {
  if (!src) return '';
  if (src === 'whatsapp:keyword') return 'أرسل العميل كلمة الاشتراك بنفسه';
  if (src === 'whatsapp:opt_out') return 'أوقف العميل الاشتراك برسالة';
  const manual = /^manual:(.*?)(?: by .*)?$/.exec(src);
  if (manual) return manual[1] === 'opt_out' ? 'أوقفه أحد أعضاء الفريق' : `سجّلها الفريق يدويًا: ${manual[1]}`;
  return src;
}
