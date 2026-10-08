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
import { Accounts } from './accounts.js';
import { Network } from './network.js';
import { appOrigin } from './web.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const host = process.env.HOST ?? '127.0.0.1';
const allowedHosts = process.env.ALLOWED_HOSTS?.split(',').map((value) => value.trim()).filter(Boolean);
if (host !== '127.0.0.1' && host !== '::1' && !allowedHosts?.length) {
  throw new Error('ALLOWED_HOSTS is required when listening on a public interface');
}
const pool = new pg.Pool({ connectionString: databaseUrl });
const notifications = process.env.NOTIFICATIONS_ENABLED === 'true' ? notificationOptions() : undefined;
const oauth = oauthFromEnvironment(pool);
const origin = appOrigin();
if (origin && allowedHosts && !allowedHosts.includes(new URL(origin).hostname)) throw new Error('APP_ORIGIN must be one of ALLOWED_HOSTS');
if (oauth && oauth.issuer !== origin) throw new Error('OAUTH_ISSUER must equal APP_ORIGIN, where consent happens');
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? '0');
if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 3) throw new Error('TRUST_PROXY_HOPS must be 0-3');
const signals = new Signals(pool);
await signals.start();
const dispatcher = notifications ? new Dispatcher(pool, new ProviderDispatcher(pool, notifications), {
  budget: notificationBudgetOptions(), signals,
  // Never log provider payloads, URLs, authorization, or database errors.
  onError: () => console.error('Notification dispatch unavailable; check database health.'),
}) : undefined;
const relay = new Relay(pool, { signals, ...(oauth ? { oauthResource: oauth.resource } : {}) });
const web = origin ? {
  origin, trustProxyHops, accounts: new Accounts(pool, { origin }), ...(oauth ? { oauth } : {}),
  network: new Network(pool, relay, {
    mcpUrl: `${origin}/mcp`,
    ...(notifications ? { webhook: { encryptionKey: notifications.encryptionKey, hosts: notifications.webhookHosts ?? [] } } : {}),
  }),
} : undefined;
const app = buildApp(relay, {
  trustProxyHops,
  onEventDiagnostic: diagnostic => console.log(JSON.stringify(diagnostic)),
  ...(allowedHosts ? { allowedHosts } : {}),
  ...(notifications ? { events: new EventSubscriptions(pool, notifications) } : {}),
  ...(oauth ? { oauth } : {}),
  ...(web ? { web } : {}),
});
app.addHook('onClose', async () => {
  await dispatcher?.stop();
  await signals.stop();
  await pool.end();
});
const shutdown = () => { void app.close().catch(() => { process.exitCode = 1; }); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await app.listen({ host, port: Number(process.env.PORT ?? '3000') });
dispatcher?.start();
console.log('knotcat listening. Live provider verification is still required.');
