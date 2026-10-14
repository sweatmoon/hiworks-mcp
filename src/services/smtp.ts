import nodemailer, { type Transporter } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer/index.js';
import fs from 'fs';
import path from 'path';
import { config, type Credentials } from '../config.js';

export function createTransporter(creds: Credentials): Transporter {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: creds.username, pass: creds.password },
  });
}

/** send_email / reply_email 이 받는 첨부 입력 형식 */
export interface AttachmentInput {
  filename?: string;
  /** 로컬 파일 경로. 지정하면 content 는 무시한다 */
  path?: string;
  /** 텍스트 또는 base64 문자열 */
  content?: string;
  /** content 가 base64 면 "base64" */
  encoding?: 'utf8' | 'base64';
  contentType?: string;
}

export function buildAttachments(inputs: AttachmentInput[] | undefined): Mail.Attachment[] {
  if (!inputs || inputs.length === 0) return [];
  return inputs.map((a, i) => {
    if (a.path) {
      const resolved = path.resolve(a.path);
      if (!fs.existsSync(resolved)) {
        throw new Error(`첨부 파일을 찾을 수 없습니다: ${a.path}`);
      }
      const att: Mail.Attachment = { path: resolved, filename: a.filename || path.basename(resolved) };
      if (a.contentType) att.contentType = a.contentType;
      return att;
    }
    if (a.content === undefined) {
      throw new Error(`첨부 ${i + 1}: path 또는 content 중 하나는 필요합니다.`);
    }
    const att: Mail.Attachment = {
      filename: a.filename || `attachment-${i + 1}`,
      content: a.encoding === 'base64' ? Buffer.from(a.content, 'base64') : a.content,
    };
    if (a.contentType) att.contentType = a.contentType;
    return att;
  });
}

/** "a@x.com, b@y.com" 또는 배열을 배열로 정규화 */
export function toAddressArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : value.split(/[,;]/);
  return list.map((s) => s.trim()).filter(Boolean);
}
