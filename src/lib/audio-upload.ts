/**
 * Sending your audio from the browser (Import from files): each file is
 * matched to its song (POST /api/write/audio/match, by checksum first, so
 * a file just catalogued is found at once), then those not yet uploaded
 * are sent to the private store (PUT /api/write/audio/upload), two at a
 * time. Browser-only; nothing here touches the database directly.
 */

import { MAX_AUDIO_BYTES } from './audio-limits';

export interface LocalAudio {
  file: File;
  /** The path as catalogued (with the folder location put in front). */
  path: string;
  format: string;
  checksum: string;
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  lengthMs: number | null;
  mbRecordingId: string | null;
}

export interface UploadReport {
  uploaded: number;
  /** Already uploaded before: nothing sent. */
  already: number;
  failed: number;
  tooBig: number;
  /** Matched no song (an album still importing from MusicBrainz, say). */
  unmatched: string[];
}

type Match = { path: string; recordingId: string | null; uploaded: boolean };

export async function uploadAudio(files: LocalAudio[], progress: (done: number, total: number) => void): Promise<UploadReport> {
  const report: UploadReport = { uploaded: 0, already: 0, failed: 0, tooBig: 0, unmatched: [] };
  const matches = new Map<string, Match>();
  for (let i = 0; i < files.length; i += 500) {
    const res = await fetch('/api/write/audio/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: files.slice(i, i + 500).map((f) => ({
          path: f.path,
          checksum: f.checksum,
          format: f.format,
          title: f.title,
          artist: f.artist,
          albumArtist: f.albumArtist,
          album: f.album,
          lengthMs: f.lengthMs,
          mbRecordingId: f.mbRecordingId,
        })),
      }),
    }).catch(() => null);
    if (!res?.ok) {
      const reason = ((await res?.json().catch(() => null)) as { error?: string } | null)?.error;
      throw new Error(`The audio could not be matched${res ? ` (${res.status})` : ': no connection'}. ${reason ?? 'Try again in a moment.'}`);
    }
    for (const m of ((await res.json()) as { matches: Match[] }).matches) matches.set(m.path, m);
  }

  const queue: { local: LocalAudio; recordingId: string }[] = [];
  for (const local of files) {
    const m = matches.get(local.path);
    if (!m?.recordingId) report.unmatched.push(local.path);
    else if (m.uploaded) report.already++;
    else if (local.file.size > MAX_AUDIO_BYTES) report.tooBig++;
    else queue.push({ local, recordingId: m.recordingId });
  }

  const total = queue.length;
  let done = 0;
  progress(0, total);
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { local, recordingId } = next;
      const params = new URLSearchParams({ recording: recordingId, path: local.path, format: local.format, checksum: local.checksum });
      const res = await fetch(`/api/write/audio/upload?${params}`, { method: 'PUT', body: local.file }).catch(() => null);
      if (res?.ok) report.uploaded++;
      else report.failed++;
      progress(++done, total);
    }
  };
  // Two at a time: quicker than one, gentle on a phone's connection.
  await Promise.all([worker(), worker()]);
  return report;
}

/** The report in a sentence. */
export function describeUpload(r: UploadReport): string {
  const parts = [
    r.uploaded ? `${r.uploaded} ${r.uploaded === 1 ? 'file' : 'files'} uploaded` : '',
    r.already ? `${r.already} already uploaded` : '',
    r.failed ? `${r.failed} failed (import the folder again to retry them)` : '',
    r.tooBig ? `${r.tooBig} over 100 MB left on this device` : '',
    r.unmatched.length ? `${r.unmatched.length} not uploaded yet: their album is still importing, so import the folder again once it is done` : '',
  ].filter(Boolean);
  if (parts.length === 0) return 'No audio to upload.';
  const sentence = parts.join('; ');
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}. ${r.uploaded || r.already ? 'They play anywhere you are signed in.' : ''}`.trim();
}
