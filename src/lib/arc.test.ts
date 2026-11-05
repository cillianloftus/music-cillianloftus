import { describe, expect, it } from 'vitest';
import { arcOf, hasArc, when, type ArcRelease } from './arc';

const release = (id: string, date: string, score: number, type = 'album'): ArcRelease => ({ id, title: id, type, date, score });

describe('when', () => {
  it('places a release within its year by month and day, the middle when unknown', () => {
    expect(when('2016')).toBeCloseTo(2016.5, 1);
    expect(when('2016-01-01')).toBe(2016);
    expect(when('2016-12')).toBeGreaterThan(when('2016-06'));
  });
});

describe('hasArc', () => {
  it('needs three scored releases over at least two years', () => {
    expect(hasArc([release('a', '2010', 80), release('b', '2011', 70)])).toBe(false);
    expect(hasArc([release('a', '2010', 80), release('b', '2010-05', 70), release('c', '2010-09', 60)])).toBe(false);
    expect(hasArc([release('a', '2010', 80), release('b', '2012', 70), release('c', '2014', 60)])).toBe(true);
  });
});

describe('arcOf', () => {
  const releases = [
    release('debut', '2010-03', 72),
    release('single', '2011-01', 95, 'single'),
    release('peak', '2014-06', 91),
    release('dip', '2018', 58),
  ];
  const arc = arcOf(releases);

  it('runs left to right by date and higher scores sit higher', () => {
    expect(arc.points.map((p) => p.id)).toEqual(['debut', 'single', 'peak', 'dip']);
    const at = (id: string) => arc.points.find((p) => p.id === id)!;
    expect(at('peak').y).toBeLessThan(at('debut').y);
    expect(at('dip').y).toBeGreaterThan(at('debut').y);
    for (const p of arc.points) {
      expect(p.x).toBeGreaterThanOrEqual(arc.plot.left);
      expect(p.x).toBeLessThanOrEqual(arc.plot.right);
      expect(p.y).toBeGreaterThanOrEqual(arc.plot.top);
      expect(p.y).toBeLessThanOrEqual(arc.plot.bottom);
    }
  });

  it('labels the best and worst records only, not a better single', () => {
    const labelled = Object.fromEntries(arc.points.filter((p) => p.label).map((p) => [p.label, p.id]));
    expect(labelled).toEqual({ best: 'peak', worst: 'dip' });
  });

  it('draws its line through the records, not the singles, and keys the two sizes', () => {
    expect(arc.path.match(/[ML]/g)).toHaveLength(3);
    expect(arc.mixed).toBe(true);
  });

  it('starts the scale a round step below the lowest score and keeps tidy year ticks', () => {
    expect(arc.yTicks.map((t) => t.value)).toEqual([40, 60, 80, 100]);
    expect(arc.xTicks.map((t) => t.year)).toEqual([2010, 2012, 2014, 2016, 2018]);
  });

  it('labels nothing as worst when every record scores the same', () => {
    const flat = arcOf([release('a', '2010', 80), release('b', '2012', 80), release('c', '2014', 80)]);
    expect(flat.points.filter((p) => p.label === 'worst')).toHaveLength(0);
  });
});

describe('placeLabel', () => {
  it('moves a label off the dots it would cover', () => {
    // A record with a run of releases just below and to its right.
    const crowded = arcOf([
      release('early', '2010', 60),
      release('best', '2014', 95),
      release('s1', '2014-09', 92, 'single'),
      release('s2', '2015-03', 91, 'single'),
      release('s3', '2015-09', 92, 'single'),
      release('late', '2018', 80),
    ]);
    const best = crowded.points.find((p) => p.id === 'best')!;
    expect(best.labelAt).not.toBeNull();
    expect(best.labelAt!.anchor === 'end' || best.labelAt!.y < best.y).toBe(true);
  });

  it('keeps a label inside the chart near the right edge', () => {
    const arc = arcOf([release('a', '2010', 60), release('b', '2012', 70), release('last one with a long title', '2020-12', 99)]);
    const last = arc.points.find((p) => p.label === 'best')!;
    expect(last.labelAt!.anchor).toBe('end');
  });
});
