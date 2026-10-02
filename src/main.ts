import pg from 'pg';
import { buildApp } from './app.js';
import { Relay } from './relay.js';
import { EventSubscriptions } from './events.js';
import { notificationOptions } from './config.js';
import { oauthFromEnvironment } from './oauth-config.js';

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
const app = buildApp(new Relay(pool, oauth ? { oauthResource: oauth.resource } : {}), {
  ...(allowedHosts ? { allowedHosts } : {}),
  ...(notifications ? { events: new EventSubscriptions(pool, notifications) } : {}),
  ...(oauth ? { oauth } : {}),
});
app.addHook('onClose', () => pool.end());
const shutdown = () => { void app.close().catch(() => { process.exitCode = 1; }); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await app.listen({ host, port: Number(process.env.PORT ?? '3000') });
console.log('Anybots listening. Live provider verification is still required.');
