declare namespace Cloudflare {
  // TEST_MIGRATIONS is a test-only Miniflare binding. DB is generated from
  // wrangler.jsonc in worker-configuration.d.ts.
  interface Env {
    readonly TEST_MIGRATIONS: Array<{ readonly name: string; readonly queries: string[] }>;
  }
}
