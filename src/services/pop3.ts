import Pop3Command from 'node-pop3';
import { simpleParser, type ParsedMail } from 'mailparser';
import { config, log, type Credentials } from '../config.js';
import { normalizeMessageId } from '../utils/mail.js';

export interface MessageRef {
  msgNum: number;
  uid: string;
  size?: number;
}

/**
 * 하나의 POP3 연결을 감싼다. 도구 한 번 호출 = 세션 하나.
 * UIDL/LIST 결과는 세션 안에서 캐시해서 왕복을 줄인다.
 */
export class Pop3Session {
  private client: Pop3Command;
  private refs: MessageRef[] | null = null;
  private closed = false;

  constructor(private readonly creds: Credentials) {
    this.client = new Pop3Command({
      user: creds.username,
      password: creds.password,
      host: config.pop3.host,
      port: config.pop3.port,
      tls: config.pop3.ssl,
      timeout: config.pop3.timeout,
    });
    // 서버가 비동기로 에러를 흘릴 때 프로세스가 죽지 않도록 한다.
    this.client.on('error', (err: Error) => log('POP3 error event:', err.message));
  }

  /** 서버의 전체 메일 수 */
  async count(): Promise<number> {
    const info = await this.client.STAT();
    const [count] = info.trim().split(/\s+/);
    return Number(count) || 0;
  }

  /**
   * 메일 목록 (msgNum, uid, size). 최신 메일이 뒤에 온다.
   * 세션 내 첫 호출에서만 서버에 UIDL/LIST 를 보낸다.
   */
  async list(): Promise<MessageRef[]> {
    if (this.refs) return this.refs;
    const uidl = await this.client.UIDL();
    const sizes = new Map<number, number>();
    try {
      for (const [num, size] of await this.client.LIST()) {
        sizes.set(Number(num), Number(size));
      }
    } catch (err) {
      log('LIST failed, continuing without sizes:', err);
    }
    this.refs = uidl
      .filter((row) => row.length >= 2)
      .map(([num, uid]) => {
        const msgNum = Number(num);
        const ref: MessageRef = { msgNum, uid };
        const size = sizes.get(msgNum);
        if (size !== undefined) ref.size = size;
        return ref;
      })
      .sort((a, b) => a.msgNum - b.msgNum);
    return this.refs;
  }

  /** 최신 메일부터 역순으로 정렬된 목록 */
  async listNewestFirst(): Promise<MessageRef[]> {
    return [...(await this.list())].reverse();
  }

  /** 헤더만 가져와 파싱한다 (TOP n 0). */
  async headers(msgNum: number): Promise<ParsedMail> {
    const raw = await this.client.TOP(msgNum, 0);
    return simpleParser(raw);
  }

  /** 메일 전체를 가져와 파싱한다 (RETR). */
  async retrieve(msgNum: number): Promise<ParsedMail> {
    const raw = await this.client.RETR(msgNum);
    return simpleParser(raw);
  }

  /**
   * 사용자가 넘긴 식별자로 메일을 찾는다. 식별자는 다음 중 하나:
   *  - POP3 UID (search_email 결과의 uid) → 즉시 매핑
   *  - 메일 순번 (숫자) → 즉시 매핑
   *  - Message-ID 헤더 → 최신 메일부터 헤더를 훑어 찾는다 (scanLimit 까지)
   */
  async resolve(identifier: string, scanLimit = 500): Promise<MessageRef | undefined> {
    const refs = await this.list();
    const trimmed = identifier.trim();

    const byUid = refs.find((r) => r.uid === trimmed);
    if (byUid) return byUid;

    if (/^\d+$/.test(trimmed)) {
      const byNum = refs.find((r) => r.msgNum === Number(trimmed));
      if (byNum) return byNum;
    }

    const wanted = normalizeMessageId(trimmed);
    if (!wanted) return undefined;
    const newest = await this.listNewestFirst();
    for (const ref of newest.slice(0, scanLimit)) {
      try {
        const parsed = await this.headers(ref.msgNum);
        if (normalizeMessageId(parsed.messageId) === wanted) return ref;
      } catch (err) {
        log(`TOP ${ref.msgNum} failed while resolving message id:`, err);
      }
    }
    return undefined;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.QUIT();
    } catch (err) {
      log('QUIT failed:', err);
    }
  }
}

/** 세션을 열고 작업 후 반드시 닫는다. */
export async function withPop3<T>(creds: Credentials, fn: (session: Pop3Session) => Promise<T>): Promise<T> {
  const session = new Pop3Session(creds);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
