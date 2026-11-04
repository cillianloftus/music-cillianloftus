import { describe, expect, it } from 'vitest';
import { verify } from './verify';

const sum = (c: string) => c.repeat(64);

describe('verify', () => {
  const known = [
    { path: 'D:\\Music/Tape/01.flac', checksum: sum('a') },
    { path: 'D:\\Music/Tape/02.flac', checksum: sum('b') },
    { path: 'D:\\Music/Tape/03.flac', checksum: sum('c') },
    { path: 'D:\\Music/Tape/04.flac', checksum: null },
    { path: 'D:\\Music/Other/01.flac', checksum: sum('d') },
  ];

  it('sorts a folder into unchanged, changed, missing, new and unchecked', () => {
    const result = verify(
      known,
      [
        { path: 'd:/music/tape/01.flac', checksum: sum('a') },
        { path: 'D:/Music/Tape/02.flac', checksum: sum('x') },
        { path: 'D:/Music/Tape/04.flac', checksum: sum('e') },
        { path: 'D:/Music/Tape/05.flac', checksum: sum('f') },
      ],
      'D:\\Music\\Tape',
    );
    expect(result).toEqual({
      ok: ['D:\\Music/Tape/01.flac'],
      changed: ['D:\\Music/Tape/02.flac'],
      missing: ['D:\\Music/Tape/03.flac'],
      unknown: ['D:/Music/Tape/05.flac'],
      unchecked: ['D:\\Music/Tape/04.flac'],
    });
  });

  it('only calls missing what was catalogued under the folder checked', () => {
    expect(verify(known, [], 'D:/Music/Other').missing).toEqual(['D:\\Music/Other/01.flac']);
  });
});
