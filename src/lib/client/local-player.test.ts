import { describe, expect, it } from 'vitest';
import { shuffled } from './local-player';

describe('shuffling your files', () => {
  it('keeps the song on now first and plays every other song once', () => {
    for (let run = 0; run < 20; run++) {
      const order = shuffled(12, 5);
      expect(order[0]).toBe(5);
      expect([...order].sort((a, b) => a - b)).toEqual([...Array(12).keys()]);
    }
  });

  it('mixes the rest, not the listed order every time', () => {
    const orders = new Set(Array.from({ length: 30 }, () => shuffled(10, 0).join(',')));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('shuffles the whole queue when nothing leads (repeating it all)', () => {
    expect([...shuffled(4, null)].sort()).toEqual([0, 1, 2, 3]);
  });
});
