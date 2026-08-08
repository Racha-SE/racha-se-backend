import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { mockUsersTable } from "@/db/schema";
import { userService } from "@/services/user.service";
import { AppError } from "@/utils";

// mock_users is a real table shared with seed data (seeds/mock_users.sql) —
// track exactly which rows this suite creates and delete only those, so
// seeded/unrelated rows survive a test run instead of getting wiped too.
const createdIds: string[] = [];

async function createTestUser(name: string) {
  const user = await userService.create(name);
  createdIds.push(user.id);
  return user;
}

afterAll(async () => {
  if (createdIds.length > 0) {
    await db
      .delete(mockUsersTable)
      .where(inArray(mockUsersTable.id, createdIds));
  }
});

describe("userService.findAll", () => {
  test("includes users that were created", async () => {
    const user = await createTestUser(
      `FindAll Test User ${crypto.randomUUID()}`,
    );

    const users = await userService.findAll();

    expect(users).toContainEqual(user);
  });
});

describe("userService.findById", () => {
  test("returns the matching user", async () => {
    const created = await createTestUser(
      `FindById Test User ${crypto.randomUUID()}`,
    );

    const found = await userService.findById(created.id);

    expect(found).toEqual(created);
  });

  test("throws AppError(NOT_FOUND) when the id does not exist", async () => {
    const missingId = crypto.randomUUID();

    try {
      await userService.findById(missingId);
      throw new Error("expected findById to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("NOT_FOUND");
      expect((error as AppError).httpStatus).toBe(404);
    }
  });
});

describe("userService.create", () => {
  test("adds and returns a new user", async () => {
    const name = `Service Test User ${crypto.randomUUID()}`;
    const user = await createTestUser(name);

    expect(user.name).toBe(name);
    expect(await userService.findById(user.id)).toEqual(user);
  });

  test("throws AppError(ALREADY_EXISTS) for a duplicate name", async () => {
    const name = `Duplicate Service User ${crypto.randomUUID()}`;
    await createTestUser(name);

    try {
      await userService.create(name);
      throw new Error("expected create to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("ALREADY_EXISTS");
      expect((error as AppError).context).toEqual({ name });
    }
  });
});
