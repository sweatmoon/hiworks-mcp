#!/usr/bin/env node
/** 로컬 파일(EML/ZIP/mbox)을 DB 로 가져온다. 사용: npm run import -- <파일> [sent|received] */
import fs from 'fs';
import path from 'path';
import { serviceConfig } from '../config.js';
import { closeDb, getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { importFile } from '../sync/import.js';

async function main(): Promise<void> {
  const [file, direction] = process.argv.slice(2);
  if (!file) {
    console.error('사용법: npm run import -- <file.eml|file.zip|file.mbox> [sent|received]');
    process.exit(2);
  }
  if (direction && direction !== 'sent' && direction !== 'received') throw new Error('direction 은 sent 또는 received');
  await runMigrations();
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`파일이 없습니다: ${abs}`);
  let lastLog = 0;
  const r = await importFile(getDb(), abs, {
    filename: path.basename(file),
    direction: direction as 'sent' | 'received' | undefined,
    selfEmail: serviceConfig.selfEmail,
    onProgress: (p) => {
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        console.error(`진행: ${p.files}건 처리 (신규 ${p.newCount}, 중복 ${p.skippedCount}, 실패 ${p.failed})`);
      }
    },
  });
  console.log(JSON.stringify(r, null, 2));
  await closeDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
