export interface AttachmentInfo {
  /** 메일 내 첨부 순서 (0부터) */
  index: number;
  filename: string;
  contentType: string;
  size: number;
}

export interface EmailHeader {
  /** Message-ID 헤더. 없으면 POP3 UID */
  id: string;
  /** POP3 서버가 부여한 고유 ID. read_email 에 그대로 넘기면 가장 빠르다 */
  uid: string;
  /** 현재 메일함에서의 순번 (1부터). 메일이 삭제되면 바뀔 수 있다 */
  msgNum: number;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  /** KST(+09:00) ISO 8601 문자열 */
  date: string;
  /** 메일 크기 (bytes) */
  size?: number;
  hasAttachments?: boolean;
}

export interface Email extends EmailHeader {
  replyTo?: string;
  content: string;
  html?: string;
  attachments: AttachmentInfo[];
}

export interface SearchEmailResponse {
  success: boolean;
  /** 조건에 맞아 반환된 메일 */
  emails: EmailHeader[];
  /** 서버의 전체 메일 수 */
  total?: number;
  /** 이번 검색에서 헤더를 조회한 메일 수 */
  scanned?: number;
  error?: string;
}

export interface ReadEmailResponse {
  success: boolean;
  email?: Email;
  error?: string;
}

export interface SendEmailResponse {
  success: boolean;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  error?: string;
}

export interface NewEmailsResponse {
  success: boolean;
  emails: EmailHeader[];
  /** 이번 호출에서 처음 확인한 메일 수 (limit 과 무관) */
  newCount: number;
  /** 최초 실행 여부 (기준점만 잡은 경우) */
  firstRun: boolean;
  /** 기록된 UID 수 */
  trackedCount: number;
  error?: string;
}
