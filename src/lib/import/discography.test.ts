import { describe, expect, it } from 'vitest';
import { wanted, type Kind } from './discography';

const g = (primary: string | null, secondary: string[] = []) => ({ id: 'x', title: 'x', 'primary-type': primary, 'secondary-types': secondary });
const kinds = (...k: Kind[]) => new Set<Kind>(k);

describe('which releases a discography import takes', () => {
  it('takes studio albums and EPs by default, not singles, live or compilations', () => {
    const def = kinds('album', 'ep');
    expect(wanted(g('Album'), def)).toBe(true);
    expect(wanted(g('Album', ['Mixtape/Street']), def)).toBe(true);
    expect(wanted(g('EP'), def)).toBe(true);
    expect(wanted(g('Single'), def)).toBe(false);
    expect(wanted(g('Album', ['Live']), def)).toBe(false);
    expect(wanted(g('Album', ['Compilation']), def)).toBe(false);
    expect(wanted(g('Album', ['Remix']), def)).toBe(false);
  });

  it('takes the extra kinds when asked, and never interviews or spoken word', () => {
    const all = kinds('album', 'ep', 'single', 'live', 'compilation');
    expect(wanted(g('Single'), all)).toBe(true);
    expect(wanted(g('Album', ['Live']), all)).toBe(true);
    expect(wanted(g('Album', ['Compilation']), all)).toBe(true);
    expect(wanted(g('Other', ['Interview']), all)).toBe(false);
    expect(wanted(g('Album', ['Spokenword']), all)).toBe(false);
  });
});
