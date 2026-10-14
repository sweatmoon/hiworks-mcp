import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { count, sql } from 'drizzle-orm';
import { PACKAGE_NAME, PACKAGE_VERSION, serviceConfig } from '../config.js';
import { getDb } from '../db/client.js';
import { emails } from '../db/schema.js';
import { getEmailById, getThread, searchEmails } from '../search/query.js';
import { getStatistics } from '../stats/statistics.js';
import { importMessages } from '../sync/import.js';
import { runSync } from '../sync/runner.js';
import { listSyncStates, recentRuns } from '../sync/state.js';
import { extractWorkActivities } from '../worklog/extract.js';
import { generateDailyWorklog, getWorklog } from '../worklog/generate.js';
import { hasAnthropicCredentials } from '../worklog/llm.js';
import { errorResult, jsonResult } from '../tools/common.js';
import { formatKST } from '../utils/date.js';

const dateShape = {
  since: z.string().describe('시작일 (포함). YYYY-MM-DD (KST) 또는 ISO 8601'),
  before: z.string().describe('종료일 (포함). YYYY-MM-DD (KST) 또는 ISO 8601'),
};

const searchShape = {
  query: z.string().optional().describe('제목·본문·보낸사람·받는사람 부분 일치 (공백으로 나눈 단어는 모두 포함돼야 함). 한글 부분 일치 지원'),
  from: z.string().optional().describe('보낸사람 이름/주소 부분 일치'),
  to: z.string().optional().describe('받는사람 주소 부분 일치'),
  subject: z.string().optional().describe('제목 부분 일치'),
  since: z.string().optional().describe('시작일 (포함). YYYY-MM-DD (KST)'),
  before: z.string().optional().describe('종료일 (포함). YYYY-MM-DD (KST)'),
  hasAttachments: z.boolean().optional(),
  project: z.string().optional().describe('사업명(project_name) 정확히 일치'),
  limit: z.number().int().min(1).max(200).optional().describe('페이지 크기 (기본 20)'),
  offset: z.number().int().min(0).optional().describe('건너뛸 개수'),
  sort: z.enum(['date_desc', 'date_asc', 'relevance']).optional().describe('정렬 (기본 date_desc)'),
};

function todayKST(): string {
  return formatKST(new Date()).slice(0, 10);
}

function daysAgoKST(days: number): string {
  return formatKST(new Date(Date.now() - days * 86400000)).slice(0, 10);
}

/** 요청마다 새로 만드는 MCP 서버 (stateless Streamable HTTP). */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: `${PACKAGE_NAME}-remote`, version: PACKAGE_VERSION });
  const db = getDb();

  server.registerTool(
    'sync_emails',
    {
      title: '메일 동기화 실행',
      description:
        '하이웍스 POP3 받은편지함을 지금 동기화합니다 (Worker 가 주기적으로 하는 작업을 즉시 실행). ' +
        '동시 실행은 PostgreSQL 잠금으로 막히며, 이미 실행 중이면 acquired=false 를 돌려줍니다.',
      inputSchema: {
        sources: z.array(z.enum(['pop3', 'webmail'])).optional().describe('동기화할 수집원 (기본: 설정된 전체)'),
        force: z.boolean().optional().describe('실패 후 백오프 대기 중이어도 강제 실행'),
      },
    },
    async ({ sources, force }) => {
      try {
        const summary = await runSync(db, { sources, force });
        return jsonResult({ success: true, ...summary });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'search_emails',
    {
      title: '메일 검색',
      description: 'PostgreSQL 에 동기화된 발신·수신 메일을 검색합니다. 날짜 범위, 조건, 페이지네이션(limit/offset)을 지원합니다. 본문은 read_email 로 읽으세요.',
      inputSchema: { ...searchShape, direction: z.enum(['sent', 'received']).optional().describe('발신/수신 필터') },
    },
    async (params) => {
      try {
        return jsonResult({ success: true, ...(await searchEmails(db, params)) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'get_sent_emails',
    {
      title: '보낸 메일 조회',
      description: '사용자가 보낸 메일(direction=sent)만 조회합니다. 웹메일 백업 가져오기 또는 숨은참조 사본으로 수집된 메일입니다.',
      inputSchema: searchShape,
    },
    async (params) => {
      try {
        return jsonResult({ success: true, ...(await searchEmails(db, { ...params, direction: 'sent' })) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'read_email',
    {
      title: '메일 읽기',
      description: '메일 한 통의 본문·첨부 목록을 읽습니다. includeThread=true 면 같은 스레드의 다른 메일 목록도 함께 돌려줍니다.',
      inputSchema: {
        id: z.number().int().describe('search_emails 결과의 id'),
        includeHtml: z.boolean().optional(),
        maxLength: z.number().int().min(0).optional().describe('본문 최대 글자 수 (기본 20000, 0이면 무제한)'),
        includeThread: z.boolean().optional(),
      },
    },
    async ({ id, includeHtml, maxLength, includeThread }) => {
      try {
        const email = await getEmailById(db, id, { includeHtml, maxLength });
        if (!email) return jsonResult({ success: false, error: `메일을 찾을 수 없습니다: ${id}` });
        const thread = includeThread ? await getThread(db, email.threadKey) : undefined;
        return jsonResult({ success: true, email, thread });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'get_email_statistics',
    {
      title: '메일 통계',
      description: '기간별 발신·수신 건수, 일/주/월 추이, 주요 발신자·수신자, 사업별 건수, 미처리 요청 후보를 돌려줍니다.',
      inputSchema: {
        since: dateShape.since.optional().describe('기본: 30일 전'),
        before: dateShape.before.optional().describe('기본: 오늘'),
        granularity: z.enum(['day', 'week', 'month']).optional(),
        topN: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ since, before, granularity, topN }) => {
      try {
        const stats = await getStatistics(db, {
          since: since ?? daysAgoKST(30),
          before: before ?? todayKST(),
          granularity,
          topN,
          selfEmail: serviceConfig.selfEmail,
        });
        return jsonResult({ success: true, ...stats });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'extract_work_activities',
    {
      title: '업무 활동 추출',
      description:
        '특정 날짜의 메일에서 수행 업무(발신 중심)와 요청사항(수신)을 추출해 work_activities 에 저장합니다. ' +
        '각 활동은 근거 메일 id 를 가지며, 근거가 없거나 확신이 낮으면 needs_review=true 로 표시됩니다. mode=rules 는 LLM 없이 제목 기반 초안만 만듭니다.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD (KST)'),
        mode: z.enum(['llm', 'rules']).optional().describe('기본 llm (ANTHROPIC_API_KEY 필요)'),
        maxThreads: z.number().int().min(1).max(200).optional().describe('LLM 에 보낼 최대 스레드 수 (기본 40)'),
      },
    },
    async ({ date, mode, maxThreads }) => {
      try {
        const r = await extractWorkActivities(db, date, { mode, maxThreads });
        return jsonResult({ success: true, ...r });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'generate_daily_worklog',
    {
      title: '일일 업무일지 생성',
      description:
        '지정한 날짜의 업무일지를 생성해 daily_worklogs 에 저장하고 Markdown/JSON 으로 돌려줍니다. ' +
        '기본적으로 활동을 다시 추출하며, reuseActivities=true 면 저장된 활동으로만 작성합니다. 메일 근거가 없는 내용은 [확인 필요] 로 표시됩니다.',
      inputSchema: {
        date: z.string().optional().describe('YYYY-MM-DD (KST). 기본: 오늘'),
        mode: z.enum(['llm', 'rules']).optional(),
        reuseActivities: z.boolean().optional(),
        format: z.enum(['markdown', 'json', 'both']).optional().describe('기본 both'),
      },
    },
    async ({ date, mode, reuseActivities, format = 'both' }) => {
      try {
        const r = await generateDailyWorklog(db, date ?? todayKST(), { mode, reuseActivities });
        return jsonResult({
          success: true,
          workDate: r.worklog.workDate,
          updatedAt: formatKST(r.worklog.updatedAt),
          markdown: format !== 'json' ? r.markdown : undefined,
          json: format !== 'markdown' ? r.json : undefined,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'get_daily_worklog',
    {
      title: '저장된 업무일지 조회',
      description: '이미 생성된 업무일지를 조회합니다.',
      inputSchema: { date: z.string().describe('YYYY-MM-DD'), format: z.enum(['markdown', 'json', 'both']).optional() },
    },
    async ({ date, format = 'both' }) => {
      try {
        const w = await getWorklog(db, date);
        if (!w) return jsonResult({ success: false, error: `${date} 업무일지가 없습니다. generate_daily_worklog 로 생성하세요.` });
        return jsonResult({ success: true, workDate: w.workDate, updatedAt: formatKST(w.updatedAt), markdown: format !== 'json' ? w.content : undefined, json: format !== 'markdown' ? w.contentJson : undefined });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'get_sync_status',
    {
      title: '동기화 상태',
      description: '수집원별 마지막 동기화 시각·상태·오류, 최근 실행 기록, DB 에 저장된 메일 수를 돌려줍니다.',
      inputSchema: { runs: z.number().int().min(0).max(50).optional().describe('최근 실행 기록 수 (기본 10)') },
    },
    async ({ runs = 10 }) => {
      try {
        const states = await listSyncStates(db);
        const history = await recentRuns(db, runs);
        const counts = await db
          .select({ direction: emails.direction, count: count(), latest: sql<string | null>`max(coalesce(${emails.sentAt}, ${emails.receivedAt}))` })
          .from(emails)
          .groupBy(emails.direction);
        return jsonResult({
          success: true,
          now: formatKST(new Date()),
          sentSyncMode: serviceConfig.sentSyncMode,
          llmAvailable: hasAnthropicCredentials(),
          sources: states.map((s) => ({
            source: s.source,
            status: s.status,
            lastSyncAt: s.lastSyncAt ? formatKST(s.lastSyncAt) : null,
            lastSuccessAt: s.lastSuccessAt ? formatKST(s.lastSuccessAt) : null,
            lastUid: s.lastUid,
            errorMessage: s.errorMessage,
            consecutiveFailures: s.consecutiveFailures,
            nextRetryAt: s.nextRetryAt ? formatKST(s.nextRetryAt) : null,
            stats: s.stats,
          })),
          recentRuns: history.map((r) => ({
            id: r.id,
            source: r.source,
            status: r.status,
            startedAt: formatKST(r.startedAt),
            finishedAt: r.finishedAt ? formatKST(r.finishedAt) : null,
            newCount: r.newCount,
            skippedCount: r.skippedCount,
            errorMessage: r.errorMessage,
          })),
          emailCounts: counts.map((c) => ({ direction: c.direction, count: c.count, latest: c.latest ? formatKST(new Date(c.latest)) : null })),
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'import_emails',
    {
      title: '메일 파일 가져오기',
      description:
        '하이웍스 편지함 백업(EML ZIP), 개별 .eml, mbox 파일을 DB 로 가져옵니다. 보낸메일함 백업은 direction=sent 로 지정하세요. ' +
        '큰 파일은 HTTP POST /import 엔드포인트를 쓰는 편이 낫습니다 (base64 는 20MB 까지).',
      inputSchema: {
        contentBase64: z.string().describe('파일 내용 base64'),
        filename: z.string().optional(),
        direction: z.enum(['sent', 'received']).optional().describe('생략 시 발신자가 본인이면 sent'),
      },
    },
    async ({ contentBase64, filename, direction }) => {
      try {
        if (contentBase64.length > 20 * 1024 * 1024 * 1.4) throw new Error('base64 입력이 너무 큽니다. /import 엔드포인트를 사용하세요.');
        const buf = Buffer.from(contentBase64, 'base64');
        const r = await importMessages(db, buf, { filename, direction, selfEmail: serviceConfig.selfEmail });
        return jsonResult({ success: r.failed === 0 || r.newCount > 0, ...r });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ChatGPT 커넥터 호환 도구 (search / fetch)
  server.registerTool(
    'search',
    {
      title: 'Search (ChatGPT 호환)',
      description: '메일을 키워드로 검색해 id, title, url 목록을 돌려줍니다. ChatGPT 커넥터 규약용. 상세 검색은 search_emails 를 쓰세요.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      try {
        const r = await searchEmails(db, { query, limit: 20, sort: 'relevance' });
        return jsonResult({
          results: r.emails.map((e) => ({ id: String(e.id), title: `${e.direction === 'sent' ? '[발신]' : '[수신]'} ${e.subject} (${e.date.slice(0, 10)})`, url: `email://${e.id}` })),
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'fetch',
    {
      title: 'Fetch (ChatGPT 호환)',
      description: 'search 결과의 id 로 메일 본문을 가져옵니다.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const email = await getEmailById(db, Number(id));
        if (!email) return jsonResult({ error: `not found: ${id}` });
        return jsonResult({
          id: String(email.id),
          title: email.subject,
          text: `From: ${email.sender}\nTo: ${email.to.join(', ')}\nDate: ${email.date}\n\n${email.bodyText}`,
          url: `email://${email.id}`,
          metadata: { direction: email.direction, project: email.projectName, attachments: email.attachments.map((a) => a.filename) },
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // 최근 메일 1건 확인용 보조 (연결 점검)
  server.registerTool(
    'ping',
    { title: '연결 확인', description: '서버 버전과 DB 연결 상태를 돌려줍니다.', inputSchema: {} },
    async () => {
      try {
        const [row] = await db.select({ n: count() }).from(emails);
        return jsonResult({ success: true, version: PACKAGE_VERSION, emails: row?.n ?? 0, time: formatKST(new Date()) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}
