import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { Config } from './types/config.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export const PACKAGE_NAME: string = pkg.name;
export const PACKAGE_VERSION: string = pkg.version;

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// 하이웍스 기본 서버 설정. 환경변수로 덮어쓸 수 있다 (테스트/다른 호스트용).
export const config: Config = {
  pop3: {
    host: process.env['HIWORKS_POP3_HOST'] || 'pop3s.hiworks.com',
    port: envNumber('HIWORKS_POP3_PORT', 995),
    ssl: envBool('HIWORKS_POP3_TLS', true),
    timeout: envNumber('HIWORKS_POP3_TIMEOUT_MS', 60000),
  },
  smtp: {
    host: process.env['HIWORKS_SMTP_HOST'] || 'smtps.hiworks.com',
    port: envNumber('HIWORKS_SMTP_PORT', 465),
    secure: envBool('HIWORKS_SMTP_SECURE', true),
  },
  stateDir: process.env['HIWORKS_STATE_DIR'] || path.join(os.homedir(), '.hiworks-mcp'),
  downloadDir:
    process.env['HIWORKS_DOWNLOAD_DIR'] || path.join(os.homedir(), 'Downloads', 'hiworks-mcp'),
};

export interface Credentials {
  username: string;
  password: string;
}

/**
 * 도구 인자로 받은 계정 정보와 환경변수를 합쳐 자격 증명을 만든다.
 * 둘 다 없으면 명확한 에러를 던진다.
 */
export function resolveCredentials(username?: string, password?: string): Credentials {
  const user = username || process.env['HIWORKS_USERNAME'] || '';
  const pass = password || process.env['HIWORKS_PASSWORD'] || '';
  if (!user || !pass) {
    throw new Error(
      '하이웍스 계정 정보가 없습니다. HIWORKS_USERNAME / HIWORKS_PASSWORD 환경변수를 설정하거나 username, password 인자를 전달하세요.'
    );
  }
  return { username: user, password: pass };
}

export function log(...args: unknown[]): void {
  if (process.env.NODE_ENV === 'development') {
    console.error(new Date().toISOString(), ...args);
  }
}
