export class SAIDError extends Error {
  public readonly status?: number;
  public readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'SAIDError';
    this.status = status;
    this.code = code;
  }
}
