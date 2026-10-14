import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config, log } from '../config.js';

interface SeenState {
  username: string;
  updatedAt: string;
  uids: string[];
}

function stateFile(username: string): string {
  const hash = crypto.createHash('sha1').update(username.toLowerCase()).digest('hex').slice(0, 12);
  return path.join(config.stateDir, `seen-${hash}.json`);
}

/** check_new_emails 가 이미 확인한 UID 집합을 읽는다. 파일이 없으면 null (최초 실행). */
export function loadSeen(username: string): Set<string> | null {
  const file = stateFile(username);
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as SeenState;
    return new Set(Array.isArray(data.uids) ? data.uids : []);
  } catch (err) {
    log('Failed to read state file, treating as first run:', err);
    return null;
  }
}

export function saveSeen(username: string, uids: Iterable<string>): void {
  const file = stateFile(username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data: SeenState = {
    username,
    updatedAt: new Date().toISOString(),
    uids: Array.from(uids),
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export function resetSeen(username: string): void {
  const file = stateFile(username);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
