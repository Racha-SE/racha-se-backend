import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  or,
} from "drizzle-orm";
import { APIError } from "better-auth";
import { db } from "@/db/client";
import { branch, session, user } from "@/db/schema";
import type {
  CreateUserBody,
  ListUsersQuery,
  ListUsersResult,
  UpdateUserBody,
  User,
} from "@/models/users.model";
import {
  AppError,
  assertBranchScope,
  assertCanManageUser,
  auth,
  type ScopedActor,
} from "@/utils";

async function requireUserById(id: string): Promise<User> {
  const [target] = await db.select().from(user).where(eq(user.id, id));
  if (!target) throw new AppError("NOT_FOUND");
  return target;
}

async function assertUsernameAvailable(username: string): Promise<void> {
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, username));
  if (existing) throw new AppError("ALREADY_EXISTS", { username });
}

async function assertEmailAvailable(email: string): Promise<void> {
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));
  if (existing) throw new AppError("ALREADY_EXISTS", { email });
}

async function assertBranchExists(branchId: number): Promise<void> {
  const [existing] = await db
    .select({ branchId: branch.branchId })
    .from(branch)
    .where(eq(branch.branchId, branchId));
  if (!existing)
    throw new AppError("BAD_REQUEST", { reason: "branch not found", branchId });
}

export const usersService = {
  async list(
    actor: ScopedActor,
    query: ListUsersQuery,
  ): Promise<ListUsersResult> {
    // branch callers are always scoped to their own branch, regardless of
    // what (if anything) they pass as ?branchId — only hq can filter/see
    // across branches.
    const branchId = actor.userType === "hq" ? query.branchId : actor.branchId;
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const conditions = [
      branchId !== undefined && branchId !== null
        ? eq(user.branchId, branchId)
        : undefined,
      query.userType ? eq(user.userType, query.userType) : undefined,
      query.isRoot ? eq(user.role, "admin") : undefined,
      query.status ? eq(user.banned, query.status === "inactive") : undefined,
      query.search
        ? or(
            ilike(user.username, `%${query.search}%`),
            ilike(user.email, `%${query.search}%`),
            ilike(user.firstname, `%${query.search}%`),
            ilike(user.lastname, `%${query.search}%`),
          )
        : undefined,
    ].filter((condition) => condition !== undefined);
    const where = conditions.length ? and(...conditions) : undefined;

    // Only the columns a caller actually toggled, in the frontend's fixed
    // priority order (id, username, email, branch name) — falls back to id
    // ascending so paginated pages stay stable when nothing is toggled.
    const orderBy = [
      query.sortId && (query.sortId === "asc" ? asc(user.id) : desc(user.id)),
      query.sortUsername &&
        (query.sortUsername === "asc"
          ? asc(user.username)
          : desc(user.username)),
      query.sortEmail &&
        (query.sortEmail === "asc" ? asc(user.email) : desc(user.email)),
      query.sortBranch &&
        (query.sortBranch === "asc" ? asc(branch.name) : desc(branch.name)),
    ].filter((clause): clause is NonNullable<typeof clause> => Boolean(clause));
    if (orderBy.length === 0) orderBy.push(asc(user.id));

    const [users, [{ total }]] = await Promise.all([
      db
        .select(getTableColumns(user))
        .from(user)
        // Branch name is only needed for the sortBranch column above — a
        // left join (not inner) so hq/customer rows with no branch still
        // come back, same as every other filter here.
        .leftJoin(branch, eq(branch.branchId, user.branchId))
        .where(where)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(user).where(where),
    ]);

    return {
      users,
      total,
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      totalPages: Math.ceil(total / limit),
    };
  },

  async getById(actor: ScopedActor, id: string): Promise<User> {
    const target = await requireUserById(id);
    assertBranchScope(actor, target.branchId);

    return target;
  },

  async update(
    actor: ScopedActor,
    id: string,
    body: UpdateUserBody,
  ): Promise<User> {
    const target = await requireUserById(id);

    assertBranchScope(actor, target.branchId);
    if (body.branchId !== undefined) {
      assertBranchScope(actor, body.branchId);
      if (body.branchId !== null) await assertBranchExists(body.branchId);
    }

    if (body.username && body.username !== target.username) {
      await assertUsernameAvailable(body.username);
    }

    const [updated] = await db
      .update(user)
      .set(body)
      .where(eq(user.id, id))
      .returning();

    return updated;
  },

  async create(actor: ScopedActor, body: CreateUserBody): Promise<User> {
    // branch callers creating a cashier don't have to repeat their own
    // branchId — default it for them.
    const targetBranchId =
      body.branchId ?? (actor.userType === "branch" ? actor.branchId : null);

    assertCanManageUser(actor, {
      userType: body.userType,
      branchId: targetBranchId,
    });

    if (
      (body.userType === "branch" || body.userType === "cashier") &&
      !targetBranchId
    ) {
      throw new AppError("BAD_REQUEST", {
        reason: "branchId is required for branch and cashier users",
      });
    }

    if (targetBranchId) await assertBranchExists(targetBranchId);

    await assertEmailAvailable(body.email);
    await assertUsernameAvailable(body.username);

    const {
      password,
      email,
      firstname,
      lastname,
      username,
      birthdate,
      image,
      userType,
    } = body;

    try {
      const result = await auth.api.createUser({
        body: {
          email,
          password,
          name: `${firstname} ${lastname}`,
          data: {
            userType,
            firstname,
            lastname,
            username,
            birthdate,
            branchId: targetBranchId,
            image,
          },
        },
      });
      return await requireUserById(result.user.id);
    } catch (error) {
      if (error instanceof APIError) {
        throw new AppError("BAD_REQUEST", {
          message: error.body?.message ?? "failed to create user",
        });
      }
      throw error;
    }
  },

  async deactivate(actor: ScopedActor, id: string): Promise<User> {
    if (id === actor.id) {
      throw new AppError("BAD_REQUEST", {
        reason: "cannot deactivate your own account",
      });
    }

    const target = await requireUserById(id);

    assertCanManageUser(actor, {
      userType: target.userType,
      branchId: target.branchId,
    });

    const [updated] = await db
      .update(user)
      .set({ banned: true, banReason: "Deactivated by admin" })
      .where(eq(user.id, id))
      .returning();

    await db.delete(session).where(eq(session.userId, id));

    return updated;
  },

  async reactivate(actor: ScopedActor, id: string): Promise<User> {
    const target = await requireUserById(id);

    assertCanManageUser(actor, {
      userType: target.userType,
      branchId: target.branchId,
    });

    const [updated] = await db
      .update(user)
      .set({ banned: false, banReason: null, banExpires: null })
      .where(eq(user.id, id))
      .returning();

    return updated;
  },
};
