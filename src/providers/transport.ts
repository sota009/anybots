import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

export interface HttpResponse { status: number; body: string; retryAfter?: string }
export interface WebhookTransport {
  post(url: string, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<HttpResponse>;
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Only globally allocated unicast; excludes mapped IPv4 and local ranges.
  return family === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address, 'ipv6');
}

export class WebhookHostNotAllowed extends Error {
  constructor(public readonly hostname: string) { super('webhook_destination_rejected'); }
}

export function validateWebhookUrl(value: string, allowedHosts: readonly string[]): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') ||
      isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('webhook_destination_rejected');
  }
  if (!allowedHosts.includes(url.hostname)) throw new WebhookHostNotAllowed(url.hostname);
  return url;
}

/** DNS is checked anew and pinned to the checked IP for every connection. */
export class PublicHttpsTransport implements WebhookTransport {
  constructor(private readonly allowedHosts: readonly string[], private readonly timeoutMs = 10_000) {}

  async post(value: string, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<HttpResponse> {
    const url = validateWebhookUrl(value, this.allowedHosts);
    if (Buffer.byteLength(body) > 262_144) throw new Error('webhook_payload_too_large');
    return new Promise((resolve, reject) => {
      let finished = false;
      let abort: (() => void) | undefined;
      const cancel = () => { if (!finished) { finished = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); abort?.(); reject(new Error('webhook_aborted')); } };
      const timer = setTimeout(() => { finished = true; signal?.removeEventListener('abort', cancel); abort?.(); reject(new Error('webhook_timeout')); }, this.timeoutMs);
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      const finish = (error?: Error, response?: HttpResponse) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(response!);
      };
      void lookup(url.hostname, { all: true, verbatim: true }).then(addresses => {
        if (finished) return;
        if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) {
          finish(new Error('webhook_destination_rejected')); return;
        }
        const address = addresses[0]!;
        // The URL hostname still controls TLS/SNI. The socket lookup cannot resolve again.
        const req = request(url, {
          method: 'POST', agent: false,
          headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
          lookup: (_host, options, callback) => options.all
            ? callback(null, [address]) : callback(null, address.address, address.family),
        }, response => {
          const chunks: Buffer[] = []; let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 16_384) { req.destroy(new Error('webhook_response_too_large')); return; }
            chunks.push(chunk);
          });
          response.on('error', () => finish(new Error('webhook_network_error')));
          response.on('end', () => finish(undefined, { status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'),
            ...(response.headers['retry-after'] ? { retryAfter: response.headers['retry-after'] } : {}) }));
        });
        abort = () => req.destroy();
        req.on('error', () => finish(new Error('webhook_network_error')));
        req.end(body);
      }).catch(() => finish(new Error('webhook_network_error')));
    });
  }
}
