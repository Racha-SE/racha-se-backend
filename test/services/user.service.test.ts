import { describe, expect, test } from "bun:test";
import { userService } from "@/services/user.service";
import { AppError } from "@/utils";

describe("userService.findAll", () => {
  test("returns the seeded users", () => {
    const users = userService.findAll();

    expect(users).toContainEqual({ id: "1", name: "Narumed" });
    expect(users).toContainEqual({ id: "2", name: "Pitayachamrat" });
  });
});

describe("userService.findById", () => {
  test("returns the matching user", () => {
    expect(userService.findById("1")).toEqual({ id: "1", name: "Narumed" });
  });

  test("throws AppError(NOT_FOUND) when the id does not exist", () => {
    expect(() => userService.findById("does-not-exist")).toThrow(AppError);

    try {
      userService.findById("does-not-exist");
      throw new Error("expected findById to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("NOT_FOUND");
      expect((error as AppError).httpStatus).toBe(404);
    }
  });
});

describe("userService.create", () => {
  test("adds and returns a new user", () => {
    const user = userService.create("Service Test User");

    expect(user.name).toBe("Service Test User");
    expect(userService.findById(user.id)).toEqual(user);
  });

  test("throws AppError(ALREADY_EXISTS) for a duplicate name", () => {
    userService.create("Duplicate Service User");

    try {
      userService.create("Duplicate Service User");
      throw new Error("expected create to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("ALREADY_EXISTS");
      expect((error as AppError).context).toEqual({
        name: "Duplicate Service User",
      });
    }
  });
});
