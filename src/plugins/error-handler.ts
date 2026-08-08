import { Elysia, mapValueError } from "elysia";
import { AppError, AppErrorCode, errorResponse } from "@/utils";

/**
 * Catches {@link AppError} thrown anywhere in the request lifecycle, plus
 * Elysia's own schema-validation failures, and turns both into the standard
 * `{ success: false, error: { code, context? } }` envelope, with the HTTP
 * status mapped from the error code. Shared between the real app
 * (src/index.ts) and route-level tests.
 */
export const errorHandler = new Elysia()
  .onError(({ code, error, set }) => {
    if (code === "VALIDATION") {
      const detail = mapValueError(error.valueError);
      set.status = AppErrorCode.VALIDATION;
      return errorResponse("VALIDATION", {
        on: error.type,
        property: detail?.path,
        summary: detail?.summary ?? error.message,
      });
    }

    if (error instanceof AppError) {
      set.status = error.httpStatus;
      return errorResponse(error.code, error.context);
    }
  })
  .as("global");
