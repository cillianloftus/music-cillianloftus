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
 * The hue a score is drawn in: 25 (red) at 0 to 145 (green) at 100. Bent
 * so the top of the scale, where most ratings live, spreads out: 70 is
 * yellow, 90 yellow-green, 100 green.
 */
export function scoreHue(score: number): number {
  const t = Math.max(0, Math.min(1, score / 100));
  return Math.round(25 + 120 * t ** 1.5);
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
