export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, 400, message, details);
export const unauthorized = (code = 'UNAUTHENTICATED', message = 'Authentication required') =>
  new AppError(code, 401, message);
export const forbidden = (code = 'FORBIDDEN', message = 'Not allowed') => new AppError(code, 403, message);
export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', 404, `${what} not found`);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, 409, message, details);
export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, 422, message, details);
export const lockedState = (code: string, message: string) => new AppError(code, 423, message);
export const tooMany = () => new AppError('RATE_LIMITED', 429, 'Too many requests, please try again later');
