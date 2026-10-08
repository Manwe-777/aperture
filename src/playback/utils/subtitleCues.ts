export interface SubtitleCue {
  startTime: number; // seconds
  endTime: number;
  text: string;
}

// "HH:MM:SS.mmm" or "MM:SS.mmm" (VTT allows the hours to be omitted).
export function timeToSeconds(timeStr: string): number {
  const parts = timeStr.trim().split(/\s+/)[0].replace(",", ".").split(":");
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + (parseFloat(part) || 0);
  return seconds;
}

export function parseVTT(content: string): SubtitleCue[] {
  const lines = content.split(/\r?\n/);
  const cues: SubtitleCue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.includes("-->")) continue;

    const [startStr, endStr] = line.split("-->");
    const startTime = timeToSeconds(startStr);
    const endTime = timeToSeconds(endStr);

    const textLines: string[] = [];
    i++;
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }

    if (textLines.length > 0) {
      cues.push({ startTime, endTime, text: textLines.join("\n") });
    }
  }

  return cues.sort((a, b) => a.startTime - b.startTime);
}

const cueCache = new Map<string, Promise<SubtitleCue[]>>();

// Fetched once per track URL; the player and the sync panel share the result.
export function loadCues(src: string): Promise<SubtitleCue[]> {
  let cached = cueCache.get(src);
  if (!cached) {
    cached = fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then(parseVTT);
    cached.catch(() => cueCache.delete(src));
    cueCache.set(src, cached);
  }
  return cached;
}

// Index of the cue showing at `time`, or -1. Cues are sorted by start.
export function findActiveCue(cues: SubtitleCue[], time: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].startTime <= time) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Overlapping cues: walk back to the latest-starting one still on screen.
  for (let i = last; i >= 0 && i > last - 5; i--) {
    if (time < cues[i].endTime) return i;
  }
  return -1;
}
