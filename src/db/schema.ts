import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** PostgreSQL tsvector 컬럼 (drizzle 에 내장 타입이 없어 customType 으로 선언) */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const directionEnum = pgEnum('email_direction', ['sent', 'received']);
export const syncStatusEnum = pgEnum('sync_status', ['idle', 'running', 'ok', 'error']);

export interface RecipientJson {
  name: string;
  address: string;
  kind: 'to' | 'cc' | 'bcc';
}

export const emails = pgTable(
  'emails',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Message-ID 헤더 (꺾쇠 제거, 소문자). 없을 수 있다 */
    messageId: text('message_id'),
    /**
     * 중복 방지 키. Message-ID 가 있으면 "mid:<id>", 없으면 발신자·수신자·제목·일시·본문 앞부분의
     * SHA-256 해시 "fp:<hash>". UNIQUE.
     */
    dedupKey: text('dedup_key').notNull(),
    direction: directionEnum('direction').notNull(),
    /** pop3 | import | webmail | api */
    source: text('source').notNull(),
    /** POP3 UIDL 등 수집원 고유 ID. (source, source_uid) UNIQUE (NULL 제외) */
    sourceUid: text('source_uid'),
    sender: text('sender').notNull().default(''),
    senderEmail: text('sender_email').notNull().default(''),
    /** [{name,address,kind}] */
    recipients: jsonb('recipients').$type<RecipientJson[]>().notNull().default([]),
    /** 검색/통계용 수신자 주소 배열 (소문자) */
    recipientEmails: text('recipient_emails').array().notNull().default([]),
    subject: text('subject').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),
    bodyHtml: text('body_html'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    sizeBytes: integer('size_bytes'),
    /** 스레드 묶음 키: Re:/Fwd: 를 벗긴 제목 소문자 */
    threadKey: text('thread_key').notNull().default(''),
    inReplyTo: text('in_reply_to'),
    references: text('references').array().notNull().default([]),
    /** 규칙 기반 사업명 분류 결과 */
    projectName: text('project_name'),
    /** 공백 토큰 기반 전문검색 벡터 (제목 가중치 A, 본문 B) */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(subject, '')), 'A') || setweight(to_tsvector('simple', left(coalesce(body_text, ''), 100000)), 'B')`
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('emails_dedup_key_uq').on(t.dedupKey),
    uniqueIndex('emails_source_uid_uq')
      .on(t.source, t.sourceUid)
      .where(sql`${t.sourceUid} is not null`),
    index('emails_message_id_idx').on(t.messageId),
    index('emails_direction_sent_at_idx').on(t.direction, t.sentAt),
    index('emails_sender_email_idx').on(t.senderEmail),
    index('emails_thread_key_idx').on(t.threadKey),
    index('emails_project_idx').on(t.projectName),
    index('emails_search_vector_idx').using('gin', t.searchVector),
    index('emails_subject_trgm_idx').using('gin', t.subject.op('gin_trgm_ops')),
    index('emails_body_trgm_idx').using('gin', t.bodyText.op('gin_trgm_ops')),
    index('emails_recipient_emails_idx').using('gin', t.recipientEmails),
  ]
);

export const emailAttachments = pgTable(
  'email_attachments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    emailId: bigint('email_id', { mode: 'number' })
      .notNull()
      .references(() => emails.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    fileSize: integer('file_size').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_attachments_email_id_idx').on(t.emailId)]
);

export const emailSyncState = pgTable('email_sync_state', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** pop3 | import | webmail */
  source: text('source').notNull().unique(),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastUid: text('last_uid'),
  status: syncStatusEnum('status').notNull().default('idle'),
  errorMessage: text('error_message'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** 다음 재시도 허용 시각 (지수 백오프) */
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: text('source').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: syncStatusEnum('status').notNull().default('running'),
    newCount: integer('new_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    errorMessage: text('error_message'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('sync_runs_source_started_idx').on(t.source, t.startedAt)]
);

export const workActivities = pgTable(
  'work_activities',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 대표 근거 메일 */
    emailId: bigint('email_id', { mode: 'number' }).references(() => emails.id, { onDelete: 'set null' }),
    activityDate: date('activity_date').notNull(),
    projectName: text('project_name'),
    /** sent_work | received_request | follow_up | other */
    activityType: text('activity_type').notNull().default('other'),
    description: text('description').notNull(),
    /** 모든 근거 메일 id */
    evidenceEmailIds: bigint('evidence_email_ids', { mode: 'number' }).array().notNull().default([]),
    threadKey: text('thread_key'),
    /** 근거가 약하거나 모델이 확신하지 못한 항목 */
    needsReview: boolean('needs_review').notNull().default(false),
    confidence: real('confidence'),
    /** llm | rules */
    extractor: text('extractor').notNull().default('llm'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('work_activities_date_idx').on(t.activityDate), index('work_activities_project_idx').on(t.projectName)]
);

export const dailyWorklogs = pgTable('daily_worklogs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workDate: date('work_date').notNull().unique(),
  /** Markdown */
  content: text('content').notNull(),
  /** 구조화 JSON (활동 목록, 요청사항, 확인 필요 항목) */
  contentJson: jsonb('content_json').$type<Record<string, unknown>>().notNull().default({}),
  model: text('model'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type EmailRow = typeof emails.$inferSelect;
export type NewEmailRow = typeof emails.$inferInsert;
export type WorkActivityRow = typeof workActivities.$inferSelect;
export type DailyWorklogRow = typeof dailyWorklogs.$inferSelect;
