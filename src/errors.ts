export class RemoteError extends Error {
  constructor(public code: string, public status = 400, message = code) { super(message); }
}
export function assert(condition: unknown, code: string, status = 400): asserts condition {
  if (!condition) throw new RemoteError(code, status);
}
