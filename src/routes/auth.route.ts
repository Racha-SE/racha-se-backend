import { Elysia } from "elysia";
import { auth } from "@/utils";

// Mounted outside the /v1 prefix (see src/index.ts) — better-auth's handler
// already responds at /api/auth/* via its own internal basePath default, so
// no path is passed to .mount() here (passing one would add an *extra*
// prefix on top, e.g. .mount('/auth', ...) -> /auth/api/auth).
export const authRoute = new Elysia().mount(auth.handler);
