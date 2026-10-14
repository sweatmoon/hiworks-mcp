import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db/client.js';
import { buildDailyBrief, createTask, findActionableEmails, getReplyContext, getTask, listTasks, taskSummaryCounts, updateTask } from '../tasks/service.js';
import { errorResult, jsonResult } from '../tools/common.js';

const statusEnum = z.enum(['todo', 'doing', 'waiting', 'done', 'cancelled']);
const priorityEnum = z.enum(['low', 'normal', 'high', 'urgent']);

/** 업무관리(할 일) 도구. 에이전트(Claude)가 메일을 읽고 판단해 등록·갱신한다. 서버 쪽 LLM 은 쓰지 않는다. */
export function registerTaskTools(server: McpServer, db: Db): void {
  server.registerTool(
    'find_actionable_emails',
    {
      title: '할 일 후보 메일 찾기',
      description:
        '기간 내 수신 메일 중 요청·기한 표현이 있고 아직 할 일로 등록되지 않았으며 내가 답장하지 않은 메일을 돌려줍니다 (규칙 기반 후보). ' +
        '각 후보의 본문(snippet)과 기한 힌트를 읽고, 실제 할 일이면 create_task 로 등록하세요. 광고·자동 알림은 제외돼 있습니다.',
      inputSchema: {
        since: z.string().optional().describe('YYYY-MM-DD (기본: 7일 전)'),
        before: z.string().optional().describe('YYYY-MM-DD (기본: 오늘)'),
        includeLinked: z.boolean().optional().describe('이미 할 일이 연결된 메일도 포함 (기본 false)'),
        includeReplied: z.boolean().optional().describe('내가 이미 답장한 스레드도 포함 (기본 false)'),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (params) => {
      try {
        const emails = await findActionableEmails(db, params);
        return jsonResult({ success: true, count: emails.length, emails });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'create_task',
    {
      title: '할 일 등록',
      description:
        '할 일을 등록합니다. 메일에서 비롯된 일이면 sourceEmailId 를 꼭 넣으세요 (요청자·사업·스레드가 자동으로 채워지고 근거가 남습니다). ' +
        '같은 메일/스레드에 이미 열린 할 일이 있는지 list_tasks(sourceEmailId) 로 먼저 확인하세요.',
      inputSchema: {
        title: z.string().min(1).describe('한 줄 제목 (동사형: "~ 회신", "~ 제출")'),
        description: z.string().optional().describe('무엇을, 누구에게, 왜. 메일에 적힌 사실만'),
        dueDate: z.string().optional().describe('YYYY-MM-DD. 메일에 기한이 명시된 경우만. 추정이면 meta.dueSource 에 근거를 적을 것'),
        priority: priorityEnum.optional(),
        status: statusEnum.optional(),
        projectName: z.string().optional(),
        requester: z.string().optional(),
        requesterEmail: z.string().optional(),
        sourceEmailId: z.number().int().optional(),
        notes: z.string().optional(),
        meta: z.record(z.unknown()).optional().describe('예: {"dueSource":"본문 \\"9/5까지\\""}'),
      },
    },
    async (params) => {
      try {
        return jsonResult({ success: true, task: await createTask(db, params) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'update_task',
    {
      title: '할 일 갱신',
      description: '상태(todo/doing/waiting/done/cancelled), 마감, 우선순위, 제목, 메모를 바꿉니다. appendNote 는 기존 메모 뒤에 시각과 함께 덧붙입니다.',
      inputSchema: {
        id: z.number().int(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: statusEnum.optional(),
        priority: priorityEnum.optional(),
        dueDate: z.string().nullable().optional().describe('YYYY-MM-DD, null 이면 마감 제거'),
        projectName: z.string().nullable().optional(),
        requester: z.string().nullable().optional(),
        notes: z.string().optional().describe('메모 전체 교체'),
        appendNote: z.string().optional().describe('메모 덧붙이기'),
        sourceEmailId: z.number().int().nullable().optional(),
      },
    },
    async ({ id, ...input }) => {
      try {
        const task = await updateTask(db, id, input);
        if (!task) return jsonResult({ success: false, error: `할 일을 찾을 수 없습니다: ${id}` });
        return jsonResult({ success: true, task });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'list_tasks',
    {
      title: '할 일 목록',
      description: '할 일을 조회합니다. status 를 주지 않으면 열린 것(todo/doing/waiting)만. 기본 정렬은 마감 임박 → 우선순위.',
      inputSchema: {
        status: z.array(statusEnum).optional(),
        project: z.string().optional(),
        priority: z.array(priorityEnum).optional(),
        dueBefore: z.string().optional().describe('YYYY-MM-DD 이하'),
        dueAfter: z.string().optional(),
        overdueOnly: z.boolean().optional(),
        query: z.string().optional().describe('제목/설명/메모 부분 일치'),
        requester: z.string().optional(),
        sourceEmailId: z.number().int().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        sort: z.enum(['due', 'priority', 'updated', 'created']).optional(),
      },
    },
    async (params) => {
      try {
        const r = await listTasks(db, params);
        return jsonResult({ success: true, ...r, countsByStatus: await taskSummaryCounts(db) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'get_task',
    {
      title: '할 일 상세',
      description: '할 일 하나와 근거 메일 본문, 같은 스레드의 메일 목록을 돌려줍니다.',
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => {
      try {
        const r = await getTask(db, id);
        if (!r) return jsonResult({ success: false, error: `할 일을 찾을 수 없습니다: ${id}` });
        return jsonResult({ success: true, ...r });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'daily_brief',
    {
      title: '일일 브리핑 자료',
      description:
        '오늘의 브리핑 원자료를 돌려줍니다: 지연된 할 일, 오늘 마감, 임박(soonDays), 진행 중, 대기 중, 새 할 일 후보 메일, 최근 완료, 동기화 상태. ' +
        '이 자료를 읽고 사람에게 보여줄 요약을 작성하세요. 새 후보 메일은 등록 여부를 사용자에게 제안하세요.',
      inputSchema: {
        date: z.string().optional().describe('YYYY-MM-DD (기본 오늘)'),
        soonDays: z.number().int().min(1).max(30).optional().describe('임박 기준 일수 (기본 3)'),
        lookbackDays: z.number().int().min(1).max(30).optional().describe('새 후보 메일을 볼 기간 (기본 1일)'),
      },
    },
    async (params) => {
      try {
        return jsonResult({ success: true, ...(await buildDailyBrief(db, params)) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'get_reply_context',
    {
      title: '답장 맥락 조회',
      description:
        '답장 초안을 쓰기 위한 맥락(원문 전체, 스레드, 같은 상대에게 내가 최근 보낸 메일, 제안 제목)을 돌려줍니다. ' +
        '이 서버는 메일을 보내지 않습니다. 초안은 사용자에게 보여 확인을 받고, 발송은 로컬 hiworks 서버의 reply_email 로 합니다.',
      inputSchema: {
        taskId: z.number().int().optional(),
        emailId: z.number().int().optional().describe('taskId 대신 메일 id 로 직접 지정'),
      },
    },
    async (params) => {
      try {
        const r = await getReplyContext(db, params);
        if (!r) return jsonResult({ success: false, error: '할 일 또는 메일을 찾을 수 없습니다.' });
        return jsonResult({ success: true, ...r });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
