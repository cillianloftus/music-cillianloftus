/**
 * How loud a file is, as broadcasters and streaming services measure it
 * (ITU-R BS.1770 integrated loudness, in LUFS): measured in the browser as
 * your files are uploaded (src/lib/audio-upload.ts), so the player can turn
 * loud masters down to the level Spotify plays its songs at (0082).
 *
 * The file is decoded and passed through the standard's weighting (a lift
 * above 1.5 kHz, a cut below 38 Hz, made with the browser's own filters),
 * its energy summed in tenths of a second, and those combined into 400 ms
 * blocks that overlap by three quarters. Silence (blocks under -70) and the
 * quiet passages (10 under the rest's level) are left out of the average.
 */

/** Integrated loudness of a file, or null if the browser cannot decode it. */
export async function measureLoudness(file: Blob): Promise<number | null> {
  try {
    const probe = new OfflineAudioContext(1, 1, 44100);
    const decoded = await probe.decodeAudioData(await file.arrayBuffer());
    const { sampleRate, length, numberOfChannels } = decoded;
    const weighting = new OfflineAudioContext(numberOfChannels, length, sampleRate);
    const source = weighting.createBufferSource();
    source.buffer = decoded;
    const shelf = weighting.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1500;
    shelf.gain.value = 4;
    const highpass = weighting.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 38;
    highpass.Q.value = 0.5;
    source.connect(shelf);
    shelf.connect(highpass);
    highpass.connect(weighting.destination);
    source.start();
    const weighted = await weighting.startRendering();

    const step = Math.max(1, Math.round(sampleRate / 10));
    const segments = new Float64Array(Math.floor(length / step));
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = weighted.getChannelData(ch);
      for (let s = 0; s < segments.length; s++) {
        let sum = 0;
        for (let i = s * step, end = i + step; i < end; i++) sum += data[i]! * data[i]!;
        segments[s]! += sum;
      }
    }
    return gatedLoudness(segments, step);
  } catch {
    return null;
  }
}

/**
 * The standard's gated average, from the summed energy of each tenth of a
 * second (all channels, `samples` samples each). Null for silence.
 */
export function gatedLoudness(segments: ArrayLike<number>, samples: number): number | null {
  const blocks: number[] = [];
  for (let i = 0; i + 4 <= segments.length; i++) {
    blocks.push((segments[i]! + segments[i + 1]! + segments[i + 2]! + segments[i + 3]!) / (4 * samples));
  }
  const level = (z: number) => -0.691 + 10 * Math.log10(z);
  const mean = (zs: number[]) => zs.reduce((a, b) => a + b, 0) / zs.length;
  const heard = blocks.filter((z) => z > 0 && level(z) > -70);
  if (heard.length === 0) return null;
  const relative = level(mean(heard)) - 10;
  const kept = heard.filter((z) => level(z) > relative);
  return Math.round(level(mean(kept)) * 10) / 10;
}
