import { directoryResponseSchema, type DirectoryResponse } from './directory-inventory.js';
import { readDirectoryCredentialFile } from './directory-file.js';

export type CliIO = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetchImpl?: typeof fetch;
};

export type CliResult = { exitCode: number };

const EXIT = {
  ok: 0,
  usage: 2,
  auth: 3,
  client: 4,
  unavailable: 5,
} as const;

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '');
}

function usage(stderr: CliIO['stderr']): CliResult {
  stderr('invalid_request: use `anybots connections [--connection <uuid>] [--json] [--credentials <path>]`');
  return { exitCode: EXIT.usage };
}

function parseArgs(argv: string[]) {
  let connectionId: string | undefined;
  let json = false;
  let credentialsPath = `${process.env.HOME ?? ''}/.config/anybots/directory.json`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--connection') {
      const value = argv[++index];
      if (!value) return { error: 'usage' as const };
      connectionId = value;
      continue;
    }
    if (arg === '--credentials') {
      const value = argv[++index];
      if (!value) return { error: 'usage' as const };
      credentialsPath = value;
      continue;
    }
    if (arg.startsWith('--')) return { error: 'usage' as const };
    return { error: 'usage' as const };
  }
  return { connectionId, json, credentialsPath };
}

async function readBody(response: Response, limit = 1_048_576): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) throw new Error('response_too_large');
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function formatText(body: DirectoryResponse): string {
  const lines = [
    `取得開始: ${sanitize(body.checkedAt)}`,
    `対象: ${body.scope.connectionId ? '指定した接続の全件' : '自分の全接続'} / 全件取得済み`,
    '',
  ];
  if (body.connections.length === 0) {
    lines.push('登録された接続はありません');
    return `${lines.join('\n')}\n`;
  }
  let pairs = 0;
  const seen = new Set<string>();
  let contactRows = 0;
  for (const connection of body.connections) {
    lines.push(`自分の接続: ${sanitize(connection.provider)}`);
    lines.push(`  接続ID: ${sanitize(connection.connectionId)}`);
    lines.push(`  Anybots登録: ${connection.registration === 'active' ? '有効' : '無効'}`);
    if (connection.contacts.length === 0) {
      lines.push('  相手: 許可された相手はありません');
    }
    for (const contact of connection.contacts) {
      contactRows += 1;
      const pairKey = [connection.connectionId, contact.connectionId].sort().join(':');
      if (!seen.has(pairKey)) {
        seen.add(pairKey);
        pairs += 1;
      }
      lines.push(`  相手: ${sanitize(contact.provider)} / ${sanitize(contact.connectionId)}`);
      lines.push(`    登録上の持ち主: ${contact.sameOwner ? '自分' : '他人'}`);
      lines.push('    通信許可: 記録あり（運営設定）');
      lines.push(`    登録上の通信条件: ${contact.registrationAllowsCommunication ? '有効' : '無効'}`);
    }
    lines.push('');
  }
  if (contactRows === 0) {
    lines.push('許可された相手はありません');
  } else {
    lines.push(`自分の登録 ${body.connections.length}件 / 関係 ${pairs}組`);
  }
  lines.push('個別AIの識別・現在のオンライン状態・外部操作権限は未確認です。');
  return `${lines.join('\n')}\n`;
}

function mapStatus(status: number): { exitCode: number; code: string; hint: string } {
  if (status === 401 || status === 403) {
    return {
      exitCode: EXIT.auth,
      code: status === 401 ? 'unauthorized' : 'forbidden',
      hint: status === 401
        ? '閲覧資格情報を確認し、運営へ再発行を依頼してください'
        : '運営へ閲覧権限の確認を依頼してください',
    };
  }
  if (status === 400 || status === 404 || status === 422) {
    return {
      exitCode: EXIT.client,
      code: status === 404 ? 'connection_not_found' : status === 422 ? 'inventory_too_large' : 'invalid_request',
      hint: status === 422
        ? '接続を絞るか運営へ相談してください'
        : '自分の一覧と登録控えからIDを確認してください',
    };
  }
  return {
    exitCode: EXIT.unavailable,
    code: status === 429 ? 'rate_limited' : 'unavailable',
    hint: status === 429
      ? 'Retry-After後に再実行してください'
      : '一覧を確認できませんでした。しばらくしてから再実行するか運営へ連絡してください',
  };
}

export async function runConnectionsCommand(argv: string[], io: CliIO): Promise<CliResult> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) return usage(io.stderr);

  let credentials;
  try {
    credentials = await readDirectoryCredentialFile(parsed.credentialsPath);
  } catch {
    io.stderr('invalid_request: 閲覧資格情報ファイルを確認してください');
    return { exitCode: EXIT.usage };
  }

  let origin: URL;
  try {
    origin = new URL(credentials.audience);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
      || (origin.pathname !== '/' && origin.pathname !== '')) {
      throw new Error('bad audience');
    }
  } catch {
    io.stderr('invalid_request: 閲覧資格情報の接続先を確認してください');
    return { exitCode: EXIT.usage };
  }

  const url = new URL('/v1/me/connections', origin);
  if (parsed.connectionId) url.searchParams.set('connection_id', parsed.connectionId);

  const fetchImpl = io.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${credentials.secret}`,
        accept: 'application/json',
      },
    });
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await readBody(response);
    if (!response.ok) {
      const mapped = mapStatus(response.status);
      io.stderr(`${mapped.code}: ${mapped.hint}`);
      return { exitCode: mapped.exitCode };
    }
    if (!contentType.includes('application/json')) {
      io.stderr('unavailable: 一覧を確認できませんでした。しばらくしてから再実行するか運営へ連絡してください');
      return { exitCode: EXIT.unavailable };
    }
    let json: unknown;
    try { json = JSON.parse(raw); }
    catch {
      io.stderr('unavailable: 一覧を確認できませんでした。しばらくしてから再実行するか運営へ連絡してください');
      return { exitCode: EXIT.unavailable };
    }
    const body = directoryResponseSchema.safeParse(json);
    if (!body.success) {
      io.stderr('unavailable: 一覧を確認できませんでした。しばらくしてから再実行するか運営へ連絡してください');
      return { exitCode: EXIT.unavailable };
    }
    if (parsed.json) io.stdout(`${JSON.stringify(body.data)}\n`);
    else io.stdout(formatText(body.data));
    return { exitCode: EXIT.ok };
  } catch {
    io.stderr('unavailable: 一覧を確認できませんでした。しばらくしてから再実行するか運営へ連絡してください');
    return { exitCode: EXIT.unavailable };
  } finally {
    clearTimeout(timer);
  }
}
