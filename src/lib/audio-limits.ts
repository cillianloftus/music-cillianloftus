/** A Worker takes request bodies up to 100 MB, so no single audio file can be larger. Shared by the browser and the server. */
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
