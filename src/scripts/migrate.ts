#!/usr/bin/env node
import { closeDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

runMigrations()
  .then(async () => {
    console.log('migrations applied');
    await closeDb();
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
