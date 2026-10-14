import path from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { getDb } from './client.js';

const MIGRATION_LOCK_KEY = 'hiworks-mcp-migrate';

/**
 * drizzle 마이그레이션을 적용한다. 여러 서비스가 동시에 기동해도 advisory lock 으로 한 번만 실행된다.
 * 마이그레이션 폴더는 패키지 루트의 drizzle/ 이다 (빌드 결과물과 함께 배포).
 */
export async function runMigrations(): Promise<void> {
  const db = getDb();
  const here = path.dirname(fileURLToPath(import.meta.url));
  // build/db/migrate.js 또는 src/db/migrate.ts 어느 쪽에서든 <root>/drizzle 을 가리킨다.
  const migrationsFolder = path.resolve(here, '..', '..', 'drizzle');
  await db.execute(sql`select pg_advisory_lock(hashtext(${MIGRATION_LOCK_KEY}))`);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await db.execute(sql`select pg_advisory_unlock(hashtext(${MIGRATION_LOCK_KEY}))`);
  }
}
