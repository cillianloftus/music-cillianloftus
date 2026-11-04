/**
 * Compares a folder on disk with the file catalogue: what is still there
 * unchanged, what has changed (a different checksum: re-ripped, re-tagged
 * or damaged), what is missing, and what is new. Pure, so the page and the
 * tests share it; runs in the browser, so nothing is uploaded.
 */

export interface KnownFile {
  path: string;
  checksum: string | null;
}

export interface Found {
  path: string;
  checksum: string;
}

export interface Verification {
  ok: string[];
  changed: string[];
  /** Catalogued under the folder checked, but not found in it. */
  missing: string[];
  /** In the folder, not catalogued. */
  unknown: string[];
  /** Catalogued without a checksum, so only presence could be checked. */
  unchecked: string[];
}

/** Paths compare without case or slash direction, as on Windows. */
const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();

export function verify(known: KnownFile[], found: Found[], folder: string): Verification {
  const prefix = norm(folder).replace(/\/$/, '') + '/';
  const inScope = known.filter((k) => norm(k.path).startsWith(prefix));
  const byPath = new Map(found.map((f) => [norm(f.path), f]));
  const result: Verification = { ok: [], changed: [], missing: [], unknown: [], unchecked: [] };
  const seen = new Set<string>();
  for (const k of inScope) {
    const f = byPath.get(norm(k.path));
    if (!f) {
      result.missing.push(k.path);
      continue;
    }
    seen.add(norm(k.path));
    if (!k.checksum) result.unchecked.push(k.path);
    else if (k.checksum === f.checksum) result.ok.push(k.path);
    else result.changed.push(k.path);
  }
  for (const f of found) if (!seen.has(norm(f.path))) result.unknown.push(f.path);
  return result;
}
