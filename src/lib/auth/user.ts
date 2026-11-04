import { env } from 'cloudflare:workers';

export interface AppUser {
  id: string;
  email: string;
  display_name: string;
  is_owner: 0 | 1;
}

/**
 * The local user row for a verified identity, created on first sight.
 * Cloudflare Access is the allowlist, so anyone who reaches this function
 * has already been let in.
 */
export async function userForEmail(email: string): Promise<AppUser> {
  const existing = await env.DB.prepare(
    'SELECT id, email, display_name, is_owner FROM app_user WHERE email = ?',
  )
    .bind(email)
    .first<AppUser>();
  if (existing) return existing;

  const isOwner = env.OWNER_EMAIL?.toLowerCase() === email.toLowerCase() ? 1 : 0;
  const displayName = email.split('@')[0] || email;

  // ON CONFLICT covers two first requests racing each other.
  await env.DB.prepare(
    `INSERT INTO app_user (id, email, display_name, is_owner)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), email, displayName, isOwner)
    .run();

  return (await env.DB.prepare(
    'SELECT id, email, display_name, is_owner FROM app_user WHERE email = ?',
  )
    .bind(email)
    .first<AppUser>())!;
}

/** The owner's id, whose ratings public pages show. Null before first login. */
export async function ownerId(): Promise<string | null> {
  const row = await env.DB.prepare('SELECT id FROM app_user WHERE is_owner = 1').first<{ id: string }>();
  return row?.id ?? null;
}
