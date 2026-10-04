import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCli } from '../src/cli.js';
import { writeDirectoryCredentialFile } from '../src/directory-file.js';

let directory: string;
let credentialsPath: string;
let stdout: string;
let stderr: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'anybots-cli-'));
  await chmod(directory, 0o700);
  credentialsPath = join(directory, 'directory.json');
  stdout = '';
  stderr = '';
  await writeDirectoryCredentialFile(credentialsPath, {
    credentialId: randomUUID(),
    secret: randomUUID() + randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    audience: 'https://directory.example',
  });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function io(fetchImpl: typeof fetch) {
  return {
    fetchImpl,
    stdout: (text: string) => { stdout += text; },
    stderr: (text: string) => { stderr += `${text}\n`; },
  };
}

const sample = {
  schemaVersion: 1 as const,
  checkedAt: '2026-10-03T19:00:00.000Z',
  scope: { connectionId: null },
  complete: true as const,
  connections: [{
    connectionId: '11111111-1111-4111-8111-111111111111',
    provider: 'dots' as const,
    registration: 'active' as const,
    identityUnit: 'connection' as const,
    contacts: [{
      connectionId: '22222222-2222-4222-8222-222222222222',
      provider: 'grok' as const,
      sameOwner: true,
      permission: 'recorded' as const,
      recordedVia: 'operator' as const,
      registrationAllowsCommunication: true,
    }],
  }, {
    connectionId: '22222222-2222-4222-8222-222222222222',
    provider: 'grok' as const,
    registration: 'active' as const,
    identityUnit: 'connection' as const,
    contacts: [{
      connectionId: '11111111-1111-4111-8111-111111111111',
      provider: 'dots' as const,
      sameOwner: true,
      permission: 'recorded' as const,
      recordedVia: 'operator' as const,
      registrationAllowsCommunication: true,
    }],
  }],
};

it('prints a text inventory once and never retries', async () => {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe('https://directory.example/v1/me/connections');
    return new Response(JSON.stringify(sample), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const code = await runCli(['connections', '--credentials', credentialsPath], io(fetchImpl));
  expect(code).toBe(0);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(stdout).toContain('自分の登録 2件 / 関係 1組');
  expect(stdout).toContain('11111111-1111-4111-8111-111111111111');
  expect(stderr).toBe('');
});

it('emits only JSON on success for --json', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(sample), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  const code = await runCli(['connections', '--json', '--credentials', credentialsPath], io(fetchImpl));
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual(sample);
  expect(stderr).toBe('');
});

it('maps auth and inventory failures to stable exit codes without partial stdout', async () => {
  for (const [status, exitCode, code] of [
    [401, 3, 'unauthorized'],
    [403, 3, 'forbidden'],
    [404, 4, 'connection_not_found'],
    [422, 4, 'inventory_too_large'],
    [429, 5, 'rate_limited'],
    [503, 5, 'unavailable'],
  ] as const) {
    stdout = '';
    stderr = '';
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: code }), { status })) as unknown as typeof fetch;
    const result = await runCli(['connections', '--json', '--credentials', credentialsPath], io(fetchImpl));
    expect(result).toBe(exitCode);
    expect(stdout).toBe('');
    expect(stderr).toContain(code);
  }
});

it('rejects bad args, unsafe credential files, and malformed success payloads', async () => {
  expect(await runCli(['connections', '--wat'], io(vi.fn() as never))).toBe(2);
  expect(stdout).toBe('');

  const linked = join(directory, 'bad.json');
  await writeFile(linked, 'not-json', { mode: 0o600 });
  await chmod(linked, 0o644);
  stdout = '';
  stderr = '';
  expect(await runCli(['connections', '--credentials', linked], io(vi.fn() as never))).toBe(2);
  expect(stdout).toBe('');

  const fetchImpl = vi.fn(async () => new Response('{"schemaVersion":2}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  stdout = '';
  stderr = '';
  expect(await runCli(['connections', '--json', '--credentials', credentialsPath], io(fetchImpl))).toBe(5);
  expect(stdout).toBe('');
  expect(stderr).toContain('unavailable');
});

it('does not follow redirects or call non-https audiences', async () => {
  await writeDirectoryCredentialFile(join(directory, 'http.json'), {
    credentialId: randomUUID(),
    secret: randomUUID() + randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    audience: 'http://directory.example',
  });
  const fetchImpl = vi.fn();
  expect(await runCli(['connections', '--credentials', join(directory, 'http.json')], io(fetchImpl as never))).toBe(2);
  expect(fetchImpl).not.toHaveBeenCalled();
});
