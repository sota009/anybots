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
    ? 'Selected connection'
    : 'All of your connections';
  const relationships = pairCount(body);
  if (body.connections.length === 0) {
    return {
      heading: 'Connections',
      checkedAt: sanitizeText(body.checkedAt),
      completeness: `${scoped} · complete`,
      totals: '0 connections · 0 relationships',
      emptyMessage: 'No connections are registered.',
    };
  }
  const contacts = body.connections.reduce((sum, row) => sum + row.contacts.length, 0);
  return {
    heading: 'Connections',
    checkedAt: sanitizeText(body.checkedAt),
    completeness: `${scoped} · complete`,
    totals: `${body.connections.length} connections · ${relationships} ${relationships === 1 ? 'relationship' : 'relationships'}`,
    emptyMessage: contacts === 0 ? 'No permitted contacts.' : null,
  };
}

export function errorGuidance(code: string): string {
  switch (code) {
    case 'unauthorized':
      return 'Check the browsing credential, then ask an operator to reissue it.';
    case 'forbidden':
      return 'Ask an operator to confirm your directory access.';
    case 'connection_not_found':
      return 'Confirm the connection ID against your list and registration notes.';
    case 'inventory_too_large':
      return 'Narrow the connection filter, or ask an operator for help.';
    case 'rate_limited':
      return 'Wait a moment, then try again.';
    case 'invalid_request':
      return 'Check your input and try again.';
    default:
      return 'Could not load the list. Try again shortly, or contact an operator.';
  }
}
