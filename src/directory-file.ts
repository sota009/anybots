import { open, mkdir, rename, rm, realpath, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { constants as fsConstants } from 'node:fs';

export type DirectoryCredentialFile = {
  credentialId: string;
  secret: string;
  expiresAt: string;
  audience: string;
};

const MAX_FILE_BYTES = 8 * 1024;

function assertPrivateDir(stat: { mode: number; uid: number; isDirectory(): boolean; isSymbolicLink(): boolean }, uid: number) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('directory_path_rejected');
  if (stat.uid !== uid) throw new Error('directory_ownership_rejected');
  if ((stat.mode & 0o777) !== 0o700) throw new Error('directory_permissions_rejected');
}

function assertPrivateFile(stat: { mode: number; uid: number; nlink: number; size: number; isFile(): boolean; isSymbolicLink(): boolean }, uid: number) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('credential_path_rejected');
  if (stat.uid !== uid) throw new Error('credential_ownership_rejected');
  if ((stat.mode & 0o777) !== 0o600) throw new Error('credential_permissions_rejected');
  if (stat.nlink !== 1) throw new Error('credential_hardlink_rejected');
  if (stat.size > MAX_FILE_BYTES) throw new Error('credential_too_large');
}

/** Reject ancestors writable by other non-root users; sticky shared dirs like /tmp are allowed. */
async function assertSafeAncestors(path: string, uid: number) {
  let current = dirname(resolve(path));
  for (let depth = 0; depth < 64; depth += 1) {
    const handle = await open(current, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (stat.uid !== uid && stat.uid !== 0) throw new Error('directory_ownership_rejected');
      const worldOrGroupWritable = (stat.mode & 0o022) !== 0;
      const sticky = (stat.mode & 0o1000) !== 0;
      if (worldOrGroupWritable && !sticky) throw new Error('directory_permissions_rejected');
    } finally { await handle.close(); }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  throw new Error('directory_path_rejected');
}

export async function writeDirectoryCredentialFile(path: string, value: DirectoryCredentialFile): Promise<string> {
  const target = resolve(path);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('credential_uid_unavailable');
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await assertSafeAncestors(target, uid);
  const parentHandle = await open(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    assertPrivateDir(await parentHandle.stat(), uid);
  } finally { await parentHandle.close(); }

  const body = `${JSON.stringify({
    credentialId: value.credentialId,
    secret: value.secret,
    expiresAt: value.expiresAt,
    audience: value.audience,
  })}\n`;
  if (Buffer.byteLength(body) > MAX_FILE_BYTES) throw new Error('credential_too_large');

  const temp = `${target}.${value.credentialId}.tmp`;
  const handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    assertPrivateFile(await handle.stat(), uid);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temp, target);
  return target;
}

export async function readDirectoryCredentialFile(path: string): Promise<DirectoryCredentialFile> {
  const target = resolve(path);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('credential_uid_unavailable');
  await assertSafeAncestors(target, uid);
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    assertPrivateFile(await handle.stat(), uid);
    const raw = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error('credential_too_large');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('credential_invalid');
    const record = parsed as Record<string, unknown>;
    for (const key of ['credentialId', 'secret', 'expiresAt', 'audience']) {
      if (typeof record[key] !== 'string' || !(record[key] as string).length) throw new Error('credential_invalid');
    }
    const allowed = new Set(['credentialId', 'secret', 'expiresAt', 'audience']);
    if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error('credential_invalid');
    return {
      credentialId: record.credentialId as string,
      secret: record.secret as string,
      expiresAt: record.expiresAt as string,
      audience: record.audience as string,
    };
  } finally { await handle.close(); }
}

export async function replaceDirectoryCredentialFile(path: string, value: DirectoryCredentialFile): Promise<string> {
  const target = resolve(path);
  const staging = `${target}.next-${value.credentialId}`;
  await writeDirectoryCredentialFile(staging, value);
  try {
    await rename(staging, target);
    return await realpath(target);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}
