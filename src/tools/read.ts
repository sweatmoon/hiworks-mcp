import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config, log, resolveCredentials } from '../config.js';
import { withPop3, type MessageRef } from '../services/pop3.js';
import { loadSeen, resetSeen, saveSeen } from '../services/state.js';
import { parseDateInput } from '../utils/date.js';
import { attachmentInfos, sanitizeFilename, toEmail, toHeader } from '../utils/mail.js';
import type { EmailHeader, NewEmailsResponse, ReadEmailResponse, SearchEmailResponse } from '../types/mail.js';
import { credentialShape, errorResult, jsonResult, messageIdShape, truncate } from './common.js';

function includesCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    'read_username',
    {
      title: '계정 확인',
      description: '현재 설정된 하이웍스 계정(이메일 주소)과 서버 설정을 확인합니다. 비밀번호는 반환하지 않습니다.',
      inputSchema: credentialShape,
    },
    async ({ username, password }) => {
      try {
        const creds = resolveCredentials(username, password);
        return jsonResult({
          success: true,
          username: creds.username,
          pop3: `${config.pop3.host}:${config.pop3.port}`,
          smtp: `${config.smtp.host}:${config.smtp.port}`,
          stateDir: config.stateDir,
          downloadDir: config.downloadDir,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'search_email',
    {
      title: '메일 검색',
      description:
        '하이웍스 메일함에서 최신 메일부터 조건에 맞는 메일 목록(헤더)을 가져옵니다. ' +
        '조건이 없으면 최신 메일 limit 개를 반환합니다. 본문은 read_email 로 읽으세요. ' +
        'POP3 특성상 서버 검색이 없어 scanLimit 개의 헤더를 내려받아 필터링하므로 오래된 메일은 scanLimit 을 늘려야 합니다.',
      inputSchema: {
        ...credentialShape,
        query: z.string().optional().describe('제목·보낸사람·받는사람 어디든 포함되는 텍스트 (대소문자 무시)'),
        from: z.string().optional().describe('보낸사람에 포함되는 텍스트 (이름 또는 주소 일부)'),
        to: z.string().optional().describe('받는사람/참조에 포함되는 텍스트'),
        subject: z.string().optional().describe('제목에 포함되는 텍스트'),
        since: z.string().optional().describe('이 날짜 이후(포함) 메일만. 예: 2025-01-02 (KST) 또는 ISO 8601'),
        before: z.string().optional().describe('이 날짜 이전(포함) 메일만. 예: 2025-01-31'),
        hasAttachments: z.boolean().optional().describe('true 면 첨부가 있는 메일만'),
        limit: z.number().int().min(1).max(200).optional().describe('반환할 최대 개수 (기본 20)'),
        offset: z.number().int().min(0).optional().describe('조건에 맞는 결과 중 건너뛸 개수 (페이지네이션)'),
        scanLimit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe('최신 메일부터 헤더를 조회할 최대 개수 (기본 200). 클수록 느려집니다.'),
      },
    },
    async ({ username, password, query, from, to, subject, since, before, hasAttachments, limit = 20, offset = 0, scanLimit = 200 }) => {
      try {
        const creds = resolveCredentials(username, password);
        const sinceDate = since ? parseDateInput(since) : undefined;
        const beforeDate = before ? parseDateInput(before, true) : undefined;
        const hasFilter = Boolean(query || from || to || subject || sinceDate || beforeDate || hasAttachments !== undefined);

        const result = await withPop3(creds, async (session) => {
          const refs = await session.listNewestFirst();
          const total = refs.length;
          const emails: EmailHeader[] = [];
          let scanned = 0;
          let skipped = 0;
          let olderStreak = 0;

          // 필터가 없으면 limit+offset 개만 보면 된다.
          const budget = hasFilter ? scanLimit : Math.min(scanLimit, limit + offset);

          for (const ref of refs.slice(0, budget)) {
            scanned++;
            let header: EmailHeader;
            try {
              header = toHeader(await session.headers(ref.msgNum), ref.msgNum, ref.uid, ref.size);
            } catch (err) {
              log(`TOP ${ref.msgNum} failed:`, err);
              continue;
            }

            const mailDate = header.date ? new Date(header.date) : undefined;
            if (sinceDate && mailDate && mailDate < sinceDate) {
              // 메일은 대체로 시간순이므로 기준일보다 오래된 메일이 연속되면 더 볼 필요가 없다.
              if (++olderStreak >= 10) break;
              continue;
            }
            olderStreak = 0;
            if (beforeDate && mailDate && mailDate > beforeDate) continue;
            if (hasAttachments !== undefined && Boolean(header.hasAttachments) !== hasAttachments) continue;
            if (from && !includesCI(header.from, from)) continue;
            if (to && !includesCI(`${header.to} ${header.cc ?? ''}`, to)) continue;
            if (subject && !includesCI(header.subject, subject)) continue;
            if (query && !includesCI(`${header.subject} ${header.from} ${header.to} ${header.cc ?? ''}`, query)) continue;

            if (skipped < offset) {
              skipped++;
              continue;
            }
            emails.push(header);
            if (emails.length >= limit) break;
          }

          return { success: true, emails, total, scanned } satisfies SearchEmailResponse;
        });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error, { emails: [] });
      }
    }
  );

  server.registerTool(
    'read_email',
    {
      title: '메일 읽기',
      description: '메일 한 통의 본문과 첨부 목록을 읽습니다. 첨부 파일 자체는 save_attachment 로 저장하세요.',
      inputSchema: {
        ...credentialShape,
        ...messageIdShape,
        includeHtml: z.boolean().optional().describe('true 면 HTML 본문도 포함 (기본 false)'),
        maxLength: z.number().int().min(0).optional().describe('본문 최대 글자 수 (기본 20000, 0이면 제한 없음)'),
        scanLimit: z.number().int().min(1).max(5000).optional().describe('Message-ID 로 찾을 때 훑을 최대 메일 수 (기본 500)'),
      },
    },
    async ({ username, password, messageId, includeHtml = false, maxLength = 20000, scanLimit = 500 }) => {
      try {
        const creds = resolveCredentials(username, password);
        const result = await withPop3(creds, async (session) => {
          const ref = await session.resolve(messageId, scanLimit);
          if (!ref) {
            return { success: false, error: `메일을 찾을 수 없습니다: ${messageId}` } satisfies ReadEmailResponse;
          }
          const parsed = await session.retrieve(ref.msgNum);
          const email = toEmail(parsed, ref.msgNum, ref.uid, ref.size);
          const body = truncate(email.content, maxLength);
          email.content = body.text;
          if (!includeHtml) delete email.html;
          else if (email.html) email.html = truncate(email.html, maxLength).text;
          return { success: true, email, truncated: body.truncated };
        });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'check_new_emails',
    {
      title: '새 메일 확인',
      description:
        '지난 호출 이후 새로 도착한 메일만 돌려줍니다. 확인한 메일의 UID 를 로컬(HIWORKS_STATE_DIR)에 기록해 다음 호출에서 제외합니다. ' +
        '정기적으로 호출해 새 메일을 요약·분류·알림하는 자동화에 쓰세요. 최초 실행 시에는 기준점만 잡고 최신 limit 개를 돌려줍니다.',
      inputSchema: {
        ...credentialShape,
        limit: z.number().int().min(0).max(200).optional().describe('헤더를 내려받아 돌려줄 최대 개수 (기본 20). 0이면 개수만 센다'),
        markAsSeen: z.boolean().optional().describe('false 면 기록을 갱신하지 않아 다음 호출에도 같은 메일이 나옵니다 (기본 true)'),
        reset: z.boolean().optional().describe('true 면 기록을 지우고 처음부터 다시 시작'),
      },
    },
    async ({ username, password, limit = 20, markAsSeen = true, reset = false }) => {
      try {
        const creds = resolveCredentials(username, password);
        if (reset) resetSeen(creds.username);
        const seen = loadSeen(creds.username);
        const firstRun = seen === null;

        const result = await withPop3(creds, async (session) => {
          const refs = await session.listNewestFirst();
          const fresh: MessageRef[] = firstRun ? refs : refs.filter((r) => !seen!.has(r.uid));
          const toFetch = fresh.slice(0, limit);

          const emails: EmailHeader[] = [];
          for (const ref of toFetch) {
            try {
              emails.push(toHeader(await session.headers(ref.msgNum), ref.msgNum, ref.uid, ref.size));
            } catch (err) {
              log(`TOP ${ref.msgNum} failed:`, err);
            }
          }

          if (markAsSeen) {
            // 서버에 남아있는 UID 만 기록해 파일이 무한히 커지지 않게 한다.
            saveSeen(creds.username, refs.map((r) => r.uid));
          }

          return {
            success: true,
            emails,
            newCount: firstRun ? 0 : fresh.length,
            firstRun,
            trackedCount: refs.length,
          } satisfies NewEmailsResponse;
        });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error, { emails: [], newCount: 0 });
      }
    }
  );

  server.registerTool(
    'list_attachments',
    {
      title: '첨부 목록',
      description: '메일의 첨부 파일 목록(이름, 종류, 크기)을 돌려줍니다.',
      inputSchema: { ...credentialShape, ...messageIdShape },
    },
    async ({ username, password, messageId }) => {
      try {
        const creds = resolveCredentials(username, password);
        const result = await withPop3(creds, async (session) => {
          const ref = await session.resolve(messageId);
          if (!ref) return { success: false, error: `메일을 찾을 수 없습니다: ${messageId}` };
          const parsed = await session.retrieve(ref.msgNum);
          return { success: true, uid: ref.uid, subject: parsed.subject || '', attachments: attachmentInfos(parsed) };
        });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'save_attachment',
    {
      title: '첨부 저장',
      description:
        '메일의 첨부 파일을 로컬 디스크에 저장하고 경로를 돌려줍니다. index 나 filename 을 주지 않으면 모든 첨부를 저장합니다. ' +
        '기본 저장 위치는 HIWORKS_DOWNLOAD_DIR (없으면 ~/Downloads/hiworks-mcp) 입니다.',
      inputSchema: {
        ...credentialShape,
        ...messageIdShape,
        index: z.number().int().min(0).optional().describe('list_attachments 의 index'),
        filename: z.string().optional().describe('저장할 첨부의 파일명 (index 대신 사용 가능)'),
        outputDir: z.string().optional().describe('저장할 디렉터리. 생략 시 기본 다운로드 폴더'),
        overwrite: z.boolean().optional().describe('같은 이름의 파일이 있으면 덮어쓸지 (기본 false, 번호를 붙여 저장)'),
      },
    },
    async ({ username, password, messageId, index, filename, outputDir, overwrite = false }) => {
      try {
        const creds = resolveCredentials(username, password);
        const dir = path.resolve(outputDir || config.downloadDir);
        const result = await withPop3(creds, async (session) => {
          const ref = await session.resolve(messageId);
          if (!ref) return { success: false, error: `메일을 찾을 수 없습니다: ${messageId}` };
          const parsed = await session.retrieve(ref.msgNum);
          const all = parsed.attachments || [];
          const selected = all.filter((a, i) => {
            if (index !== undefined) return i === index;
            if (filename) return (a.filename || '') === filename;
            return true;
          });
          if (selected.length === 0) {
            return { success: false, error: '조건에 맞는 첨부가 없습니다.', attachments: attachmentInfos(parsed) };
          }

          fs.mkdirSync(dir, { recursive: true });
          const saved: Array<{ filename: string; path: string; size: number; contentType: string }> = [];
          for (const [i, att] of selected.entries()) {
            const base = sanitizeFilename(att.filename || `attachment-${i + 1}`);
            let target = path.join(dir, base);
            if (!overwrite && fs.existsSync(target)) {
              const ext = path.extname(base);
              const stem = base.slice(0, base.length - ext.length);
              let n = 1;
              while (fs.existsSync(target)) target = path.join(dir, `${stem} (${n++})${ext}`);
            }
            fs.writeFileSync(target, att.content);
            saved.push({ filename: base, path: target, size: att.size, contentType: att.contentType });
          }
          return { success: true, uid: ref.uid, subject: parsed.subject || '', saved };
        });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
