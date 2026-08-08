import { type TSchema, t } from "elysia";
import { type AppErrorCode } from "./error";

/**
 * Standard success envelope for API responses.
 * @example
 *   return successResponse({ id: "1", name: "Narumed" });
 */
export function successResponse<T extends Record<string, unknown>>(data: T) {
  return { success: true as const, data };
}

/** Shape returned by {@link successResponse} — reuse to type a parsed response body. */
export type SuccessResponse<T extends Record<string, unknown>> = ReturnType<
  typeof successResponse<T>
>;

/**
 * Standard error envelope for API responses. Usually you don't call this
 * directly — throw an {@link AppError} instead and let the global `onError`
 * handler build the response.
 */
export function errorResponse<T extends AppErrorCode>(
  code: T,
  context?: Record<string, unknown>,
) {
  return { success: false as const, error: { code, context } };
}

/** Shape returned by {@link errorResponse} — reuse to type a parsed response body. */
export type ErrorResponse<T extends AppErrorCode> = ReturnType<
  typeof errorResponse<T>
>;

/**
 * Success response schema for a route's `response` option.
 * @example
 *   response: {
 *     200: tSuccessResponse(t.Object({ name: t.String() }))
 *   }
 */
export function tSuccessResponse<T extends TSchema>(data: T) {
  return t.Object({
    success: t.Literal(true),
    data,
  });
}

/**
 * Error response schema for a route's `response` option.
 * @example
 *   response: {
 *     404: tErrorResponse("NOT_FOUND")
 *   }
 */
export function tErrorResponse<T extends AppErrorCode>(code: T) {
  return t.Object({
    success: t.Literal(false),
    error: t.Object({
      code: t.Literal(code),
      context: t.Optional(t.Record(t.String(), t.Unknown())),
    }),
  });
}
