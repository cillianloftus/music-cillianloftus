import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('MusicBrainz answers kept a few minutes', () => {
  it('ask once for a release the import and the pass after it both need', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'r1', media: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { getRelease, getReleaseMore, getReleaseGroup, getReleaseGroupSeries } = await import('./client');
    const a = await getRelease('11111111-1111-1111-1111-111111111111');
    const b = await getReleaseMore<{ id: string }>('11111111-1111-1111-1111-111111111111');
    expect(b).toEqual(a);
    await getReleaseGroup('22222222-2222-2222-2222-222222222222');
    await getReleaseGroupSeries('22222222-2222-2222-2222-222222222222');
    expect(fetch).toHaveBeenCalledTimes(2);
    // Each caller has its own copy.
    (a as unknown as { id: string }).id = 'changed';
    expect((await getRelease('11111111-1111-1111-1111-111111111111') as unknown as { id: string }).id).toBe('r1');
  });
});
