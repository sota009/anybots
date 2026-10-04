import type { DirectoryResponse } from './directory-inventory.js';

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

export function sanitizeText(value: string): string {
  return value.replace(CONTROL, '');
}

export function pairCount(body: DirectoryResponse): number {
  const seen = new Set<string>();
  for (const connection of body.connections) {
    for (const contact of connection.contacts) {
      seen.add([connection.connectionId, contact.connectionId].sort().join(':'));
    }
  }
  return seen.size;
}

export function summarizeInventory(body: DirectoryResponse): {
  heading: string;
  checkedAt: string;
  completeness: string;
  totals: string;
  emptyMessage: string | null;
} {
  const scoped = body.scope.connectionId
    ? '指定した接続の全件'
    : '自分の全接続';
  if (body.connections.length === 0) {
    return {
      heading: '接続一覧',
      checkedAt: sanitizeText(body.checkedAt),
      completeness: `${scoped} / 全件取得済み`,
      totals: '自分の登録 0件 / 関係 0組',
      emptyMessage: '登録された接続はありません',
    };
  }
  const contacts = body.connections.reduce((sum, row) => sum + row.contacts.length, 0);
  return {
    heading: '接続一覧',
    checkedAt: sanitizeText(body.checkedAt),
    completeness: `${scoped} / 全件取得済み`,
    totals: `自分の登録 ${body.connections.length}件 / 関係 ${pairCount(body)}組`,
    emptyMessage: contacts === 0 ? '許可された相手はありません' : null,
  };
}

export function errorGuidance(code: string): string {
  switch (code) {
    case 'unauthorized':
      return '閲覧資格情報を確認し、運営へ再発行を依頼してください';
    case 'forbidden':
      return '運営へ閲覧権限の確認を依頼してください';
    case 'connection_not_found':
      return '自分の一覧と登録控えから接続IDを確認してください';
    case 'inventory_too_large':
      return '接続を絞るか運営へ相談してください';
    case 'rate_limited':
      return '少し待ってから再実行してください';
    case 'invalid_request':
      return '入力内容を確認してください';
    default:
      return '一覧を確認できませんでした。しばらくしてから再実行するか運営へ連絡してください';
  }
}
