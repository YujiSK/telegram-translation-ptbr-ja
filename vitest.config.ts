import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Phase 9.1A: the `ai` binding declared in wrangler.jsonc has no
        // local Miniflare emulation — Cloudflare's own Workers AI
        // binding always talks to the real account, even in local dev.
        // `remoteBindings: false` keeps the test pool from starting a
        // live remote-proxy session for it; every test that exercises
        // Workers AI code injects its own fake `AI` binding into `env`
        // instead (see test/infrastructure/workers-ai/), so `env.AI.run()`
        // is never actually invoked by any automated test.
        remoteBindings: false,
        miniflare: {
          // Test-only serializable binding consumed by test/apply-migrations.ts.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
