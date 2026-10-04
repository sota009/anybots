import pg from 'pg';
import { buildApp } from './app.js';
import { Relay } from './relay.js';
import { EventSubscriptions } from './events.js';
import { notificationOptions } from './config.js';
import { oauthFromEnvironment } from './oauth-config.js';
import { Signals } from './signals.js';
import { Dispatcher } from './dispatch.js';
import { ProviderDispatcher } from './providers/index.js';
import { notificationBudgetOptions } from './notification-budget.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const host = process.env.HOST ?? '127.0.0.1';
const allowedHosts = process.env.ALLOWED_HOSTS?.split(',').map((value) => value.trim()).filter(Boolean);
if (host !== '127.0.0.1' && host !== '::1' && !allowedHosts?.length) {
  throw new Error('ALLOWED_HOSTS is required when listening on a public interface');
}
const pool = new pg.Pool({ connectionString: databaseUrl });
const notifications = process.env.NOTIFICATIONS_ENABLED === 'true' ? await notificationOptions() : undefined;
const oauth = oauthFromEnvironment(pool);
const directoryEnabled = process.env.DIRECTORY_ENABLED === 'true';
let directory: { pool: pg.Pool; audience: string } | undefined;
if (directoryEnabled) {
  const audience = process.env.DIRECTORY_AUDIENCE;
  if (!audience) throw new Error('DIRECTORY_AUDIENCE is required when DIRECTORY_ENABLED=true');
  const parsed = new URL(audience);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('DIRECTORY_AUDIENCE must be an https origin');
  }
  directory = {
    audience: parsed.origin,
    pool: new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 500,
      allowExitOnIdle: true,
    }),
  };
}
const signals = new Signals(pool);
await signals.start();
const dispatcher = notifications ? new Dispatcher(pool, new ProviderDispatcher(pool, notifications), {
  budget: notificationBudgetOptions(), signals,
  // Never log provider payloads, URLs, authorization, or database errors.
  onError: () => console.error('Notification dispatch unavailable; check database health.'),
}) : undefined;
const app = buildApp(new Relay(pool, { signals, ...(oauth ? { oauthResource: oauth.resource } : {}) }), {
  onEventDiagnostic: diagnostic => console.log(JSON.stringify(diagnostic)),
  ...(allowedHosts ? { allowedHosts } : {}),
  ...(notifications ? { events: new EventSubscriptions(pool, notifications) } : {}),
  ...(oauth ? { oauth } : {}),
  ...(directory ? { directory } : {}),
});
app.addHook('onClose', async () => {
  await dispatcher?.stop();
  await signals.stop();
  await pool.end();
  if (directory) await directory.pool.end();
});
const shutdown = () => { void app.close().catch(() => { process.exitCode = 1; }); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await app.listen({ host, port: Number(process.env.PORT ?? '3000') });
dispatcher?.start();
console.log('Anybots listening. Live provider verification is still required.');
