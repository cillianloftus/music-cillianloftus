import { describe, expect, it } from 'vitest';
import { splitVersion, versionPairs, type VersionCandidate } from './versions';

describe('splitVersion', () => {
  it('sets version words aside, in brackets or after a dash', () => {
    expect(splitVersion('Song (Kaytranada Remix)')).toEqual({ song: 'song', version: 'Kaytranada Remix' });
    expect(splitVersion('Song - Sped Up')).toEqual({ song: 'song', version: 'Sped Up' });
    expect(splitVersion('Song [Acoustic] (feat. Someone)')).toEqual({ song: 'song', version: 'Acoustic' });
    expect(splitVersion('Song (Live at Wembley)').version).toBe('Live at Wembley');
  });

  it('leaves the song itself, and brackets that are part of a title, alone', () => {
    expect(splitVersion('Song (feat. Someone)')).toEqual({ song: 'song', version: null });
    expect(splitVersion('(Nothing But) Flowers')).toEqual({ song: 'nothing but flowers', version: null });
    expect(splitVersion('Song (Interlude)').version).toBeNull();
    expect(splitVersion('Mixtape Song').version).toBeNull();
    expect(splitVersion('Song - Edition Two').version).toBeNull();
  });
});

describe('versionPairs', () => {
  const rec = (id: string, title: string, extra: Partial<VersionCandidate> = {}): VersionCandidate => ({
    id,
    title,
    artist_id: 'artist',
    work_id: null,
    studio: 1,
    ...extra,
  });
  const generic = /^(intro|outro)$/;

  it('pairs every version with the original, original first', () => {
    const pairs = versionPairs(
      [rec('o', 'Song'), rec('r1', 'Song (A Remix)'), rec('r2', 'Song - Slowed'), rec('other', 'Other Song (Remix)')],
      generic,
    );
    expect(pairs).toEqual([
      ['o', 'r1'],
      ['o', 'r2'],
    ]);
  });

  it('needs an original, the same artist, and leaves linked songs alone', () => {
    expect(versionPairs([rec('r1', 'Song (Remix)'), rec('r2', 'Song (VIP)')], generic)).toEqual([]);
    expect(versionPairs([rec('o', 'Song'), rec('r', 'Song (Remix)', { artist_id: 'someone else' })], generic)).toEqual([]);
    expect(versionPairs([rec('o', 'Song', { work_id: 'w' }), rec('r', 'Song (Remix)', { work_id: 'w' })], generic)).toEqual([]);
    expect(versionPairs([rec('o', 'Intro'), rec('r', 'Intro (Remix)')], generic)).toEqual([]);
  });

  it('anchors on the original already in a work', () => {
    const pairs = versionPairs([rec('a', 'Song'), rec('b', 'Song', { work_id: 'w' }), rec('r', 'Song (Remix)')], generic);
    expect(pairs).toEqual([['b', 'r']]);
  });
});
