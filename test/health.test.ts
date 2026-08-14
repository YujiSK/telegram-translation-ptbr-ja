import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

describe("GET /health", () => {
  it("returns 200 with the expected JSON body", async () => {
    const request = new Request("https://example.com/health");
    const ctx = createExecutionContext();

    const response = worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "telegram-translation-ptbr-ja",
    });
  });
});

describe("unknown routes", () => {
  it("returns a structured 404 for an unmapped path", async () => {
    const request = new Request("https://example.com/does-not-exist");
    const ctx = createExecutionContext();

    const response = worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Not Found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 for a non-GET request to /health", async () => {
    const request = new Request("https://example.com/health", { method: "POST" });
    const ctx = createExecutionContext();

    const response = worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });
});
