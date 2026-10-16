export interface Config {
  pop3: {
    host: string;
    port: number;
    ssl: boolean;
    timeout: number;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
  };
  /** check_new_emails 가 본 메일 UID 를 기록하는 디렉터리 */
  stateDir: string;
  /** save_attachment 기본 저장 디렉터리 */
  downloadDir: string;
}
