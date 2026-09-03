import { userTypeEnum } from "@/db/schema/user";
import { AppError } from "./error";

export type UserType = (typeof userTypeEnum.enumValues)[number];

/** The subset of a session's `user` every hierarchy check needs. */
export interface ScopedActor {
  id: string;
  userType: UserType;
  branchId: number | null;
}

/**
 * Which userTypes an actor's userType is allowed to create/deactivate.
 * hq acts system-wide; branch is confined to cashiers in its own branch;
 * cashier/customer manage no one.
 */
const MANAGEABLE_USER_TYPES: Record<UserType, UserType[]> = {
  hq: ["hq", "branch", "cashier", "customer"],
  branch: ["cashier"],
  cashier: [],
  customer: [],
};

/**
 * Branch-scoping check shared by any branch-scoped route (users today,
 * orders/inventory later): hq sees/acts system-wide, everyone else is
 * confined to their own branchId. Throws FORBIDDEN otherwise.
 */
export function assertBranchScope(
  actor: ScopedActor,
  targetBranchId: number | null,
): void {
  if (actor.userType === "hq") return;

  if (actor.branchId === null || actor.branchId !== targetBranchId) {
    throw new AppError("FORBIDDEN", {
      reason: "target is outside the caller's branch",
    });
  }
}

/**
 * Can `actor` create/deactivate a user of `target.userType` in
 * `target.branchId`? Combines the userType hierarchy with branch scoping.
 */
export function assertCanManageUser(
  actor: ScopedActor,
  target: { userType: UserType; branchId: number | null },
): void {
  if (!MANAGEABLE_USER_TYPES[actor.userType].includes(target.userType)) {
    throw new AppError("FORBIDDEN", {
      reason: `${actor.userType} cannot manage ${target.userType} users`,
    });
  }

  assertBranchScope(actor, target.branchId);
}
