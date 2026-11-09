import { describe, expect, it } from 'vitest';
import type { MbRelease, MbReleaseGroup, MbReleaseSummary } from '../musicbrainz/types';
import { buildPlan, chooseRelease, mapReleaseGroupType, preciseRole } from './musicbrainz';

const release = (id: string, date: string | undefined, tracks: number[], extra: Partial<MbReleaseSummary> = {}): MbReleaseSummary => ({
  id,
  title: 'T',
  status: 'Official',
  date,
  media: tracks.map((count) => ({ format: 'CD', 'track-count': count })),
  ...extra,
});

describe('chooseRelease', () => {
  it('prefers the standard edition when several share the release day', () => {
    // Vanisher, Horizon Scraper: the US CD (16) is listed first on MusicBrainz.
    const chosen = chooseRelease([
      release('cd', '2025-07-25', [16]),
      release('vinyl', '2025-07-25', [9, 8]),
      release('hires', '2025-07-25', [14], { disambiguation: '24-Bit/48 kHz' }),
      release('digital', '2025-07-25', [14]),
      release('extended', '2026-02-03', [16, 3], { disambiguation: 'The Extended Cut' }),
    ]);
    expect(chosen?.id).toBe('digital');
  });

  it('prefers a full date over a bare year in the same year', () => {
    expect(chooseRelease([release('de', '1977', [11]), release('us', '1977-02-04', [11])])?.id).toBe('us');
  });

  it('prefers official releases and puts undated ones last', () => {
    const chosen = chooseRelease([
      release('bootleg', '1970', [10], { status: 'Bootleg' }),
      release('undated', undefined, [10]),
      release('official', '1980', [10]),
    ]);
    expect(chosen?.id).toBe('official');
  });

  it('is stable regardless of input order', () => {
    const a = release('a', '2000', [10]);
    const b = release('b', '2000', [10]);
    expect(chooseRelease([a, b])?.id).toBe(chooseRelease([b, a])?.id);
  });
});

describe('mapReleaseGroupType', () => {
  it.each([
    ['Album', [], 'album'],
    ['Album', ['Live'], 'live'],
    ['Album', ['Compilation'], 'compilation'],
    ['Album', ['Mixtape/Street'], 'mixtape'],
    ['EP', [], 'ep'],
    [null, [], 'album'],
  ] as const)('%s + %j -> %s', (primary, secondary, expected) => {
    expect(mapReleaseGroupType(primary, [...secondary])).toBe(expected);
  });
});

describe('buildPlan', () => {
  const artist = (id: string, name: string) => ({ id, name, 'sort-name': name });
  const group: MbReleaseGroup = {
    id: 'rg',
    title: 'Album',
    'primary-type': 'Album',
    'secondary-types': [],
    'first-release-date': '2020-05-01',
    'artist-credit': [{ name: 'Main', joinphrase: '', artist: artist('main', 'Main') }],
    genres: [
      { name: 'rock', count: 4 },
      { name: 'pop', count: 2 },
    ],
  };
  const mbRelease: MbRelease = {
    id: 'rel',
    title: 'Album',
    status: 'Official',
    date: '2020-05-01',
    country: 'GB',
    'artist-credit': [{ name: 'Main', joinphrase: '', artist: artist('main', 'Main') }],
    'release-group': group,
    'label-info': [{ label: { name: 'Label' } }],
    relations: [{ type: 'producer', 'target-type': 'artist', artist: artist('prod', 'Producer') }],
    media: [
      {
        position: 1,
        format: 'CD',
        tracks: [
          {
            id: 't1',
            position: 1,
            title: 'Song (Album Version)',
            length: 200000,
            recording: {
              id: 'rec1',
              title: 'Song',
              length: 200000,
              'first-release-date': '2020-05',
              isrcs: ['GBAAA2000001'],
              'artist-credit': [
                { name: 'Main', joinphrase: ' feat. ', artist: artist('main', 'Main') },
                { name: 'Guest Name', joinphrase: '', artist: artist('guest', 'Guest') },
              ],
              relations: [
                {
                  type: 'performance',
                  'target-type': 'work',
                  work: {
                    id: 'work1',
                    title: 'Song',
                    relations: [{ type: 'composer', 'target-type': 'artist', artist: artist('writer', 'Writer') }],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const plan = buildPlan(mbRelease, group);

  it('maps the release group and edition', () => {
    expect(plan.releaseGroup).toMatchObject({ mbid: 'rg', type: 'album', first_release_date: '2020-05-01', date_precision: 'day' });
    expect(plan.release).toMatchObject({ mbid: 'rel', country: 'GB', label: 'Label', format: 'CD' });
  });

  it('keeps the track title only where it differs from the recording', () => {
    expect(plan.tracks).toEqual([{ recording_key: 'rec1', disc: 1, position: 1, title_on_release: 'Song (Album Version)' }]);
  });

  it('links the recording to its work, with its partial date and ISRC', () => {
    expect(plan.recordings[0]).toMatchObject({ work_key: 'work1', date_precision: 'month', isrc: 'GBAAA2000001' });
  });

  it('treats artists after "feat." as featured, keeping how they were credited', () => {
    const recordingCredits = plan.credits.filter((c) => c.entity === 'recording' && c.entity_key === 'rec1');
    expect(recordingCredits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artist_key: 'main', role: 'primary', join_phrase: ' feat. ' }),
        expect.objectContaining({ artist_key: 'guest', role: 'featured', credited_as: 'Guest Name' }),
        expect.objectContaining({ artist_key: 'writer', role: 'composer' }),
      ]),
    );
  });

  it('credits release-level producers to every track, not the album', () => {
    const producers = plan.credits.filter((c) => c.artist_key === 'prod' && c.role === 'producer');
    expect(producers.length).toBe(plan.recordings.length);
    expect(producers.every((c) => c.entity === 'recording')).toBe(true);
  });

  it('weights genres relative to the most voted', () => {
    expect(plan.releaseGroupGenres).toEqual([
      { name: 'rock', weight: 1 },
      { name: 'pop', weight: 0.5 },
    ]);
  });
});

describe('precise credit roles', () => {
  const id = (type: string, attributes?: string[]) => preciseRole(type, attributes)?.id ?? null;

  it('names the instrument itself, not its family', () => {
    expect(id('instrument', ['alto saxophone'])).toBe('alto_saxophone');
    expect(id('instrument', ['turntables'])).toBe('turntables');
    expect(preciseRole('instrument', ['electric guitar'])).toEqual({ id: 'electric_guitar', label: 'Electric guitar', family: 'performance' });
    expect(id('instrument', [])).toBe('performer');
  });

  it('keeps the kind of vocals, and the qualifiers that make a role of their own', () => {
    expect(id('vocal', ['background vocals'])).toBe('background_vocals');
    expect(id('vocal', [])).toBe('lead_vocals');
    expect(id('instrument', ['additional', 'guitar'])).toBe('additional_guitar');
    expect(id('instrument', ['guest', 'piano'])).toBe('piano');
    expect(id('executive producer')).toBe('executive_producer');
    expect(id('producer', ['co'])).toBe('co_producer');
    expect(id('engineer', ['assistant'])).toBe('assistant_engineer');
    expect(id('mix', ['additional'])).toBe('additional_mixer');
  });

  it('takes relation types the coarse mapping left out, and none it does not know', () => {
    expect(id('orchestrator')).toBe('orchestration');
    expect(id('vocal arranger')).toBe('vocal_arranger');
    expect(id('misc')).toBeNull();
  });
});
