/**
 * AppErrorCode is an enum of error codes used in the application. Each error
 * code corresponds to a specific HTTP status code and represents a common
 * error scenario that may occur during API requests.
 */
export const AppErrorCode = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  VALIDATION: 400,
  INTERNAL_SERVER_ERROR: 500,
} as const;

/** Union of AppErrorCode key names, e.g. "NOT_FOUND". */
export type AppErrorCode = keyof typeof AppErrorCode;
/** Union of AppErrorCode HTTP status values. */
export type AppErrorCodeHttpValue = (typeof AppErrorCode)[AppErrorCode];

/**
 * Domain error thrown by services (and route guards). The global `onError`
 * handler in src/index.ts catches it and returns the standard
 * `{ success: false, error: { code, context? } }` envelope with the HTTP
 * status mapped from {@link AppErrorCode}.
 * @example
 *   throw new AppError("NOT_FOUND");
 *   throw new AppError("ALREADY_EXISTS", { name: "Narumed" });
 */
export class AppError extends Error {
  readonly httpStatus: AppErrorCodeHttpValue;

  constructor(
    readonly code: AppErrorCode,
    readonly context?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "AppError";
    this.httpStatus = AppErrorCode[code];
  }
}
