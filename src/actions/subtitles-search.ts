"use server";

import { UserLibraryApi } from "@jellyfin/sdk/lib/generated-client/api/user-library-api";
import type {
  BaseItemDto,
  MediaSourceInfo,
} from "@jellyfin/sdk/lib/generated-client/models";
import { createJellyfinInstance } from "@/src/lib/utils";
import { readSettings, updateSettings } from "@/src/lib/settings-store";
import { getAuthData } from "./utils";

// What we knew about a subtitle when it was added through Aperture. Jellyfin
// keeps none of this: the sidecar is named after the video + language only.
export interface SubtitleDetails {
  source: "opensubtitles" | "upload";
  // OpenSubtitles file id; what stops the same file being downloaded twice.
  fileId: number | null;
  language: string;
  // Release name from OpenSubtitles, or the uploaded file's name.
  release: string;
  fps: number | null;
  hearingImpaired: boolean;
  forced: boolean;
  fromTrusted: boolean;
  autoTranslated: boolean;
  downloadCount: number | null;
  addedAt: string;
}

export interface InstalledSubtitle {
  index: number;
  language: string;
  displayTitle: string;
  codec: string;
  isExternal: boolean;
  isForced: boolean;
  isDefault: boolean;
  isHearingImpaired: boolean;
  title: string;
  path: string | null;
  details: SubtitleDetails | null;
}

// Uploads whose sidecar Jellyfin hadn't indexed yet when the upload returned.
// Matched to the new file the next time the item's subtitles are listed.
export interface PendingSubtitle {
  itemId: string;
  knownPaths: string[];
  details: SubtitleDetails;
}

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const NON_LANGUAGE_TOKENS = new Set(["forced", "default", "sdh", "cc", "hi"]);

async function fetchItem(itemId: string): Promise<BaseItemDto> {
  const { serverUrl, user } = await getAuthData();
  if (!user.AccessToken) throw new Error("No access token found");

  const jellyfinInstance = createJellyfinInstance();
  const api = jellyfinInstance.createApi(serverUrl);
  api.accessToken = user.AccessToken;

  const userLibraryApi = new UserLibraryApi(api.configuration);
  const { data: item } = await userLibraryApi.getItem({
    userId: user.Id,
    itemId,
  });
  return item;
}

function externalSubtitlePaths(item: BaseItemDto): string[] {
  const paths = new Set<string>();
  for (const ms of item.MediaSources ?? []) {
    for (const s of ms.MediaStreams ?? []) {
      if (s.Type === "Subtitle" && s.IsExternal && s.Path) paths.add(s.Path);
    }
  }
  return [...paths];
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

// "<video>.es.0.srt" -> "es". Fallback for sidecars Aperture has no details
// for, since Jellyfin often reports no language for them.
function languageFromPath(subPath: string, mediaSource?: MediaSourceInfo) {
  const videoBase = mediaSource?.Path
    ? fileName(mediaSource.Path).replace(/\.[^.]+$/, "")
    : "";
  let rest = fileName(subPath).replace(/\.[^.]+$/, "");
  if (videoBase && rest.startsWith(videoBase)) rest = rest.slice(videoBase.length);
  const token = rest
    .split(".")
    .reverse()
    .find(
      (t) =>
        /^[a-z]{2,3}(-[a-z]{2})?$/i.test(t) &&
        !NON_LANGUAGE_TOKENS.has(t.toLowerCase()),
    );
  return token?.toLowerCase() ?? "";
}

// Assigns pending upload details to the sidecars Jellyfin has since indexed.
// Returns the details map to use for this item.
async function resolvePendingDetails(
  item: BaseItemDto,
): Promise<Record<string, SubtitleDetails>> {
  const settings = await readSettings();
  const pending = (settings.pendingSubtitles ?? []).filter(
    (p) => p.itemId === item.Id,
  );
  if (pending.length === 0) return settings.subtitles ?? {};

  const current = externalSubtitlePaths(item);
  const next = await updateSettings((s) => {
    const subtitles = { ...(s.subtitles ?? {}) };
    const now = Date.now();
    const remaining: PendingSubtitle[] = [];

    for (const p of s.pendingSubtitles ?? []) {
      if (now - Date.parse(p.details.addedAt) > PENDING_TTL_MS) continue;
      if (p.itemId !== item.Id) {
        remaining.push(p);
        continue;
      }
      const candidates = current.filter(
        (path) => !p.knownPaths.includes(path) && !subtitles[path],
      );
      const lang = p.details.language.toLowerCase();
      const match =
        candidates.find((path) => fileName(path).toLowerCase().includes(`.${lang}.`)) ??
        candidates[0];
      if (match) subtitles[match] = p.details;
      else remaining.push(p);
    }

    return {
      ...s,
      subtitles,
      pendingSubtitles: remaining.length ? remaining : null,
    };
  });
  return next.subtitles ?? {};
}

async function subtitleOffsetKey(
  itemId: string,
  mediaSourceId: string,
  index: number,
): Promise<string> {
  const item = await fetchItem(itemId);
  const path = item.MediaSources?.find((ms) => ms.Id === mediaSourceId)
    ?.MediaStreams?.find((s) => s.Type === "Subtitle" && s.Index === index)?.Path;
  return path || `${itemId}:${mediaSourceId}:${index}`;
}

// Saved sync offset for a subtitle track, in seconds (positive = later).
export async function getSubtitleOffset(
  itemId: string,
  mediaSourceId: string,
  index: number,
): Promise<number> {
  const key = await subtitleOffsetKey(itemId, mediaSourceId, index);
  return (await readSettings()).subtitleOffsets?.[key] ?? 0;
}

export async function setSubtitleOffset(
  itemId: string,
  mediaSourceId: string,
  index: number,
  seconds: number,
): Promise<void> {
  if (!Number.isFinite(seconds)) throw new Error("Invalid offset");
  const key = await subtitleOffsetKey(itemId, mediaSourceId, index);
  const rounded = Math.round(seconds * 1000) / 1000;
  await updateSettings((s) => {
    const subtitleOffsets = { ...(s.subtitleOffsets ?? {}) };
    if (rounded === 0) delete subtitleOffsets[key];
    else subtitleOffsets[key] = rounded;
    return { ...s, subtitleOffsets };
  });
}

// True when this OpenSubtitles file is already on the item, or was added and
// Jellyfin hasn't indexed it yet. Downloads count against a daily quota.
export async function isSubtitleFileAdded(
  itemId: string,
  fileId: number,
): Promise<boolean> {
  const item = await fetchItem(itemId);
  const detailsByPath = await resolvePendingDetails(item);
  if (externalSubtitlePaths(item).some((p) => detailsByPath[p]?.fileId === fileId)) {
    return true;
  }
  const { pendingSubtitles } = await readSettings();
  return (pendingSubtitles ?? []).some(
    (p) => p.itemId === itemId && p.details.fileId === fileId,
  );
}

// Lists the subtitle streams Jellyfin currently knows about for a media source,
// with enough detail to show status and decide what can be deleted (only
// external/sidecar subtitles can be removed; embedded ones cannot).
export async function getInstalledSubtitles(
  itemId: string,
  mediaSourceId: string,
): Promise<InstalledSubtitle[]> {
  const item = await fetchItem(itemId);
  const detailsByPath = await resolvePendingDetails(item);

  const mediaSource =
    item.MediaSources?.find((ms) => ms.Id === mediaSourceId) ||
    item.MediaSources?.[0];

  const streams = mediaSource?.MediaStreams ?? [];
  return streams
    .filter((s) => s.Type === "Subtitle")
    .map((s) => {
      const path = s.Path || null;
      const details = (path && detailsByPath[path]) || null;
      return {
        index: s.Index ?? -1,
        language:
          details?.language ||
          s.Language ||
          (path ? languageFromPath(path, mediaSource) : ""),
        displayTitle: s.DisplayTitle || s.Title || s.Language || "Subtitle",
        codec: s.Codec || "",
        isExternal: !!s.IsExternal,
        isForced: !!s.IsForced,
        isDefault: !!s.IsDefault,
        isHearingImpaired: !!s.IsHearingImpaired,
        title: s.Title || "",
        path,
        details,
      };
    });
}

export interface UploadSubtitleInput {
  language: string; // ISO 639 code, e.g. "en"
  format: string; // "srt", "ass", ...
  contentBase64: string;
  isForced?: boolean;
  isHearingImpaired?: boolean;
  // Remembered against the new sidecar so it can be told apart later.
  details?: Omit<SubtitleDetails, "language" | "forced" | "hearingImpaired" | "addedAt">;
}

// Hands a subtitle file to Jellyfin's own upload endpoint. Jellyfin writes it
// as an external sidecar next to the media file (in your existing media path)
// and re-indexes it as a selectable track. This is why aperture never needs
// filesystem access to the media volume.
export async function uploadSubtitleToJellyfin(
  itemId: string,
  input: UploadSubtitleInput,
): Promise<{ success: boolean; message?: string }> {
  const { serverUrl, user } = await getAuthData();
  if (!user.AccessToken) throw new Error("No access token found");

  const knownPaths = input.details
    ? externalSubtitlePaths(await fetchItem(itemId))
    : [];

  const url = `${serverUrl.replace(/\/+$/, "")}/Videos/${itemId}/Subtitles`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `MediaBrowser Token="${user.AccessToken}"`,
    },
    body: JSON.stringify({
      Language: input.language,
      Format: input.format,
      IsForced: input.isForced ?? false,
      IsHearingImpaired: input.isHearingImpaired ?? false,
      Data: input.contentBase64,
    }),
  });

  if (!res.ok) {
    let message = `Upload failed: ${res.status} ${res.statusText}`;
    try {
      const text = await res.text();
      if (text) message = `${message} – ${text.slice(0, 200)}`;
    } catch {}
    return { success: false, message };
  }

  if (input.details) {
    // Jellyfin indexes the sidecar in a queued refresh, so its path isn't
    // known yet. Park the details; they are matched to the new file when the
    // item's subtitles are next listed.
    const pending: PendingSubtitle = {
      itemId,
      knownPaths,
      details: {
        ...input.details,
        language: input.language,
        forced: input.isForced ?? false,
        hearingImpaired: input.isHearingImpaired ?? false,
        addedAt: new Date().toISOString(),
      },
    };
    await updateSettings((s) => ({
      ...s,
      pendingSubtitles: [...(s.pendingSubtitles ?? []), pending],
    }));
  }

  return { success: true };
}

// Removes an external subtitle by its stream index. Embedded subtitle streams
// cannot be deleted (they are part of the container) and will error.
export async function deleteJellyfinSubtitle(
  itemId: string,
  index: number,
): Promise<{ success: boolean; message?: string }> {
  const { serverUrl, user } = await getAuthData();
  if (!user.AccessToken) throw new Error("No access token found");

  const item = await fetchItem(itemId);
  const path = item.MediaSources?.flatMap((ms) => ms.MediaStreams ?? []).find(
    (s) => s.Type === "Subtitle" && s.Index === index,
  )?.Path;

  const url = `${serverUrl.replace(/\/+$/, "")}/Videos/${itemId}/Subtitles/${index}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `MediaBrowser Token="${user.AccessToken}"`,
    },
  });

  if (!res.ok) {
    return {
      success: false,
      message: `Delete failed: ${res.status} ${res.statusText}`,
    };
  }

  const stored = await readSettings();
  if (path && (stored.subtitles?.[path] || stored.subtitleOffsets?.[path])) {
    await updateSettings((s) => {
      const subtitles = { ...(s.subtitles ?? {}) };
      const subtitleOffsets = { ...(s.subtitleOffsets ?? {}) };
      delete subtitles[path];
      delete subtitleOffsets[path];
      return { ...s, subtitles, subtitleOffsets };
    });
  }

  return { success: true };
}
