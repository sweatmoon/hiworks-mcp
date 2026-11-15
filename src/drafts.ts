import type Mail from 'nodemailer/lib/mailer/index.js';
import type { Db } from './db/client.js';
import { currentAccount } from './account.js';
import { createTransporter } from './services/smtp.js';
import { fetchAttachment } from './attachments/read.js';
import { getEmailById } from './search/query.js';
import { log } from './config.js';

/**
 * 메일 초안을 "나에게만" 보낸다 (2026-11-15 사용자 결정: 남에게 보내지 않고 초안만, 첨부 가능, 외부 수신자도 초안에 적을 수 있음).
 *
 * 하이웍스는 POP3·SMTP 만 있고 IMAP 이 없어 임시보관함에 직접 넣을 수 없다. 그래서 초안을 본인 메일함으로 보내고,
 * 사람이 하이웍스에서 그 메일을 열어 "전달" → 받는 사람 넣고 → 고쳐서 보낸다(첨부는 전달에 따라감).
 *
 * 안전장치: SMTP 수신자(envelope·To)는 코드에서 항상 이 계정 본인 주소 하나로 고정한다. 입력의 to/cc/bcc 는
 * 메일 본문 위 안내와 X-Draft-* 머리글에만 적히고 실제로는 아무에게도 가지 않는다.
 */

export interface DraftAttachmentRef {
  /** 메일 첨부: 메일 id + (attachmentId | index | filename) — POP3 원본에서 다시 받는다 */
  emailId?: number;
  attachmentId?: number;
  index?: number;
  filename?: string;
  /** 또는 내려받을 주소(https, DRAFT_URL_HOSTS 에 있는 호스트만 — 예: NAS MCP 의 일회용 링크) */
  url?: string;
  /** 첨부 이름 바꾸기 (선택) */
  name?: string;
}

export interface DraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** 이 메일에 대한 답장 초안이면 그 메일 id (같은 스레드로 묶이게 In-Reply-To·References) */
  replyToEmailId?: number;
  attachments?: DraftAttachmentRef[];
}

const MAX_ATTACH = 10;
const maxTotalBytes = () => Number(process.env['DRAFT_MAX_MB'] || 20) * 1024 * 1024;
const urlHosts = () => String(process.env['DRAFT_URL_HOSTS'] || '').split(/[,\s]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
const PER_HOUR = Number(process.env['DRAFT_PER_HOUR'] || 30);
const sentLog = new Map<string, number[]>();

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const cleanList = (list: string[] | undefined, label: string): string[] => {
  const out = (list ?? []).map((s) => s.trim()).filter(Boolean);
  for (const a of out) if (!EMAIL_RE.test(a)) throw new Error(`${label} 주소 형식이 아닙니다: ${a}`);
  return out;
};

function filenameFromDisposition(cd: string | null): string | null {
  if (!cd) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ''));
    } catch {
      /* 아래로 */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return plain ? plain[1]!.trim() : null;
}

async function fromUrl(ref: DraftAttachmentRef, budget: number): Promise<Mail.Attachment & { size: number }> {
  let u: URL;
  try {
    u = new URL(ref.url!);
  } catch {
    throw new Error(`첨부 주소가 올바르지 않습니다: ${ref.url}`);
  }
  if (u.protocol !== 'https:') throw new Error('첨부 주소는 https 만 됩니다.');
  if (!urlHosts().includes(u.hostname.toLowerCase())) throw new Error(`이 주소의 파일은 첨부할 수 없습니다(허용 호스트 아님: ${u.hostname}). NAS 파일은 NAS 커넥터의 download_link 주소를 쓰세요.`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(u, { signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) throw new Error(`첨부 내려받기 실패 (HTTP ${res.status}) — 일회용 링크는 한 번만 열 수 있으니 새로 만들어 주세요.`);
    const reader = res.body?.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > budget) {
          await reader.cancel().catch(() => {});
          throw new Error(`첨부가 너무 큽니다(합계 ${Math.round(maxTotalBytes() / 1048576)}MB 초과).`);
        }
        chunks.push(Buffer.from(value));
      }
    }
    const name = ref.name || filenameFromDisposition(res.headers.get('content-disposition')) || decodeURIComponent(u.pathname.split('/').pop() || 'attachment');
    return { filename: name, content: Buffer.concat(chunks), contentType: res.headers.get('content-type') || undefined, size };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error('첨부 내려받기 시간 초과(60초).');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function rateLimit(key: string): void {
  const now = Date.now();
  const list = (sentLog.get(key) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= PER_HOUR) throw new Error(`초안은 한 시간에 ${PER_HOUR}통까지 보낼 수 있습니다. 잠시 뒤 다시 하세요.`);
  list.push(now);
  sentLog.set(key, list);
}

/** 테스트용 */
export function resetDraftLimits(): void {
  sentLog.clear();
}

export async function sendDraftToSelf(db: Db, input: DraftInput): Promise<Record<string, unknown>> {
  const account = currentAccount();
  if (!account.username || !account.password) throw new Error('이 계정의 하이웍스 주소·비밀번호가 서버에 없어 초안을 보낼 수 없습니다.');
  const self = account.username.toLowerCase();
  const to = cleanList(input.to, '받는 사람');
  const cc = cleanList(input.cc, '참조');
  const bcc = cleanList(input.bcc, '숨은참조');
  if (!to.length) throw new Error('받는 사람을 한 명 이상 적어 주세요(초안 안내에만 쓰이고 실제로 보내지 않습니다).');
  if (to.length + cc.length + bcc.length > 100) throw new Error('받는 사람이 너무 많습니다(100명 이하).');
  const subject = String(input.subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!subject) throw new Error('제목이 비어 있습니다.');
  const body = String(input.body ?? '');
  if (body.length > 200_000) throw new Error('본문이 너무 깁니다(20만 자 이하).');
  const refs = input.attachments ?? [];
  if (refs.length > MAX_ATTACH) throw new Error(`첨부는 ${MAX_ATTACH}개까지입니다.`);

  // 답장 초안: 원래 메일과 같은 스레드로
  const headers: Record<string, string> = {
    'X-Hiworks-MCP-Draft': '1',
    'X-Draft-To': to.join(', '),
    ...(cc.length ? { 'X-Draft-Cc': cc.join(', ') } : {}),
    ...(bcc.length ? { 'X-Draft-Bcc': bcc.join(', ') } : {}),
  };
  if (input.replyToEmailId !== undefined) {
    const orig = await getEmailById(db, input.replyToEmailId);
    if (!orig) throw new Error(`답장할 메일을 찾을 수 없습니다: ${input.replyToEmailId}`);
    const mid = (orig as { messageId?: string | null }).messageId;
    const refsList = ((orig as { references?: string[] }).references ?? []).concat(mid ? [mid] : []);
    if (mid) headers['In-Reply-To'] = `<${mid}>`;
    if (refsList.length) headers['References'] = refsList.map((r) => `<${r}>`).join(' ');
  }

  // 첨부 모으기 (합계 한도)
  const attachments: Mail.Attachment[] = [];
  const attachedInfo: Array<{ name: string; sizeKB: number; from: string }> = [];
  let total = 0;
  for (const [i, ref] of refs.entries()) {
    if (ref.url) {
      const a = await fromUrl(ref, maxTotalBytes() - total);
      total += a.size;
      attachments.push({ filename: a.filename, content: a.content, contentType: a.contentType });
      attachedInfo.push({ name: String(a.filename), sizeKB: Math.round(a.size / 1024), from: '주소' });
    } else if (ref.emailId !== undefined) {
      const r = await fetchAttachment(db, { emailId: ref.emailId, attachmentId: ref.attachmentId, index: ref.index, filename: ref.filename });
      if (!r.ok) throw new Error(`첨부 ${i + 1}: ${r.error}`);
      total += r.file.content.length;
      if (total > maxTotalBytes()) throw new Error(`첨부가 너무 큽니다(합계 ${Math.round(maxTotalBytes() / 1048576)}MB 초과). 큰 파일은 하이웍스 대용량 첨부로 직접 넣어 주세요.`);
      const name = ref.name || r.file.pick.filename;
      attachments.push({ filename: name, content: r.file.content, contentType: r.file.contentType });
      attachedInfo.push({ name, sizeKB: Math.round(r.file.content.length / 1024), from: `메일 ${ref.emailId}` });
    } else {
      throw new Error(`첨부 ${i + 1}: emailId(메일 첨부) 또는 url 중 하나가 필요합니다.`);
    }
  }

  rateLimit(account.key);
  const banner = [
    '──────── 초안 (Claude 작성, 아직 아무에게도 보내지 않음) ────────',
    `받는 사람: ${to.join(', ')}`,
    ...(cc.length ? [`참조: ${cc.join(', ')}`] : []),
    ...(bcc.length ? [`숨은참조: ${bcc.join(', ')}  ← 전달하기 전에 꼭 지우세요(받는 사람에게 보임)`] : []),
    `제목: ${subject}`,
    ...(attachedInfo.length ? [`첨부: ${attachedInfo.map((a) => a.name).join(', ')}`] : []),
    '보내려면: 이 메일 열기 → [전달] → 받는 사람 넣기 → 이 안내 칸 지우고 내용 고치기 → 보내기',
    '──────────────────────────────────────────────',
    '',
  ].join('\n');

  const transporter = createTransporter({ username: account.username, password: account.password });
  try {
    const info = await transporter.sendMail({
      from: account.username,
      // 안전장치: 실제 수신자는 언제나 본인 하나. to/cc/bcc 입력은 위 안내·머리글에만 쓰인다
      to: account.username,
      envelope: { from: account.username, to: [account.username] },
      subject: `[초안] ${subject}`,
      text: banner + body,
      headers,
      attachments,
    });
    log(`draft sent to self (account=${account.key}, attachments=${attachments.length})`);
    return {
      success: true,
      deliveredTo: self,
      draftSubject: `[초안] ${subject}`,
      intended: { to, cc, bcc, subject },
      attachments: attachedInfo,
      messageId: info.messageId,
      note: '본인 받은편지함에 [초안] 메일로 넣었습니다. 아무에게도 보내지 않았습니다. 보내려면 하이웍스에서 그 메일을 열어 [전달] → 받는 사람 넣고 → 안내 칸을 지우고 고쳐서 보내세요. 고칠 게 있으면 말씀하시면 새 초안을 다시 넣습니다(이전 초안은 직접 지우세요).',
    };
  } finally {
    transporter.close();
  }
}
