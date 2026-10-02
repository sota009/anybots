import type { Pool } from 'pg';
import { z } from 'zod';
import { OAuthPilot } from './oauth.js';

export function oauthFromEnvironment(pool: Pool, env: NodeJS.ProcessEnv = process.env): OAuthPilot | undefined {
  if (!env.OAUTH_ISSUER) return undefined;
  let redirectUris: string[];
  try { redirectUris = z.array(z.string().min(1)).min(1).max(4).parse(JSON.parse(env.OAUTH_REDIRECT_URIS ?? 'null')); }
  catch { throw new Error('OAUTH_REDIRECT_URIS must be a JSON array of exact approved callback URLs'); }
  return new OAuthPilot(pool, { issuer: env.OAUTH_ISSUER, redirectUris,
    allowInsecureLocalhost: env.OAUTH_ALLOW_HTTP_LOCALHOST === 'true' && env.NODE_ENV !== 'production' });
}
