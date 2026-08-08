import { describe, expect, test } from "bun:test";
import { AppError, AppErrorCode } from "@/utils";

describe("AppError", () => {
  test("maps the code to its HTTP status via AppErrorCode", () => {
    const error = new AppError("NOT_FOUND");

    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(AppErrorCode.NOT_FOUND);
    expect(error.httpStatus).toBe(404);
  });

  test("carries optional context", () => {
    const error = new AppError("ALREADY_EXISTS", { name: "Fah" });

    expect(error.context).toEqual({ name: "Fah" });
  });

  test("context is undefined when not provided", () => {
    const error = new AppError("BAD_REQUEST");

    expect(error.context).toBeUndefined();
  });

  test("is a real Error with name AppError and message = code", () => {
    const error = new AppError("UNAUTHORIZED");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AppError");
    expect(error.message).toBe("UNAUTHORIZED");
  });
});
