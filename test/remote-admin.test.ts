import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

const moduleUrl = new URL('../scripts/remote-admin.mjs', import.meta.url).href;
const { runRemoteAdmin, remoteAdminCli } = await import(moduleUrl);
const host = 'srv-db0lku9srm7s7384ral0@ssh.singapore.render.com';
const bindingId = 'a2222222-2222-4222-8222-222222222222';
const otherId = 'b2222222-2222-4222-8222-222222222222';
const ownerId = 'a1111111-1111-4111-8111-111111111111';
const inviteId = 'c3333333-3333-4333-8333-333333333333';
const provision = { action: 'signup_invite', ownerId };
const secret = 'test-secret-must-not-be-printed';
let directory: string;
let configFile: string;
let output: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'remote-admin-')));
  configFile = join(directory, 'connection.json');
  output = join(directory, 'credentials');
  const identityFile = join(directory, 'identity');
  await writeFile(identityFile, 'mock-private-key', { mode: 0o600 });
  await writeFile(configFile, JSON.stringify({ host, identityFile }));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

type Reply = { stdout?: string; stderr?: string; code?: number; error?: boolean; hang?: boolean };
function mockSsh(replies: Reply[]) {
  const calls: { command: string; args: string[]; options: any; input: string; kill: ReturnType<typeof vi.fn> }[] = [];
  const spawnImpl = vi.fn((command: string, args: string[], options: any) => {
    const reply = replies[calls.length] ?? {};
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const call = { command, args, options, input: '', kill: child.kill };
    calls.push(call);
    child.stdin.on('data', (chunk) => { call.input += chunk.toString(); });
    child.stdin.on('finish', () => queueMicrotask(() => {
      if (reply.error) { child.emit('error', new Error(secret)); return; }
      if (reply.hang) return;
      if (reply.stdout) child.stdout.write(reply.stdout);
      if (reply.stderr) child.stderr.write(reply.stderr);
      child.emit('close', reply.code ?? 0);
    }));
    return child;
  });
  return { spawnImpl, calls };
}
function run(mock: ReturnType<typeof mockSsh>, command: unknown = provision, extra = {}) {
  return runRemoteAdmin({ configFile, credentialsDirectory: output, input: Readable.from([JSON.stringify(command)]), spawnImpl: mock.spawnImpl, ...extra });
}
const provisionMetadata = (file = `/app/.local/invite-${inviteId}.json`) => JSON.stringify({ inviteId, credentialsFile: file, expiresAt: '2026-10-11T00:00:00.000Z' });

it('uses fixed SSH options and stdin and saves credentials exclusively with mode 0600', async () => {
  const mock = mockSsh([{ stdout: provisionMetadata() }, { stdout: JSON.stringify({ token: secret, bindingId }) }]);
  const result = await run(mock);
  expect(mock.calls).toHaveLength(2);
  const first = mock.calls[0]!;
  expect(first.command).toBe('ssh');
  expect(first.options.shell).toBe(false);
  expect(first.args).toEqual(expect.arrayContaining(['-F', '/dev/null', 'BatchMode=yes', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=yes', host, 'cd /app && exec node dist/admin.js']));
  expect(first.input).toBe(JSON.stringify(provision));
  expect(mock.calls[1]!.args.at(-1)).toBe(`cd /app && exec cat -- /app/.local/invite-${inviteId}.json`);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.parse(await readFile(result.credentialsFile, 'utf8')).token).toBe(secret);
  expect((await lstat(result.credentialsFile)).mode & 0o777).toBe(0o600);
  expect((await lstat(output)).mode & 0o777).toBe(0o700);
});

it.each(['../outside.json', `/app/.local/invite-${inviteId}.json; echo injected`, `/app/.local/invite-${otherId}.json`])('rejects injected or mismatched remote paths without a second SSH call: %s', async (path) => {
  const mock = mockSsh([{ stdout: provisionMetadata(path) }]);
  await expect(run(mock)).rejects.toThrow('Remote admin operation failed');
  expect(mock.calls).toHaveLength(1);
});

it.each([
  `${provisionMetadata()}\n${secret}`,
  JSON.stringify({ inviteId, credentialsFile: `/app/.local/invite-${inviteId}.json`, expiresAt: '2026-10-11T00:00:00.000Z', url: secret }),
  JSON.stringify({ status: secret }),
  secret,
])('never forwards unknown remote output', async (stdout) => {
  const mock = mockSsh([{ stdout }]);
  await expect(run(mock)).rejects.toThrow('Remote admin operation failed');
  expect(mock.calls).toHaveLength(1);
});

it('rejects oversized stdin before SSH even when multibyte characters are used', async () => {
  const mock = mockSsh([]);
  await expect(run(mock, provision, { input: Readable.from(['日'.repeat(6000)]) })).rejects.toThrow('Remote admin operation failed');
  expect(mock.calls).toHaveLength(0);
});

it('rejects an unapproved host or unknown config field before SSH', async () => {
  const mock = mockSsh([]);
  await writeFile(configFile, JSON.stringify({ host: 'attacker.invalid', identityFile: join(directory, 'identity') }));
  await expect(run(mock)).rejects.toThrow('Remote admin operation failed');
  await writeFile(configFile, JSON.stringify({ host, identityFile: join(directory, 'identity'), proxyCommand: secret }));
  await expect(run(mock)).rejects.toThrow('Remote admin operation failed');
  expect(mock.calls).toHaveLength(0);
});

it('rejects symlinked private directories before any remote effect', async () => {
  await symlink(directory, output);
  const mock = mockSsh([]);
  await expect(run(mock)).rejects.toThrow('Remote admin operation failed');
  expect(mock.calls).toHaveLength(0);
});

it('rejects symlinked directory ancestors and permissive private directories', async () => {
  const link = join(directory, 'link');
  await symlink(directory, link);
  const mock = mockSsh([]);
  await expect(run(mock, provision, { credentialsDirectory: join(link, 'nested') })).rejects.toThrow('Remote admin operation failed');
  await chmod(directory, 0o755);
  await expect(run(mock, provision, { credentialsDirectory: directory })).rejects.toThrow('Remote admin operation failed');
  expect(mock.calls).toHaveLength(0);
});

it('preserves existing credential files and reports reissue without retrying', async () => {
  const first = mockSsh([{ stdout: provisionMetadata() }, { stdout: JSON.stringify({ token: secret }) }]);
  const result = await run(first);
  const second = mockSsh([{ stdout: provisionMetadata() }, { stdout: JSON.stringify({ token: 'replacement' }) }]);
  await expect(run(second)).rejects.toThrow('Credential retrieval failed; reissue is required');
  expect(second.calls).toHaveLength(2);
  expect(JSON.parse(await readFile(result.credentialsFile, 'utf8')).token).toBe(secret);
});

it('does not print remote output or error details on retrieval failure', async () => {
  const mock = mockSsh([{ stdout: provisionMetadata() }, { stderr: secret, code: 1 }]);
  let stdout = ''; let stderr = '';
  const code = await remoteAdminCli({ argv: ['--config', configFile, '--credentials-dir', output], input: Readable.from([JSON.stringify(provision)]), stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } }, spawnImpl: mock.spawnImpl });
  expect(code).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toBe('Credential retrieval failed; reissue is required.\n');
  expect(stderr).not.toContain(secret);
  expect(mock.calls).toHaveLength(2);
});

it.each([{ stderr: secret, code: 1 }, { error: true }, { stdout: secret.repeat(10000) }, { stderr: secret.repeat(10000) }])('hides SSH errors and limits output without retry', async (reply) => {
  const mock = mockSsh([reply]);
  await expect(run(mock)).rejects.toThrow('Remote admin operation failed');
  expect(mock.calls).toHaveLength(1);
});

it('times out a hung SSH child and never retries', async () => {
  const mock = mockSsh([{ hang: true }]);
  await expect(run(mock, provision, { timeoutMs: 5 })).rejects.toThrow('Remote admin operation failed');
  expect(mock.calls).toHaveLength(1);
  expect(mock.calls[0]!.kill).toHaveBeenCalledWith('SIGKILL');
});

it('returns only the expected noncredential status', async () => {
  const mock = mockSsh([{ stdout: JSON.stringify({ status: 'disabled' }) }]);
  expect(await run(mock, { action: 'disable', bindingId })).toEqual({ status: 'disabled' });
  expect(mock.calls).toHaveLength(1);
});

const diagnostic = {
  checkedAt: '2026-10-03T20:00:00.000Z',
  binding: { exists: true, active: true, provider: 'dots' },
  oauth: { configured: true, activeFamilies: 1 }, peer: null,
  notification: { configured: false, activeSubscriptions: 0 },
  messages: { sent: 0, received: 0 },
  outbox: { pending: 0, accepted: 0, failed: 0, uncertain: 0, cancelled: 0, not_required: 0 },
  liveVerification: 'not_verified',
};
it('supports bounded, secret-free status diagnostics without a credential fetch', async () => {
  const mock = mockSsh([{ stdout: JSON.stringify(diagnostic) }]);
  expect(await run(mock, { action: 'status', bindingId, peerBindingId: otherId })).toEqual(diagnostic);
  expect(mock.calls).toHaveLength(1);
});
it('accepts Muse polling diagnostics without mistaking skipped notifications for delivery', async () => {
  const status = { ...diagnostic, binding: { exists: true, active: true, provider: 'mcp' },
    notification: { configured: false, mode: 'poll' }, outbox: { ...diagnostic.outbox, not_required: 2 } };
  const mock = mockSsh([{ stdout: JSON.stringify(status) }]);
  expect(await run(mock, { action: 'status', bindingId })).toEqual(status);
  expect(mock.calls).toHaveLength(1);
});
it('rejects unknown nested status fields that could contain secrets', async () => {
  const mock = mockSsh([{ stdout: JSON.stringify({ ...diagnostic, oauth: { ...diagnostic.oauth, token: secret } }) }]);
  await expect(run(mock, { action: 'status', bindingId })).rejects.toThrow('Remote admin operation failed');
});
it('rejects removed and invalid commands before SSH', async () => {
  const mock = mockSsh([]);
  for (const removed of [{ action: 'grant', a: bindingId, b: otherId, consentConfirmed: true }, { action: 'create_owner' },
    { action: 'provision', ownerId, runtimeScope: 'pilot', provider: 'dots' }, { action: 'connect', bindingId }]) {
    await expect(run(mock, removed)).rejects.toThrow('Remote admin operation failed');
  }
  await expect(run(mock, { ...provision, command: secret })).rejects.toThrow('Remote admin operation failed');
  await expect(run(mock, provision, { input: Readable.from(['{']) })).rejects.toThrow('Remote admin operation failed');
  expect(mock.calls).toHaveLength(0);
});
it('rejects unsafe key permissions and symlinks before SSH', async () => {
  const identity = join(directory, 'identity');
  const mock = mockSsh([]);
  await chmod(identity, 0o644);
  await expect(run(mock)).rejects.toThrow('Remote admin operation failed');
  await rm(identity);
  await symlink(configFile, identity);
  await expect(run(mock)).rejects.toThrow('Remote admin operation failed');
  expect(mock.calls).toHaveLength(0);
});
it('bounds credential retrieval and requires reissue when its output is excessive', async () => {
  const mock = mockSsh([{ stdout: provisionMetadata() }, { stdout: secret.repeat(10000) }]);
  await expect(run(mock)).rejects.toThrow('Credential retrieval failed; reissue is required');
  expect(mock.calls).toHaveLength(2);
  expect(mock.calls[1]!.kill).toHaveBeenCalledWith('SIGKILL');
});
it('never follows an existing credential-file symlink', async () => {
  const first = mockSsh([{ stdout: provisionMetadata() }, { stdout: JSON.stringify({ token: secret }) }]);
  const result = await run(first);
  const victim = join(directory, 'victim');
  await writeFile(victim, 'unchanged');
  await rm(result.credentialsFile);
  await symlink(victim, result.credentialsFile);
  const mock = mockSsh([{ stdout: provisionMetadata() }, { stdout: JSON.stringify({ token: secret }) }]);
  await expect(run(mock)).rejects.toThrow('Credential retrieval failed; reissue is required');
  expect(await readFile(victim, 'utf8')).toBe('unchanged');
});
it('prints only metadata on CLI success, discarding even successful SSH stderr', async () => {
  const mock = mockSsh([{ stdout: provisionMetadata(), stderr: secret }, { stdout: JSON.stringify({ token: secret }), stderr: secret }]);
  let stdout = ''; let stderr = '';
  const code = await remoteAdminCli({ argv: ['--config', configFile, '--credentials-dir', output], input: Readable.from([JSON.stringify(provision)]), stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } }, spawnImpl: mock.spawnImpl });
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ inviteId, expiresAt: '2026-10-11T00:00:00.000Z', credentialsFile: join(output, `invite-${inviteId}.json`) });
  expect(stdout).not.toContain(secret);
  expect(stderr).toBe('');
});
