import { describe, expect, it } from 'vitest';
import { formatPartialDate, parsePartialDate } from './dates';
import { parseMbInput } from './musicbrainz/input';
import { safeReturnPath } from './ratings';
import { normaliseName, normaliseTitle } from './text';

describe('parsePartialDate', () => {
  it.each([
    ['1977', { date: '1977', precision: 'year' }],
    ['1977-02', { date: '1977-02', precision: 'month' }],
    ['1977-02-04', { date: '1977-02-04', precision: 'day' }],
    ['1977-02-30', { date: '1977-02', precision: 'month' }],
    ['1977-13', { date: null, precision: 'unknown' }],
    ['', { date: null, precision: 'unknown' }],
    [undefined, { date: null, precision: 'unknown' }],
  ])('%s', (input, expected) => {
    expect(parsePartialDate(input)).toEqual(expected);
  });
});

describe('formatPartialDate', () => {
  it('never invents precision', () => {
    expect(formatPartialDate('1977', 'year')).toBe('1977');
    expect(formatPartialDate('1977-02', 'month')).toBe('February 1977');
    expect(formatPartialDate('1977-02-04', 'day')).toBe('4 February 1977');
    expect(formatPartialDate(null, 'unknown')).toBeNull();
  });
});

describe('normaliseTitle', () => {
  it('strips edition suffixes', () => {
    expect(normaliseTitle('Dreams - 2004 Remaster')).toBe(normaliseTitle('Dreams'));
    expect(normaliseTitle('Rumours (Deluxe Edition)')).toBe(normaliseTitle('Rumours'));
  });

  it('keeps markers of a different recording', () => {
    expect(normaliseTitle('Dreams (Live)')).not.toBe(normaliseTitle('Dreams'));
    expect(normaliseTitle('Dreams - Demo')).not.toBe(normaliseTitle('Dreams'));
  });

  it('ignores case, accents, punctuation and leading articles', () => {
    expect(normaliseTitle('The Chain')).toBe(normaliseTitle('chain'));
    expect(normaliseTitle('Déjà Vu!')).toBe('deja vu');
    expect(normaliseTitle('Don’t Stop')).toBe(normaliseTitle("Don't Stop"));
  });
});

describe('normaliseName', () => {
  it('matches across ampersands and accents', () => {
    expect(normaliseName('Simon & Garfunkel')).toBe(normaliseName('Simon and Garfunkel'));
    expect(normaliseName('Björk')).toBe('bjork');
  });
});

describe('parseMbInput', () => {
  const id = '416bb5e5-c7d1-3977-8fd7-7c9daf6c2be6';

  it('reads release and release-group links', () => {
    expect(parseMbInput(`https://musicbrainz.org/release-group/${id}`)).toEqual({ entity: 'release-group', mbid: id });
    expect(parseMbInput(`https://musicbrainz.org/release/${id}/discids`)).toEqual({ entity: 'release', mbid: id });
  });

  it('takes a bare MBID as an album', () => {
    expect(parseMbInput(id.toUpperCase())).toEqual({ entity: 'release-group', mbid: id });
  });

  it('rejects other sites and other MusicBrainz entities', () => {
    expect(parseMbInput(`https://evil.example/release/${id}`)).toBeNull();
    expect(parseMbInput(`https://musicbrainz.org/artist/${id}`)).toBeNull();
    expect(parseMbInput('not a link')).toBeNull();
  });
});

describe('safeReturnPath', () => {
  it('allows same-site paths only', () => {
    expect(safeReturnPath('/album/1', '/')).toBe('/album/1');
    expect(safeReturnPath('//evil.example', '/')).toBe('/');
    expect(safeReturnPath('/\\evil.example', '/')).toBe('/');
    expect(safeReturnPath('https://evil.example', '/')).toBe('/');
    expect(safeReturnPath(undefined, '/x')).toBe('/x');
  });
});
