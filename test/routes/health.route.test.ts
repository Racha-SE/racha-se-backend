import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { healthRoute } from "@/routes";
import type { SuccessResponse } from "@/utils";

const app = new Elysia().use(healthRoute);

describe("GET /health", () => {
  test("returns a success envelope with status ok", async () => {
    const response = await app.handle(new Request("http://localhost/health"));
    const body = (await response.json()) as SuccessResponse<{ status: "ok" }>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { status: "ok" } });
  });
});
