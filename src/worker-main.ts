import { setTimeout as wait } from 'node:timers/promises';
import pg from 'pg';
import { notificationOptions } from './config.js';
import { ProviderDispatcher } from './providers/index.js';
import { dispatchOne } from './worker.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (process.env.NOTIFICATIONS_ENABLED !== 'true') throw new Error('NOTIFICATIONS_ENABLED must explicitly enable outbound dispatch');
const options = await notificationOptions();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const dispatcher = new ProviderDispatcher(pool, options);
let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
try {
  while (!stopping) {
    try {
      const processed = await dispatchOne(pool, dispatcher);
      if (!processed) await wait(1000);
    } catch {
      // Never log provider payloads, URLs, authorization, or database errors.
      console.error('Notification dispatch unavailable; check database health.');
      await wait(1000);
    }
  }
} finally { await pool.end(); }
