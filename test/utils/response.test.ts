import { describe, expect, test } from "bun:test";
import { errorResponse, successResponse } from "@/utils";

describe("successResponse", () => {
  test("wraps data in a { success: true, data } envelope", () => {
    expect(successResponse({ id: "1", name: "Narumed" })).toEqual({
      success: true,
      data: { id: "1", name: "Narumed" },
    });
  });
});

describe("errorResponse", () => {
  test("wraps a code in a { success: false, error } envelope", () => {
    expect(errorResponse("NOT_FOUND")).toEqual({
      success: false,
      error: { code: "NOT_FOUND", context: undefined },
    });
  });

  test("includes context when provided", () => {
    expect(errorResponse("ALREADY_EXISTS", { name: "Fah" })).toEqual({
      success: false,
      error: { code: "ALREADY_EXISTS", context: { name: "Fah" } },
    });
  });
});
