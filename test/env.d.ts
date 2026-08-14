declare module "cloudflare:workers" {
  // Declaration merging with the vitest-pool-workers-provided ProvidedEnv,
  // per https://developers.cloudflare.com/workers/testing/vitest-integration/.
  // Currently empty because no bindings exist yet (Phase 0).
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}
