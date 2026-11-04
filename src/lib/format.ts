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
  mixer: ['Mixing', 'Mixing'],
  remixer: ['Remixer', 'Remixers'],
  performer: ['Performer', 'Performers'],
};

export function roleLabel(role: string, count = 1): string {
  const labels = ROLE_LABELS[role];
  return labels ? labels[count === 1 ? 0 : 1] : role;
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
