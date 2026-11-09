/**
 * Insights from what is known of each track beyond the rating (migration
 * 0054): its tempo, and how many people listen to it on ListenBrainz.
 * Worked out from the track facts the Insights page already has. Pure.
 */

import type { Band } from './insights-deeper';
import type { TrackFact } from './discover';

/** Tempo bands, slowest first: ballad pace, mid-tempo, upbeat, fast. */
const TEMPO_BANDS: { key: string; label: string; from: number; to: number }[] = [
  { key: 'slow', label: 'Under 90 BPM', from: 0, to: 90 },
  { key: 'mid', label: '90 to 110', from: 90, to: 110 },
  { key: 'up', label: '110 to 130', from: 110, to: 130 },
  { key: 'quick', label: '130 to 150', from: 130, to: 150 },
  { key: 'fast', label: '150 BPM and up', from: 150, to: Infinity },
];

/** Average score in each tempo band, for tracks whose tempo is known. */
export function tempoBands(facts: TrackFact[]): Band[] {
  return TEMPO_BANDS.map((band) => {
    const inBand = facts.filter((f) => f.bpm !== null && f.bpm >= band.from && f.bpm < band.to);
    return {
      key: band.key,
      label: band.label,
      count: inBand.length,
      average: inBand.length ? inBand.reduce((sum, f) => sum + f.score, 0) / inBand.length : 0,
    };
  }).filter((b) => b.count > 0);
}

/** Where few people listen: fewer than this many on ListenBrainz. */
export const FEW_LISTENERS = 2000;

/** The best-rated tracks few people listen to, best first. */
export function hiddenGems(facts: TrackFact[], limit = 8, floor = 80): TrackFact[] {
  return facts
    .filter((f) => f.listeners !== null && f.listeners < FEW_LISTENERS && f.score >= floor)
    .sort((a, b) => b.score - a.score || (a.listeners ?? 0) - (b.listeners ?? 0))
    .slice(0, limit);
}

/** The middle listener count of the rated tracks ListenBrainz knows, and how many those are. */
export function medianListeners(facts: TrackFact[]): { median: number; known: number } | null {
  const counts = facts
    .map((f) => f.listeners)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  if (counts.length < 10) return null;
  const mid = Math.floor(counts.length / 2);
  const median = counts.length % 2 ? counts[mid]! : (counts[mid - 1]! + counts[mid]!) / 2;
  return { median, known: counts.length };
}
