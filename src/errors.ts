export class RelayError extends Error {
  constructor(public readonly code: string, message = code, public readonly statusCode = 409) {
    super(message);
    this.name = 'RelayError';
  }
}
