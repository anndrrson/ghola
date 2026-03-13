export class SAIDPayError extends Error {
  public readonly httpStatus?: number;
  public readonly code?: string;

  constructor(message: string, httpStatus?: number, code?: string) {
    super(message);
    this.name = 'SAIDPayError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}
