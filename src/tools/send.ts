import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { log, resolveCredentials } from '../config.js';
import { withPop3 } from '../services/pop3.js';
import { buildAttachments, createTransporter, toAddressArray } from '../services/smtp.js';
import { formatKST } from '../utils/date.js';
import { addressList, addressText, quoteText, stripHtml } from '../utils/mail.js';
import type { SendEmailResponse } from '../types/mail.js';
import { credentialShape, errorResult, jsonResult, messageIdShape } from './common.js';

const recipientSchema = z
  .union([z.string(), z.array(z.string())])
  .describe('이메일 주소. 쉼표로 구분한 문자열 또는 배열');

const attachmentSchema = z
  .array(
    z.object({
      filename: z.string().optional().describe('첨부 파일명'),
      path: z.string().optional().describe('로컬 파일 경로 (content 대신 사용)'),
      content: z.string().optional().describe('파일 내용. 텍스트 또는 base64'),
      encoding: z.enum(['utf8', 'base64']).optional().describe('content 인코딩 (기본 utf8)'),
      contentType: z.string().optional(),
    })
  )
  .optional()
  .describe('첨부 파일 목록');

const QUOTE_LIMIT = 10000;

function prefixSubject(subject: string, prefix: 'Re' | 'Fwd'): string {
  const s = subject.trim();
  const re = prefix === 'Re' ? /^(re|답장)\s*:/i : /^(fwd?|fw|전달)\s*:/i;
  return re.test(s) ? s : `${prefix}: ${s}`;
}

function originalBodyText(text: string | undefined, html: string | false | undefined): string {
  if (text && text.trim()) return text;
  if (html) return stripHtml(html);
  return '';
}

async function send(creds: { username: string; password: string }, options: Mail.Options): Promise<SendEmailResponse> {
  const transporter = createTransporter(creds);
  log('Sending email:', { to: options.to, subject: options.subject });
  const info = await transporter.sendMail({ from: creds.username, ...options });
  return {
    success: true,
    messageId: info.messageId,
    accepted: (info.accepted || []).map(String),
    rejected: (info.rejected || []).map(String),
  };
}

export function registerSendTools(server: McpServer): void {
  server.registerTool(
    'send_email',
    {
      title: '메일 보내기',
      description: '하이웍스 계정으로 새 메일을 보냅니다. 기존 메일에 답장하려면 reply_email, 전달하려면 forward_email 을 쓰세요.',
      inputSchema: {
        ...credentialShape,
        to: recipientSchema,
        subject: z.string(),
        text: z.string().optional().describe('일반 텍스트 본문'),
        html: z.string().optional().describe('HTML 본문 (text 와 함께 보내면 둘 다 포함)'),
        cc: recipientSchema.optional(),
        bcc: recipientSchema.optional(),
        replyTo: z.string().optional().describe('회신 받을 주소'),
        attachments: attachmentSchema,
      },
    },
    async ({ username, password, to, subject, text, html, cc, bcc, replyTo, attachments }) => {
      try {
        const creds = resolveCredentials(username, password);
        if (!text && !html) throw new Error('text 또는 html 본문 중 하나는 필요합니다.');
        const options: Mail.Options = {
          to: toAddressArray(to),
          subject,
          attachments: buildAttachments(attachments),
        };
        if (text) options.text = text;
        if (html) options.html = html;
        const ccList = toAddressArray(cc);
        if (ccList.length) options.cc = ccList;
        const bccList = toAddressArray(bcc);
        if (bccList.length) options.bcc = bccList;
        if (replyTo) options.replyTo = replyTo;
        return jsonResult(await send(creds, options));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'reply_email',
    {
      title: '답장 보내기',
      description:
        '받은 메일에 답장합니다. 원본의 제목(Re:), 스레드 헤더(In-Reply-To/References), 인용문을 자동으로 붙입니다. ' +
        '기본은 보낸사람에게만 답장하며 replyAll 로 모든 수신자에게 보낼 수 있습니다.',
      inputSchema: {
        ...credentialShape,
        ...messageIdShape,
        text: z.string().describe('답장 본문 (텍스트)'),
        html: z.string().optional().describe('답장 본문 (HTML, 선택)'),
        replyAll: z.boolean().optional().describe('true 면 원본의 받는사람·참조에게도 보냄 (기본 false)'),
        quoteOriginal: z.boolean().optional().describe('원본 본문을 인용으로 붙일지 (기본 true)'),
        cc: recipientSchema.optional().describe('추가 참조'),
        bcc: recipientSchema.optional(),
        attachments: attachmentSchema,
      },
    },
    async ({ username, password, messageId, text, html, replyAll = false, quoteOriginal = true, cc, bcc, attachments }) => {
      try {
        const creds = resolveCredentials(username, password);
        const original = await withPop3(creds, async (session) => {
          const ref = await session.resolve(messageId);
          if (!ref) throw new Error(`메일을 찾을 수 없습니다: ${messageId}`);
          return session.retrieve(ref.msgNum);
        });

        const self = creds.username.toLowerCase();
        const primary = addressList(original.replyTo).length ? addressList(original.replyTo) : addressList(original.from);
        const to = new Set(primary.map((a) => a.toLowerCase()));
        const ccSet = new Set<string>();
        if (replyAll) {
          for (const a of [...addressList(original.to), ...addressList(original.cc)]) {
            const lower = a.toLowerCase();
            if (lower !== self && !to.has(lower)) ccSet.add(lower);
          }
        }
        for (const a of toAddressArray(cc)) ccSet.add(a.toLowerCase());
        if (to.size === 0) throw new Error('원본 메일에서 답장할 주소를 찾지 못했습니다.');

        const originalDate = original.date ? formatKST(original.date) : '';
        const originalFrom = addressText(original.from);
        const quotedBody = originalBodyText(original.text, original.html).slice(0, QUOTE_LIMIT);
        const quoteHeader = `${originalDate} ${originalFrom} 작성:`;

        const options: Mail.Options = {
          to: Array.from(to),
          subject: prefixSubject(original.subject || '', 'Re'),
          text: quoteOriginal && quotedBody ? `${text}\n\n${quoteHeader}\n${quoteText(quotedBody)}` : text,
          attachments: buildAttachments(attachments),
        };
        if (html) {
          const quotedHtml = original.html || (quotedBody ? `<pre>${quotedBody}</pre>` : '');
          options.html =
            quoteOriginal && quotedHtml
              ? `${html}<br><br><div>${quoteHeader}</div><blockquote style="border-left:1px solid #ccc;padding-left:1em;margin-left:0">${quotedHtml}</blockquote>`
              : html;
        }
        if (ccSet.size) options.cc = Array.from(ccSet);
        const bccList = toAddressArray(bcc);
        if (bccList.length) options.bcc = bccList;
        if (original.messageId) {
          options.inReplyTo = original.messageId;
          const refs = Array.isArray(original.references) ? original.references : original.references ? [original.references] : [];
          options.references = [...refs, original.messageId].join(' ');
        }
        return jsonResult({ ...(await send(creds, options)), to: options.to, cc: options.cc ?? [], subject: options.subject });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'forward_email',
    {
      title: '메일 전달',
      description: '받은 메일을 다른 사람에게 전달합니다. 원본 본문과 첨부 파일을 그대로 포함합니다.',
      inputSchema: {
        ...credentialShape,
        ...messageIdShape,
        to: recipientSchema,
        text: z.string().optional().describe('전달 메일 상단에 붙일 메시지'),
        cc: recipientSchema.optional(),
        bcc: recipientSchema.optional(),
        includeAttachments: z.boolean().optional().describe('원본 첨부를 포함할지 (기본 true)'),
      },
    },
    async ({ username, password, messageId, to, text, cc, bcc, includeAttachments = true }) => {
      try {
        const creds = resolveCredentials(username, password);
        const original = await withPop3(creds, async (session) => {
          const ref = await session.resolve(messageId);
          if (!ref) throw new Error(`메일을 찾을 수 없습니다: ${messageId}`);
          return session.retrieve(ref.msgNum);
        });

        const header = [
          '---------- 전달된 메일 ----------',
          `보낸사람: ${addressText(original.from)}`,
          `날짜: ${original.date ? formatKST(original.date) : ''}`,
          `제목: ${original.subject || ''}`,
          `받는사람: ${addressText(original.to)}`,
          ...(addressText(original.cc) ? [`참조: ${addressText(original.cc)}`] : []),
        ].join('\n');
        const body = originalBodyText(original.text, original.html);
        const intro = text ? `${text}\n\n` : '';

        const options: Mail.Options = {
          to: toAddressArray(to),
          subject: prefixSubject(original.subject || '', 'Fwd'),
          text: `${intro}${header}\n\n${body}`,
        };
        if (original.html) {
          const introHtml = text ? `<div style="white-space:pre-wrap">${text}</div><br>` : '';
          options.html = `${introHtml}<div style="white-space:pre-wrap;color:#555">${header}</div><br>${original.html}`;
        }
        const ccList = toAddressArray(cc);
        if (ccList.length) options.cc = ccList;
        const bccList = toAddressArray(bcc);
        if (bccList.length) options.bcc = bccList;
        if (includeAttachments && original.attachments?.length) {
          options.attachments = original.attachments.map((a, i) => ({
            filename: a.filename || `attachment-${i + 1}`,
            content: a.content,
            contentType: a.contentType,
          }));
        }
        const result = await send(creds, options);
        return jsonResult({
          ...result,
          to: options.to,
          subject: options.subject,
          forwardedAttachments: options.attachments?.length ?? 0,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
