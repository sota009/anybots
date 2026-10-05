#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const HOST = 'srv-db0lku9srm7s7384ral0@ssh.singapore.render.com';
const FAILURE = 'Remote admin operation failed. Check configuration and remote state before retrying.';
const REISSUE = 'Credential retrieval failed; reissue is required.';
const INPUT_LIMIT = 16_384;
const OUTPUT_LIMIT = 65_536;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const uuid = z.string().regex(new RegExp(`^${UUID}$`));
const commandSchema = z.union([
  z.strictObject({ action: z.literal('signup_invite'), ownerId: uuid.optional() }),
  z.strictObject({ action: z.literal('revoke'), a: z.uuid(), b: z.uuid() }),
  z.strictObject({ action: z.literal('disable'), bindingId: z.uuid() }),
  z.strictObject({ action: z.literal('status'), bindingId: z.uuid(), peerBindingId: z.uuid().optional() }),
]);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const diagnosticSchema = z.strictObject({
  checkedAt: z.iso.datetime(),
  binding: z.strictObject({ exists: z.boolean(), active: z.boolean(), provider: z.enum(['dots', 'grok', 'mcp']).nullable() }),
  oauth: z.strictObject({ configured: z.boolean(), activeFamilies: count }),
  peer: z.strictObject({ exists: z.boolean(), active: z.boolean(), granted: z.boolean() }).nullable(),
  notification: z.strictObject({ configured: z.boolean(), mode: z.literal('poll').optional(), activeSubscriptions: count.optional(), experimentalEnabled: z.boolean().optional(), webhookConfigured: z.boolean().optional() }),
  messages: z.strictObject({ sent: count, received: count }),
  outbox: z.strictObject({ pending: count, accepted: count, failed: count, uncertain: count, cancelled: count, not_required: count }),
  liveVerification: z.literal('not_verified'),
});

async function readBounded(stream, limit) {
  const parts = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error(FAILURE);
    parts.push(bytes);
  }
  return Buffer.concat(parts).toString('utf8');
}

async function privateDirectory(path) {
  const target = resolve(path);
  let current = parse(target).root;
  for (const component of target.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(FAILURE);
  }
  const info = await lstat(target);
  if ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()) throw new Error(FAILURE);
  return target;
}

function ssh(config, remoteCommand, input, spawnImpl, timeoutMs) {
  return new Promise((accept, reject) => {
    let child;
    let timer;
    let finished = false;
    let outputSize = 0;
    let errorSize = 0;
    const output = [];
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child?.kill('SIGKILL');
      reject(new Error(FAILURE));
    };
    try {
      child = spawnImpl('ssh', [
        '-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
        '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
        '-o', 'PermitLocalCommand=no', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
        '-i', config.identityFile, config.host, remoteCommand,
      ], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      timer = setTimeout(fail, timeoutMs);
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.stderr.on('error', fail);
      child.stdout.on('data', (chunk) => {
        if (finished) return;
        const bytes = Buffer.from(chunk);
        outputSize += bytes.length;
        if (outputSize > OUTPUT_LIMIT) return fail();
        output.push(bytes);
      });
      child.stderr.on('data', (chunk) => {
        if (finished) return;
        errorSize += Buffer.byteLength(chunk);
        if (errorSize > OUTPUT_LIMIT) fail();
      });
      child.on('close', (code) => {
        if (finished) return;
        if (code !== 0) return fail();
        finished = true;
        clearTimeout(timer);
        accept(Buffer.concat(output).toString('utf8'));
      });
      child.stdin.end(input);
    } catch { fail(); }
  });
}

function metadataFor(command, raw) {
  const value = JSON.parse(raw);
  if (command.action === 'status') return diagnosticSchema.parse(value);
  if (command.action !== 'signup_invite') {
    const status = { revoke: 'revoked', disable: 'disabled' }[command.action];
    return z.strictObject({ status: z.literal(status) }).parse(value);
  }
  const metadata = z.strictObject({ inviteId: uuid, credentialsFile: z.string().max(200), expiresAt: z.iso.datetime() }).parse(value);
  if (metadata.credentialsFile !== `/app/.local/invite-${metadata.inviteId}.json`) throw new Error(FAILURE);
  return metadata;
}

export async function runRemoteAdmin({ configFile, credentialsDirectory, input, spawnImpl = spawn, timeoutMs = 30_000 }) {
  let retrieval = false;
  try {
    const command = commandSchema.parse(JSON.parse(await readBounded(input, INPUT_LIMIT)));
    const config = z.strictObject({ host: z.literal(HOST), identityFile: z.string().min(1).max(4096).refine(isAbsolute) })
      .parse(JSON.parse(await readBounded(createReadStream(configFile), 8192)));
    const key = await lstat(config.identityFile);
    if (!key.isFile() || key.isSymbolicLink() || (key.mode & 0o077) !== 0 || key.uid !== process.getuid()) throw new Error(FAILURE);
    const destination = await privateDirectory(credentialsDirectory);
    const raw = await ssh(config, 'cd /app && exec node dist/admin.js', JSON.stringify(command), spawnImpl, timeoutMs);
    const metadata = metadataFor(command, raw);
    if (!Object.hasOwn(metadata, 'credentialsFile')) return metadata;
    retrieval = true;
    const credentials = await ssh(config, `cd /app && exec cat -- ${metadata.credentialsFile}`, '', spawnImpl, timeoutMs);
    const parsed = JSON.parse(credentials);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(REISSUE);
    // Recheck before writing; parent directories must be trusted against concurrent renaming.
    await privateDirectory(destination);
    const file = join(destination, basename(metadata.credentialsFile));
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(credentials, 'utf8');
      await handle.sync();
    } catch {
      await handle.close();
      await unlink(file).catch(() => {});
      throw new Error(REISSUE);
    }
    await handle.close();
    return { ...metadata, credentialsFile: file };
  } catch {
    throw new Error(retrieval ? REISSUE : FAILURE);
  }
}

export async function remoteAdminCli({ argv = process.argv.slice(2), input = process.stdin, stdout = process.stdout, stderr = process.stderr, spawnImpl = spawn } = {}) {
  try {
    if (argv.length !== 4 || argv[0] !== '--config' || argv[2] !== '--credentials-dir') throw new Error(FAILURE);
    const result = await runRemoteAdmin({ configFile: argv[1], credentialsDirectory: argv[3], input, spawnImpl });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error && error.message === REISSUE ? REISSUE : FAILURE}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await remoteAdminCli();
}
