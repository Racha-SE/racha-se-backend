import { Elysia } from "elysia";
import { userTypeEnum } from "@/db/schema/user";
import { auth } from "@/utils";

type UserType = (typeof userTypeEnum.enumValues)[number];

// .macro({ auth: {...} }) — routes opt in via `{ auth: true }` (any signed-in
// user) or `{ auth: ["hq"] }` (only those userTypes). Gates on `userType`
// (our business role), not better-auth's own `role` field — `role` only
// gates /admin/create-user (see src/utils/auth.ts), it isn't used for
// route-level authorization elsewhere.
export const authPlugin = new Elysia({ name: "auth" }).macro({
  auth: (allowedUserTypes: UserType[] | true) => ({
    async resolve({ status, request: { headers } }) {
      const session = await auth.api.getSession({ headers });

      if (!session) return status(401);

      if (
        allowedUserTypes !== true &&
        !allowedUserTypes.includes(session.user.userType)
      ) {
        return status(403);
      }

      return {
        user: session.user,
        session: session.session,
      };
    },
  }),
});
