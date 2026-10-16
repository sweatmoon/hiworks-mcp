import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** 모든 도구가 공통으로 받는 계정 인자. 생략하면 환경변수를 쓴다. */
export const credentialShape = {
  username: z.string().optional().describe('하이웍스 이메일 주소. 생략 시 HIWORKS_USERNAME 환경변수 사용'),
  password: z.string().optional().describe('하이웍스 비밀번호. 생략 시 HIWORKS_PASSWORD 환경변수 사용'),
};

export const messageIdShape = {
  messageId: z
    .string()
    .describe(
      '메일 식별자. search_email / check_new_emails 결과의 uid 가 가장 빠르다. 메일 순번(msgNum)이나 Message-ID 헤더도 받는다.'
    ),
};

export function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function errorResult(error: unknown, extra: Record<string, unknown> = {}): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ success: false, error: message, ...extra }) }],
  };
}

export function truncate(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (maxLength <= 0 || text.length <= maxLength) return { text, truncated: false };
  return { text: `${text.slice(0, maxLength)}\n…(이하 ${text.length - maxLength}자 생략)`, truncated: true };
}
