export class AmbiguousWriteError extends Error {
  constructor(pendingId, options = {}) {
    super("The Sheets write outcome is ambiguous; automatic retry is blocked", options);
    this.name = "AmbiguousWriteError";
    this.pendingId = pendingId;
  }
}
