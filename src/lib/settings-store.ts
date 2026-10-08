// Server-side, instance-wide settings persistence.
//
// Integration config (Seerr, OpenSubtitles) used to live in browser cookies,
// which meant it was lost on cookie expiry, logout, or simply switching to
// another device/browser. This module keeps that config in a JSON file owned by
// the Aperture server instead, so it survives all of the above.
//
// The file lives at $APERTURE_DATA_DIR/settings.json (default ./data). Point
// APERTURE_DATA_DIR at a mounted volume so it also survives container rebuilds.
//
// Server-only: never import this from a client component. Access goes through
// the "use server" actions in src/actions/store/server-actions.ts.

import { constants as fsConstants, promises as fs } from "fs";
import path from "path";
import type {
  OpenSubtitlesConfig,
  SeerrAuthData,
} from "@/src/actions/store/server-actions";
import type {
  PendingSubtitle,
  SubtitleDetails,
} from "@/src/actions/subtitles-search";

export interface ApertureSettings {
  seerr?: SeerrAuthData | null;
  opensubtitles?: OpenSubtitlesConfig | null;
  // What was added through Aperture, keyed by the sidecar's path on the
  // Jellyfin server. Jellyfin only names the file after the video + language,
  // so this is the only record of which release a subtitle came from.
  subtitles?: Record<string, SubtitleDetails> | null;
  pendingSubtitles?: PendingSubtitle[] | null;
  // Seconds to shift a subtitle track's cues by in the player. Keyed like
  // `subtitles` for sidecars; embedded tracks use "<itemId>:<mediaSourceId>:<index>".
  subtitleOffsets?: Record<string, number> | null;
}

const EMPTY: ApertureSettings = {};

function getDataDir(): string {
  const configured = process.env.APERTURE_DATA_DIR?.trim();
  return configured || path.join(process.cwd(), "data");
}

function getSettingsFile(): string {
  return path.join(getDataDir(), "settings.json");
}

// The settings file is written only by this process, so an in-memory copy is
// authoritative between writes. mtime is still checked so an operator editing
// settings.json by hand is picked up without a restart.
let cache: ApertureSettings | null = null;
let cacheMtimeMs = -1;

// Serializes read-modify-write cycles: two settings saved at the same time must
// not clobber each other.
let writeQueue: Promise<unknown> = Promise.resolve();

async function readFromDisk(): Promise<ApertureSettings> {
  const file = getSettingsFile();

  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    // No file yet — first run, or the data dir was just mounted.
    cache = EMPTY;
    cacheMtimeMs = -1;
    return EMPTY;
  }

  if (cache && mtimeMs === cacheMtimeMs) return cache;

  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = raw.trim() ? (JSON.parse(raw) as ApertureSettings) : EMPTY;
    cache = parsed && typeof parsed === "object" ? parsed : EMPTY;
    cacheMtimeMs = mtimeMs;
    return cache;
  } catch (error) {
    // A corrupt file must not take the whole app down: fall back to whatever we
    // last knew, and let the next write repair the file.
    console.error("Failed to read Aperture settings file:", error);
    return cache ?? EMPTY;
  }
}

async function writeToDisk(settings: ApertureSettings): Promise<void> {
  const dir = getDataDir();
  const file = getSettingsFile();
  const tmp = `${file}.tmp`;

  await fs.mkdir(dir, { recursive: true });
  // Written atomically so a crash mid-write can't leave a truncated file.
  // 0600: the file holds third-party credentials in plain text.
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);

  cache = settings;
  try {
    cacheMtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    cacheMtimeMs = -1;
  }
}

export async function readSettings(): Promise<ApertureSettings> {
  return readFromDisk();
}

/**
 * Merge `patch` into the stored settings. A key set to `null` is removed.
 * Concurrent calls are serialized.
 */
export async function patchSettings(
  patch: ApertureSettings,
): Promise<ApertureSettings> {
  return updateSettings((current) => {
    const next: ApertureSettings = { ...current };

    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) {
        delete next[key as keyof ApertureSettings];
      } else {
        (next as Record<string, unknown>)[key] = value;
      }
    }

    return next;
  });
}

/**
 * Replace the stored settings with `update(current)`. Use this instead of
 * read-then-patch whenever the new value depends on the old one, so a
 * concurrent write can't be lost in between.
 */
export async function updateSettings(
  update: (current: ApertureSettings) => ApertureSettings,
): Promise<ApertureSettings> {
  const run = writeQueue.then(async () => {
    const next = update(await readFromDisk());
    await writeToDisk(next);
    return next;
  });

  // Keep the queue alive even if this write fails, so later writes still run.
  writeQueue = run.catch(() => undefined);
  return run;
}

/** Where settings are being persisted — surfaced in the settings UI. */
export function getSettingsFilePath(): string {
  return getSettingsFile();
}

/** True when the data directory is writable, i.e. settings will actually stick. */
export async function isSettingsStoreWritable(): Promise<boolean> {
  const dir = getDataDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
