/**
 * Stand-in for the `cloudflare:workers` module under Vitest. Tests that
 * need a database assign `env.DB = d1(migratedDb())` (see src/test/d1.ts).
 */
export const env = {} as Env;
