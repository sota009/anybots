import type { Pool } from 'pg';
import { OAuthPilot } from './oauth.js';

export function oauthFromEnvironment(pool: Pool, env: NodeJS.ProcessEnv = process.env): OAuthPilot | undefined {
  if (!env.OAUTH_ISSUER) return undefined;
  return new OAuthPilot(pool, { issuer: env.OAUTH_ISSUER,
    trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? '0'),
    allowInsecureLocalhost: env.OAUTH_ALLOW_HTTP_LOCALHOST === 'true' && env.NODE_ENV !== 'production' });
}
