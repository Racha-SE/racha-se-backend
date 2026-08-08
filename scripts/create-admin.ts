import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { user } from "@/db/schema";
import { auth } from "@/utils";

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const firstname = process.env.ADMIN_FIRSTNAME;
const lastname = process.env.ADMIN_LASTNAME;
const username = process.env.ADMIN_USERNAME;

if (!email || !password || !firstname || !lastname || !username) {
  console.error(
    "Missing required env vars: ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FIRSTNAME, ADMIN_LASTNAME, ADMIN_USERNAME.",
  );
  process.exit(1);
}

const [existingAdmin] = await db
  .select({ email: user.email })
  .from(user)
  .where(eq(user.role, "admin"))
  .limit(1);

if (existingAdmin) {
  console.error(
    `An admin already exists (${existingAdmin.email}). Refusing to create ` +
      "another via this script — sign in and use POST /admin/create-user instead.",
  );
  process.exit(1);
}

const created = await auth.api.createUser({
  body: {
    email,
    password,
    name: `${firstname} ${lastname}`,
    role: "admin",
    data: {
      userType: "hq",
      firstname,
      lastname,
      username,
    },
  },
});

console.log(
  `Created admin user: ${created.user.email} (id: ${created.user.id})`,
);
process.exit(0);
