import { Elysia } from "elysia";
import { auth } from "@/utils";

// Mounted outside the /api/v1 prefix (see src/index.ts) — better-auth's
// handler already responds at /api/v1/auth/* via its own basePath (set in
// src/utils/auth.ts), so no path is passed to .mount() here (passing one
// would add an *extra* prefix on top, e.g. .mount('/auth', ...) would serve
// at /auth/api/v1/auth, not /api/v1/auth).
export const authRoute = new Elysia().mount(auth.handler);
