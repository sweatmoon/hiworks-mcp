declare module 'node-pop3' {
  interface Pop3Config {
    user: string;
    password: string;
    host: string;
    port?: number;
    tls?: boolean;
    timeout?: number;
    tlsOptions?: import('tls').ConnectionOptions;
    servername?: string;
  }

  import { EventEmitter } from 'events';

  export default class Pop3Command extends EventEmitter {
    constructor(config: Pop3Config);
    /** "+OK" 뒤의 정보 문자열. 예: "100 102400" */
    STAT(): Promise<string>;
    LIST(): Promise<string[][]>;
    LIST(msgNum: string | number): Promise<string[]>;
    RETR(msgNum: number | string): Promise<string>;
    DELE(msgNum: number | string): Promise<string>;
    RSET(): Promise<string>;
    NOOP(): Promise<void>;
    QUIT(): Promise<string>;
    UIDL(): Promise<string[][]>;
    UIDL(msgNum: string | number): Promise<string[]>;
    TOP(msgNum: number | string, numLines?: number): Promise<string>;
  }
}
