import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Db } from '../db/client.js';
import { listAccounts, withAccount, type Account } from '../account.js';

/**
 * 한 연결에서 여러 메일함 (2026-11-17 사용자 결정 "한 연결에서 둘 다" — 악티보 과장이면서 오토마인드 대표라
 * 두 회사 메일을 한 번에 보고 분석).
 *
 * Railway 변수 MAILBOX_LINKS = "주인계정:붙일계정,…" (예: main:automind). 붙일 계정은 서버에 등록된 계정(동기화 대상)이어야 한다.
 * 같은 사람의 다른 메일함만 붙인다 — 다른 사람 메일함을 보는 것은 위임 읽기(DELEGATE_READ, 기한 있음)로.
 *
 * 붙인 메일함이 있으면 모든 도구에 `mailbox` 인자를 더한다:
 *  - 목록 도구(search_emails·get_sent_emails·search·find_actionable_emails): 기본 모든 메일함을 합쳐 날짜순, 결과마다 mailbox
 *  - 메일·할 일 id 로 찾는 도구: 그 id 가 든 메일함에서 자동으로 (id 는 메일함 사이에 겹치지 않음)
 *  - 메일함마다 따로인 도구(통계·업무일지·브리핑·할 일 목록·동기화 상태 등): 기본 모든 메일함, 결과는 메일함별로
 *  - 새로 만드는 도구(create_task·create_draft·import_emails): 기본 주인 메일함(또는 원래 메일의 메일함), mailbox 로 고름
 */

export interface MailboxLink {
  owner: string;
  linked: string;
}

export function parseMailboxLinks(raw: string | undefined = process.env['MAILBOX_LINKS']): MailboxLink[] {
  const out: MailboxLink[] = [];
  for (const part of String(raw ?? '').split(',')) {
    const m = /^\s*([a-z0-9_-]+)\s*:\s*([a-z0-9_-]+)\s*$/i.exec(part);
    if (!m) continue;
    const owner = m[1]!.toLowerCase();
    const linked = m[2]!.toLowerCase();
    if (owner === linked || out.some((l) => l.owner === owner && l.linked === linked)) continue;
    out.push({ owner, linked });
  }
  return out;
}

/** 이 계정이 쓰는 메일함들 — 자기 메일함이 먼저, 그다음 붙인 메일함(서버에 없는 계정은 뺀다) */
export function mailboxesFor(owner: Account): Account[] {
  const all = listAccounts(process.env, { requireToken: false });
  const extra = parseMailboxLinks()
    .filter((l) => l.owner === owner.key)
    .map((l) => all.find((a) => a.key === l.linked))
    .filter((a): a is Account => Boolean(a));
  return [owner, ...extra.filter((a, i) => a.key !== owner.key && extra.findIndex((b) => b.key === a.key) === i)];
}

const MERGE_LIST = new Set(['search_emails', 'get_sent_emails', 'search', 'find_actionable_emails']);
const BY_EMAIL_ID: Record<string, string> = {
  read_email: 'id',
  read_attachment: 'emailId',
  attachment_download_link: 'emailId',
  fetch: 'id',
  get_reply_context: 'emailId',
  create_task: 'sourceEmailId',
  create_draft: 'replyToEmailId',
};
const BY_TASK_ID: Record<string, string> = { get_task: 'id', update_task: 'id', get_reply_context: 'taskId' };
const FAN_OUT = new Set([
  'get_email_statistics',
  'extract_work_activities',
  'generate_daily_worklog',
  'get_daily_worklog',
  'get_sync_status',
  'sync_emails',
  'list_tasks',
  'daily_brief',
  'daily_activity',
  'ping',
]);
/** mailbox 인자를 더하지 않는 도구 (다른 사람 메일함 위임 읽기는 그 자체로 계정을 고른다) */
const UNTOUCHED = /^delegate_/;

const textOf = (r: CallToolResult): string => {
  const c = r.content?.[0];
  return c && c.type === 'text' ? c.text : '';
};
const parse = (r: CallToolResult): Record<string, unknown> => {
  try {
    return JSON.parse(textOf(r)) as Record<string, unknown>;
  } catch {
    return { raw: textOf(r) };
  }
};
const json = (payload: unknown, isError = false): CallToolResult => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(payload) }] });

/** id 가 든 메일함 (쓸 수 있는 메일함 안에서만). 없으면 null */
async function ownerOf(db: Db, table: 'emails' | 'tasks', id: unknown, boxes: Account[]): Promise<Account | null> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const res = table === 'emails' ? await db.execute(sql`select account from emails where id = ${n}`) : await db.execute(sql`select account from tasks where id = ${n}`);
  const key = (res.rows?.[0] as { account?: string } | undefined)?.account;
  return boxes.find((b) => b.key === key) ?? null;
}

export function emailOwnerResolver(db: Db, boxes: Account[]): (emailId: number) => Promise<Account | null> {
  return (emailId) => ownerOf(db, 'emails', emailId, boxes);
}

/**
 * server.registerTool 을 감싸 mailbox 인자와 메일함 고르기를 더한다. 붙인 메일함이 없으면 아무것도 바꾸지 않는다.
 * buildMcpServer 가 도구를 등록하기 전에 부른다.
 */
export function enableMailboxes(server: McpServer, db: Db, boxes: Account[]): void {
  if (boxes.length < 2) return;
  const primary = boxes[0]!;
  const label = (a: Account) => a.username.toLowerCase();
  const names = boxes.map(label);
  const pick = (value: unknown): Account | 'all' | null => {
    const v = String(value ?? '').trim().toLowerCase();
    if (!v) return null;
    if (v === 'all' || v === '전체') return 'all';
    // 주소 전체, 계정 키, 또는 회사 도메인 이름(activo·automind) — 아이디(@ 앞)는 메일함마다 같을 수 있어 받지 않는다
    return boxes.find((b) => b.key === v || label(b) === v || label(b).split('@')[1] === v || label(b).split('@')[1]?.split('.')[0] === v) ?? (() => {
      throw new Error(`모르는 메일함입니다: ${value}. 쓸 수 있는 메일함: all, ${names.join(', ')}`);
    })();
  };

  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, config: Record<string, unknown>, handler: (params: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>) => {
    if (UNTOUCHED.test(name)) return original(name, config, handler);
    const listing = MERGE_LIST.has(name) || FAN_OUT.has(name);
    const describe = listing
      ? `메일함 고르기: all(기본, 모든 메일함 — ${names.join(', ')}) 또는 그중 하나(주소·회사 이름)`
      : BY_EMAIL_ID[name] || BY_TASK_ID[name]
        ? `메일함 (선택): 비우면 메일·할 일 id 가 든 메일함에서 자동으로, 없으면 ${label(primary)}. 쓸 수 있는 메일함: ${names.join(', ')}`
        : `메일함 (선택): 비우면 ${label(primary)}. 쓸 수 있는 메일함: ${names.join(', ')}`;
    const inputSchema = { ...((config.inputSchema as Record<string, unknown>) ?? {}), mailbox: z.string().optional().describe(describe) };
    const description = `${String(config.description ?? '')} [메일함 ${boxes.length}개: ${names.join(', ')} — mailbox 인자로 고름]`;

    const run = (box: Account, params: Record<string, unknown>, extra: unknown) => withAccount(box, () => handler(params, extra));

    const wrapped = async (all: Record<string, unknown>, extra: unknown): Promise<CallToolResult> => {
      const { mailbox, ...params } = all;
      let chosen: Account | 'all' | null;
      try {
        chosen = pick(mailbox);
      } catch (error) {
        return json({ success: false, error: (error as Error).message }, true);
      }
      // 하나를 골랐으면 그 메일함에서
      if (chosen && chosen !== 'all') return run(chosen, params, extra);

      // id 로 찾는 도구: id 가 든 메일함
      const emailKey = BY_EMAIL_ID[name];
      const taskKey = BY_TASK_ID[name];
      if (emailKey || taskKey) {
        const owner = (taskKey && params[taskKey] !== undefined ? await ownerOf(db, 'tasks', params[taskKey], boxes) : null) ?? (emailKey && params[emailKey] !== undefined ? await ownerOf(db, 'emails', params[emailKey], boxes) : null);
        return run(owner ?? primary, params, extra);
      }
      if (!listing) return run(primary, params, extra);

      // 모든 메일함
      if (MERGE_LIST.has(name)) return mergeLists(name, params, extra);
      const results = [];
      for (const box of boxes) {
        const r = await run(box, params, extra);
        results.push({ mailbox: label(box), ...(r.isError ? { error: true } : {}), ...parse(r) });
      }
      return json({ success: results.every((r) => !('error' in r && r.error === true)), mailboxes: results });
    };

    const mergeLists = async (tool: string, params: Record<string, unknown>, extra: unknown): Promise<CallToolResult> => {
      const limit = Number(params['limit'] ?? 20);
      const offset = Number(params['offset'] ?? 0);
      const per = tool === 'search_emails' || tool === 'get_sent_emails' ? { ...params, offset: 0, limit: Math.min(200, offset + limit) } : params;
      const parts = [];
      for (const box of boxes) {
        const r = await run(box, per, extra);
        if (r.isError) return r;
        parts.push({ box, body: parse(r) });
      }
      if (tool === 'search') {
        const results = parts.flatMap(({ box, body }) => ((body['results'] as Array<Record<string, unknown>>) ?? []).map((x) => ({ ...x, title: `[${label(box)}] ${String(x['title'] ?? '')}` })));
        return json({ results });
      }
      const listKey = 'emails';
      const rows: Array<Record<string, unknown>> = parts.flatMap(({ box, body }) => ((body[listKey] as Array<Record<string, unknown>>) ?? []).map((e) => ({ ...e, mailbox: label(box) })));
      const asc = params['sort'] === 'date_asc';
      if (params['sort'] !== 'relevance') rows.sort((a, b) => (String(a['date'] ?? '') < String(b['date'] ?? '') ? 1 : -1) * (asc ? -1 : 1));
      if (tool === 'find_actionable_emails') {
        return json({ success: true, count: rows.length, emails: rows, mailboxes: names });
      }
      const total = parts.reduce((s, { body }) => s + Number(body['total'] ?? 0), 0);
      return json({
        success: true,
        emails: rows.slice(offset, offset + limit),
        total,
        limit,
        offset,
        mailboxes: parts.map(({ box, body }) => ({ mailbox: label(box), total: Number(body['total'] ?? 0) })),
        ...(offset + limit > 200 ? { note: '모든 메일함을 합친 목록은 앞 200건까지만 정확합니다. 더 뒤는 mailbox 로 하나를 골라 넘기세요.' } : {}),
      });
    };

    return original(name, { ...config, inputSchema, description }, wrapped);
  };
}
