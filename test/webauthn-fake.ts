import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

type Cbor = number | Uint8Array | string | Map<Cbor, Cbor> | Record<string, never>;
function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([major << 5 | value]);
  if (value < 256) return Buffer.from([major << 5 | 24, value]);
  const b = Buffer.alloc(3); b[0] = major << 5 | 25; b.writeUInt16BE(value, 1); return b;
}
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') { const t = Buffer.from(value); return Buffer.concat([head(3, t.length), t]); }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k as Cbor), cbor(v as Cbor)])]);
}
const b64 = (value: Buffer) => value.toString('base64url');

/** A software passkey for tests: ES256, `none` attestation, user verification on. */
export class FakePasskey {
  readonly id = randomBytes(32);
  private readonly key: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  counter = 0;
  userHandle = '';
  constructor(readonly origin: string, readonly rpId = new URL(origin).hostname) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = pair.privateKey;
    this.publicJwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }

  private authData(flags: number, attested?: Buffer) {
    const count = Buffer.alloc(4); count.writeUInt32BE(this.counter);
    return Buffer.concat([createHash('sha256').update(this.rpId).digest(), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  private client(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(options: { challenge: string; user: { id: string } }, origin = this.origin) {
    this.userHandle = options.user.id;
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(this.publicJwk.x, 'base64url')], [-3, Buffer.from(this.publicJwk.y, 'base64url')]]));
    const length = Buffer.alloc(2); length.writeUInt16BE(this.id.length);
    const attested = Buffer.concat([Buffer.alloc(16), length, this.id, cose]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', {}], ['authData', this.authData(0x45, attested)]]));
    return { id: b64(this.id), rawId: b64(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(this.client('webauthn.create', options.challenge, origin)), attestationObject: b64(attestationObject), transports: ['internal'] } };
  }

  login(options: { challenge: string }, { origin = this.origin, flags = 0x05, advance = 1 } = {}) {
    this.counter += advance;
    const authenticatorData = this.authData(flags);
    const clientDataJSON = this.client('webauthn.get', options.challenge, origin);
    const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), this.key);
    return { id: b64(this.id), rawId: b64(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature), userHandle: this.userHandle } };
  }
}
