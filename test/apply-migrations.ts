import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Setup files execute outside per-test-file storage isolation. Applying an
// already-recorded migration is safe and leaves every test file with the schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
