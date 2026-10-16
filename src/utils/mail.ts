import type { AddressObject, ParsedMail } from 'mailparser';
import type { AttachmentInfo, Email, EmailHeader } from '../types/mail.js';
import { formatKST } from './date.js';

/** mailparser 의 주소 객체를 "이름 <주소>, ..." 형태의 문자열로 바꾼다. */
export function addressText(addr: AddressObject | AddressObject[] | undefined): string {
  if (!addr) return '';
  const list = Array.isArray(addr) ? addr : [addr];
  return list
    .map((a) => a.text)
    .filter(Boolean)
    .join(', ');
}

/** 주소 객체에서 이메일 주소만 뽑아 배열로 돌려준다. */
export function addressList(addr: AddressObject | AddressObject[] | undefined): string[] {
  if (!addr) return [];
  const list = Array.isArray(addr) ? addr : [addr];
  const out: string[] = [];
  for (const a of list) {
    for (const v of a.value) {
      if (v.address) out.push(v.address);
    }
  }
  return out;
}

export function normalizeMessageId(id: string | undefined): string {
  return (id || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

/** 첨부 메타데이터만 추려서 반환 (본문 Buffer 는 제외). */
export function attachmentInfos(parsed: ParsedMail): AttachmentInfo[] {
  return (parsed.attachments || []).map((a, index) => ({
    index,
    filename: a.filename || `attachment-${index + 1}`,
    contentType: a.contentType,
    size: a.size,
  }));
}

/** TOP(헤더만) 결과로도 첨부 여부를 짐작한다. multipart/mixed 이거나 첨부가 파싱됐으면 true. */
function guessHasAttachments(parsed: ParsedMail): boolean {
  if (parsed.attachments && parsed.attachments.length > 0) return true;
  const ct = parsed.headers.get('content-type');
  if (ct && typeof ct === 'object' && 'value' in ct) {
    return String((ct as { value: string }).value).toLowerCase() === 'multipart/mixed';
  }
  return false;
}

export function toHeader(
  parsed: ParsedMail,
  msgNum: number,
  uid: string,
  size?: number
): EmailHeader {
  const header: EmailHeader = {
    id: parsed.messageId || uid,
    uid,
    msgNum,
    subject: parsed.subject || '(제목 없음)',
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    date: parsed.date ? formatKST(parsed.date) : '',
    hasAttachments: guessHasAttachments(parsed),
  };
  const cc = addressText(parsed.cc);
  if (cc) header.cc = cc;
  if (size !== undefined) header.size = size;
  return header;
}

export function toEmail(parsed: ParsedMail, msgNum: number, uid: string, size?: number): Email {
  const header = toHeader(parsed, msgNum, uid, size);
  const email: Email = {
    ...header,
    content: parsed.text || '',
    attachments: attachmentInfos(parsed),
  };
  email.hasAttachments = email.attachments.length > 0;
  if (parsed.html) email.html = parsed.html;
  const replyTo = addressText(parsed.replyTo);
  if (replyTo) email.replyTo = replyTo;
  return email;
}

/** 파일명에서 경로 구분자와 제어 문자를 제거한다. */
export function sanitizeFilename(name: string): string {
  const base = name.replace(/[/\\]/g, '_').replace(/[\x00-\x1f\x7f]/g, '').trim();
  const cleaned = base.replace(/^\.+/, '');
  return cleaned || 'attachment';
}

/** 본문을 인용문(> ...)으로 만든다. */
export function quoteText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
