import { describe, expect, it } from 'vitest';
import { OVERLOAD_PAUSE_MS, runTasks } from './health';

const overloaded = () => new Error('D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.');

describe('the nightly tasks', () => {
  it('waits out an overloaded database and tries again, so the tasks after it still run', async () => {
    const pauses: number[] = [];
    let tries = 0;
    const ran: string[] = [];
    const runs = await runTasks(
      [
        ['Heavy', async () => void ran.push('heavy')],
        [
          'Turned away once',
          async () => {
            if (tries++ === 0) throw overloaded();
            ran.push('second');
          },
        ],
        ['After', async () => void ran.push('after')],
      ],
      async (ms) => void pauses.push(ms),
    );
    expect(ran).toEqual(['heavy', 'second', 'after']);
    expect(runs.map((r) => r.ok)).toEqual([true, true, true]);
    expect(pauses).toEqual([OVERLOAD_PAUSE_MS]);
  });

  it('gives up on a task after three overloaded tries, and on any other error at once', async () => {
    const pauses: number[] = [];
    let other = 0;
    const runs = await runTasks(
      [
        ['Always overloaded', async () => { throw overloaded(); }],
        ['Broken', async () => { other++; throw new Error('no such column'); }],
        ['Fine', async () => {}],
      ],
      async (ms) => void pauses.push(ms),
    );
    expect(runs.map((r) => [r.name, r.ok])).toEqual([
      ['Always overloaded', false],
      ['Broken', false],
      ['Fine', true],
    ]);
    expect(pauses).toHaveLength(2);
    expect(other).toBe(1);
    expect(runs[1]!.error).toBe('no such column');
  });
});
