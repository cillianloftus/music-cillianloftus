export function formatDuration(ms: number | null): string | null {
  if (ms == null) return null;
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** Spoken form for screen readers: "3 minutes 41 seconds". */
export function describeDuration(ms: number | null): string | null {
  if (ms == null) return null;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts = [];
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  return parts.join(' ') || '0 seconds';
}

const TYPE_LABELS: Record<string, string> = {
  album: 'Album',
  ep: 'EP',
  single: 'Single',
  compilation: 'Compilation',
  mixtape: 'Mixtape',
  soundtrack: 'Soundtrack',
  live: 'Live album',
};

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

const ROLE_LABELS: Record<string, [singular: string, plural: string]> = {
  featured: ['Featured', 'Featured'],
  producer: ['Producer', 'Producers'],
  writer: ['Writer', 'Writers'],
  engineer: ['Engineer', 'Engineers'],
  mixer: ['Mixing engineer', 'Mixing engineers'],
  mastering_engineer: ['Mastering engineer', 'Mastering engineers'],
  recording_engineer: ['Recording engineer', 'Recording engineers'],
  composer: ['Composer', 'Composers'],
  lyricist: ['Lyricist', 'Lyricists'],
  co_producer: ['Co-producer', 'Co-producers'],
  remixer: ['Remixer', 'Remixers'],
  performer: ['Performer', 'Performers'],
};

/**
 * A role's heading over its credits: plural where that reads better
 * ("Writers"), otherwise the role's own label as stored ("Lead vocals").
 */
export function roleLabel(role: string, count = 1, stored?: string): string {
  const labels = ROLE_LABELS[role];
  return labels ? labels[count === 1 ? 0 : 1] : (stored ?? role);
}

/** "3 days ago", "last month": for dates where the exact day matters less than the feel. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const seconds = (new Date(iso).getTime() - now.getTime()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/**
 * The hue a score is drawn in (oklch: about 25 red, 95 yellow, 145 green),
 * following what the numbers mean: under 50 is disliked, so red to orange;
 * 50 to 60 is neither way, a neutral yellow; from 70, genuinely enjoyed,
 * green, deepening through great (80) and amazing (90). Points between are
 * drawn proportionally.
 */
const HUE_STOPS: [number, number][] = [
  [0, 20],
  [45, 42],
  [50, 82],
  [60, 98],
  [70, 122],
  [80, 136],
  [90, 146],
  [100, 152],
];

/**
 * What a score means, in a word or two, on the scale it is given by
 * (0 to 100; an axis's 7.5 is 75): under 50 not liked, 50 okay, above it
 * liked, 70 genuinely enjoyed, 80 great, 90 amazing.
 */
export const SCORE_BANDS: [number, string][] = [
  [90, 'amazing'],
  [80, 'great'],
  [70, 'enjoy'],
  [60, 'like'],
  [50, 'okay'],
  [0, 'don’t like'],
];

export function scoreWord(score: number): string {
  return SCORE_BANDS.find(([from]) => score >= from)![1];
}

export function scoreHue(score: number): number {
  const s = Math.max(0, Math.min(100, score));
  for (let i = 1; i < HUE_STOPS.length; i++) {
    const [x1, h1] = HUE_STOPS[i]!;
    if (s <= x1) {
      const [x0, h0] = HUE_STOPS[i - 1]!;
      return Math.round(h0 + ((h1 - h0) * (s - x0)) / (x1 - x0));
    }
  }
  return HUE_STOPS.at(-1)![1];
}

/** The colour classes and hue for a displayed score. */
export function scoreTone(score: number): { className: string; style: string } {
  return score > 100
    ? { className: 'tone--beyond', style: '' }
    : { className: 'tone', style: `--h: ${scoreHue(score)}` };
}

/** "41 min", "1 hr 12 min": an album's running time. */
export function describeLength(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}
