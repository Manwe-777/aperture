// Speech-band loudness of a title's audio, for lining subtitles up against
// dialogue. Jellyfin transcodes short mono clips on request, so this works
// while paused and can show what is about to play, not just what has played.

export const CHUNK_SECONDS = 30;
export const BIN_SECONDS = 0.01;
const SAMPLE_RATE = 16000;

export interface EnvelopeSource {
  serverUrl: string;
  accessToken: string;
  itemId: string;
  mediaSourceId: string;
  audioStreamIndex?: number;
}

export interface EnvelopeChunk {
  start: number; // seconds into the title
  // Speech-band level per BIN_SECONDS bin, in dBFS.
  db: Float32Array;
  // Quiet floor and loudest bin, for scaling the drawing.
  floor: number;
  ceil: number;
}

function chunkUrl(src: EnvelopeSource, start: number): string {
  const params = new URLSearchParams({
    static: "false",
    // Lossless and without encoder delay, so bins line up with the video.
    // (PCM/WAV is not an option: Jellyfin builds a broken ffmpeg command.)
    container: "flac",
    audioCodec: "flac",
    audioSampleRate: String(SAMPLE_RATE),
    maxAudioChannels: "1",
    enableAutoStreamCopy: "false",
    allowAudioStreamCopy: "false",
    mediaSourceId: src.mediaSourceId,
    startTimeTicks: String(Math.round(start * 1e7)),
    // Own session, so Jellyfin never mistakes this for the playback stream.
    deviceId: "aperture-subtitle-sync",
    playSessionId: `subsync-${src.itemId}-${start}`,
    api_key: src.accessToken,
  });
  if (src.audioStreamIndex !== undefined) {
    params.set("audioStreamIndex", String(src.audioStreamIndex));
  }
  return `${src.serverUrl.replace(/\/+$/, "")}/Audio/${src.itemId}/stream.flac?${params}`;
}

// The transcode runs until the end of the title, so read just enough bytes
// for one chunk and hang up; Jellyfin stops the job when the client leaves.
async function readBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  if (!res.ok || !res.body) {
    throw new Error(`Jellyfin returned ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  controller.abort();

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

// FLAC frames start with the 0xFFF8 sync code (0xFFF9 for variable block
// size). Hanging up mid-stream leaves a partial last frame, which some
// decoders reject outright, so fall back to cutting at the last frame start.
function lastFrameStarts(bytes: Uint8Array, count: number): number[] {
  const starts: number[] = [];
  for (let i = bytes.length - 2; i > 0 && starts.length < count; i--) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xfe) === 0xf8) starts.push(i);
  }
  return starts;
}

async function decode(bytes: Uint8Array): Promise<{ samples: Float32Array; rate: number }> {
  const attempt = async (data: Uint8Array) => {
    const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    const buffer = await ctx.decodeAudioData(data.slice().buffer);
    return { samples: buffer.getChannelData(0), rate: buffer.sampleRate };
  };
  try {
    return await attempt(bytes);
  } catch (error) {
    for (const cut of lastFrameStarts(bytes, 4)) {
      try {
        return await attempt(bytes.subarray(0, cut));
      } catch {
        // A false sync match inside frame data; try an earlier one.
      }
    }
    throw error;
  }
}

// RBJ biquad, applied in place.
function biquad(x: Float32Array, rate: number, freq: number, type: "lowpass" | "highpass") {
  const w0 = (2 * Math.PI * freq) / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const b1 = type === "lowpass" ? 1 - cos : -(1 + cos);
  const b0 = Math.abs(b1) / 2;
  const a0 = 1 + alpha;
  const [nb0, nb1, nb2, na1, na2] = [b0 / a0, b1 / a0, b0 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = nb0 * x[i] + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

function envelope(samples: Float32Array, rate: number): Float32Array {
  // Keep the speech band so dialogue stands out from music and effects.
  const x = samples.slice();
  biquad(x, rate, 300, "highpass");
  biquad(x, rate, 3400, "lowpass");

  const binSize = Math.round(rate * BIN_SECONDS);
  const bins = Math.floor(x.length / binSize);
  const db = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    let sum = 0;
    for (let i = b * binSize; i < (b + 1) * binSize; i++) sum += x[i] * x[i];
    db[b] = 10 * Math.log10(sum / binSize + 1e-10);
  }
  return db;
}

export async function loadEnvelopeChunk(
  src: EnvelopeSource,
  start: number,
): Promise<EnvelopeChunk> {
  // Worst case FLAC is raw PCM plus frame headers; leave a little headroom.
  const bytes = await readBytes(
    chunkUrl(src, start),
    Math.ceil(CHUNK_SECONDS * SAMPLE_RATE * 2 * 1.05) + 8192,
  );
  const decoded = await decode(bytes);
  const wanted = Math.min(decoded.samples.length, CHUNK_SECONDS * decoded.rate);
  const db = envelope(decoded.samples.subarray(0, wanted), decoded.rate);
  if (db.length === 0) throw new Error("Jellyfin returned no audio");
  const sorted = db.slice().sort();
  return {
    start,
    db,
    floor: sorted[Math.floor(sorted.length * 0.2)],
    ceil: sorted[sorted.length - 1],
  };
}
