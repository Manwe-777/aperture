"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, X } from "lucide-react";
import { PlaybackContextValue } from "../hooks/usePlaybackManager";
import { getAuthData, setSubtitleOffset } from "../../actions";
import {
  BIN_SECONDS,
  CHUNK_SECONDS,
  EnvelopeChunk,
  EnvelopeSource,
  loadEnvelopeChunk,
} from "../utils/audioEnvelope";
import { SubtitleCue, loadCues } from "../utils/subtitleCues";

interface SubtitleSyncPanelProps {
  manager: PlaybackContextValue;
  onClose: () => void;
}

const SPANS = [5, 10, 20, 40];
const NUDGES = [-1, -0.1, -0.01, 0.01, 0.1, 1];

// Canvas rows, in CSS pixels.
const RULER_H = 18;
const WAVE_H = 84;
const CUE_TOP = RULER_H + WAVE_H + 6;
const CUE_H = 40;
const CANVAS_H = CUE_TOP + CUE_H + 4;

function formatOffset(seconds: number): string {
  const sign = seconds > 0 ? "+" : seconds < 0 ? "−" : "±";
  return `${sign}${Math.abs(seconds).toFixed(3)} s`;
}

function formatClock(seconds: number, step: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const digits = step < 1 ? 1 : 0;
  return `${m}:${s.toFixed(digits).padStart(digits ? 4 : 2, "0")}`;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s*\n\s*/g, " ");
}

export const SubtitleSyncPanel: React.FC<SubtitleSyncPanelProps> = ({
  manager,
  onClose,
}) => {
  const { playbackState } = manager;
  const {
    currentItem,
    currentMediaSource,
    audioStreamIndex,
    subtitleStreamIndex,
    textTracks,
  } = playbackState;
  const offset = playbackState.subtitleOffset || 0;
  const track = textTracks?.find((t) => t.index === subtitleStreamIndex);

  const [span, setSpan] = useState(10);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [selectedCue, setSelectedCue] = useState<number | null>(null);
  const [source, setSource] = useState<EnvelopeSource | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [offsetInput, setOffsetInput] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<EnvelopeSource | null>(null);
  sourceRef.current = source;
  const chunksRef = useRef(new Map<number, EnvelopeChunk>());
  const loadingRef = useRef(new Set<number>());
  // Everything the draw loop reads, so it never has to restart.
  const viewRef = useRef({
    span,
    offset,
    cues,
    selectedCue,
    fallbackTime: playbackState.currentTime,
    scrubTime: null as number | null,
    hoverTime: null as number | null,
  });
  viewRef.current.span = span;
  viewRef.current.offset = offset;
  viewRef.current.cues = cues;
  viewRef.current.selectedCue = selectedCue;
  viewRef.current.fallbackTime = playbackState.currentTime;

  // --- Data ---------------------------------------------------------------

  useEffect(() => {
    if (!track?.src) {
      setCues([]);
      return;
    }
    let cancelled = false;
    loadCues(track.src)
      .then((c) => !cancelled && setCues(c))
      .catch(() => !cancelled && setCues([]));
    setSelectedCue(null);
    return () => {
      cancelled = true;
    };
  }, [track?.src]);

  useEffect(() => {
    if (!currentItem?.Id || !currentMediaSource?.Id) return;
    chunksRef.current.clear();
    loadingRef.current.clear();
    setAudioError(null);
    let cancelled = false;
    getAuthData()
      .then(({ serverUrl, user }) => {
        if (cancelled || !user.AccessToken) return;
        setSource({
          serverUrl,
          accessToken: user.AccessToken,
          itemId: currentItem.Id!,
          mediaSourceId: currentMediaSource.Id!,
          audioStreamIndex,
        });
      })
      .catch(() => !cancelled && setAudioError("Not signed in"));
    return () => {
      cancelled = true;
    };
  }, [currentItem?.Id, currentMediaSource?.Id, audioStreamIndex]);

  // Load the chunks covering the window, plus the next one so playback
  // doesn't run off the end of what's loaded.
  const centerChunk = Math.floor(playbackState.currentTime / CHUNK_SECONDS);
  useEffect(() => {
    if (!source) return;
    const t = viewRef.current.fallbackTime;
    const first = Math.max(0, Math.floor((t - span / 2) / CHUNK_SECONDS));
    const last = Math.floor((t + span / 2) / CHUNK_SECONDS) + 1;
    let cancelled = false;

    (async () => {
      for (let k = first; k <= last; k++) {
        if (cancelled) return;
        if (chunksRef.current.has(k) || loadingRef.current.has(k)) continue;
        loadingRef.current.add(k);
        try {
          const chunk = await loadEnvelopeChunk(source, k * CHUNK_SECONDS);
          // Audio track switched while this was loading.
          if (sourceRef.current !== source) return;
          chunksRef.current.set(k, chunk);
          setAudioError(null);
        } catch (e) {
          setAudioError(e instanceof Error ? e.message : "Audio failed to load");
        } finally {
          loadingRef.current.delete(k);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, centerChunk, span]);

  // --- Offset -------------------------------------------------------------

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyOffset = useCallback(
    (seconds: number) => {
      const value = Math.round(seconds * 1000) / 1000;
      manager.reportState({ subtitleOffset: value });

      const itemId = currentItem?.Id;
      const mediaSourceId = currentMediaSource?.Id;
      const index = subtitleStreamIndex;
      if (!itemId || !mediaSourceId || index === undefined || index < 0) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaveState("saving");
      saveTimer.current = setTimeout(() => {
        setSubtitleOffset(itemId, mediaSourceId, index, value)
          .then(() => setSaveState("saved"))
          .catch(() => setSaveState("error"));
      }, 600);
    },
    [manager, currentItem?.Id, currentMediaSource?.Id, subtitleStreamIndex],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) return;
      if (e.key === "Escape") {
        // The player's own Escape handler would stop playback.
        e.preventDefault();
        e.stopImmediatePropagation();
        if (viewRef.current.selectedCue !== null) setSelectedCue(null);
        else onClose();
        return;
      }
      const step = e.shiftKey ? 0.1 : 0.01;
      if (e.key === "," || e.key === "<") applyOffset(viewRef.current.offset - step);
      else if (e.key === "." || e.key === ">") applyOffset(viewRef.current.offset + step);
      else return;
      e.preventDefault();
    };
    // Capture phase, so it runs before the player's handler.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [applyOffset, onClose]);

  // --- Envelope lookups ---------------------------------------------------

  const dbAt = (time: number): { db: number; chunk: EnvelopeChunk } | null => {
    const chunk = chunksRef.current.get(Math.floor(time / CHUNK_SECONDS));
    if (!chunk) return null;
    const i = Math.floor((time - chunk.start) / BIN_SECONDS);
    if (i < 0 || i >= chunk.db.length) return null;
    return { db: chunk.db[i], chunk };
  };

  // Where speech starts near `time`: the sharpest rise in level within
  // ±250 ms, so a rough click lands on the actual onset.
  const snapToOnset = (time: number): number => {
    let best = time;
    let bestRise = 6; // dB; anything flatter isn't an onset
    for (let t = time - 0.25; t <= time + 0.25; t += BIN_SECONDS) {
      const here = dbAt(t);
      if (!here) continue;
      let before = Infinity;
      for (let b = 1; b <= 8; b++) {
        const prev = dbAt(t - b * BIN_SECONDS);
        if (prev) before = Math.min(before, prev.db);
      }
      const rise = here.db - before;
      if (rise > bestRise) {
        bestRise = rise;
        best = t;
      }
    }
    return best;
  };

  // --- Drawing ------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const video = document.querySelector<HTMLVideoElement>(
      "[data-player-container] video",
    );

    let frame = requestAnimationFrame(function draw() {
      frame = requestAnimationFrame(draw);
      const view = viewRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(CANVAS_H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, CANVAS_H);

      const center = video ? video.currentTime : view.fallbackTime;
      const t0 = center - view.span / 2;
      const pxPerSec = w / view.span;
      const xAt = (t: number) => (t - t0) * pxPerSec;

      // Ruler
      const step = view.span <= 5 ? 0.5 : view.span <= 10 ? 1 : view.span <= 20 ? 2 : 5;
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "top";
      for (let t = Math.ceil(t0 / step) * step; t <= t0 + view.span; t += step) {
        if (t < 0) continue;
        const x = Math.round(xAt(t)) + 0.5;
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(x, RULER_H - 5, 1, 5);
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillText(formatClock(t, step), x + 3, 2);
      }
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(0, RULER_H, w, WAVE_H);

      // Waveform
      const waveBottom = RULER_H + WAVE_H;
      const missing: Array<[number, number]> = [];
      for (let x = 0; x < w; x++) {
        const ta = t0 + x / pxPerSec;
        if (ta < 0) continue;
        let peak = -Infinity;
        let chunk: EnvelopeChunk | null = null;
        for (let t = ta; t < ta + 1 / pxPerSec || t === ta; t += BIN_SECONDS) {
          const here = dbAt(t);
          if (here && here.db > peak) {
            peak = here.db;
            chunk = here.chunk;
          }
        }
        if (!chunk) {
          const lastGap = missing[missing.length - 1];
          if (lastGap && lastGap[1] === x - 1) lastGap[1] = x;
          else missing.push([x, x]);
          continue;
        }
        const range = Math.max(chunk.ceil - chunk.floor, 1);
        const level = Math.min(Math.max((peak - chunk.floor) / range, 0), 1);
        const h = Math.max(1, Math.pow(level, 1.4) * (WAVE_H - 4));
        ctx.fillStyle = `rgba(56,189,248,${0.25 + 0.75 * level})`;
        ctx.fillRect(x, waveBottom - h, 1, h);
      }
      for (const [a, b] of missing) {
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(a, RULER_H, b - a + 1, WAVE_H);
        if (b - a > 90) {
          ctx.fillStyle = "rgba(255,255,255,0.4)";
          ctx.fillText("loading audio…", a + (b - a) / 2 - 36, RULER_H + WAVE_H / 2 - 5);
        }
      }

      // Cues, shifted by the offset
      const { cues, offset, selectedCue } = view;
      let lo = 0;
      let hi = cues.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid].endTime + offset < t0 - 10) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < cues.length; i++) {
        const cue = cues[i];
        const start = cue.startTime + offset;
        const end = cue.endTime + offset;
        if (start > t0 + view.span) break;
        if (end < t0) continue;
        const x1 = xAt(start);
        const x2 = xAt(end);
        const active = center >= start && center < end;
        const selected = i === selectedCue;

        // Start edge runs up through the waveform: line it up with the onset.
        ctx.fillStyle = selected
          ? "rgba(96,165,250,1)"
          : active
            ? "rgba(251,191,36,0.9)"
            : "rgba(255,255,255,0.45)";
        ctx.fillRect(Math.round(x1), RULER_H, selected ? 2 : 1, CUE_TOP - RULER_H + CUE_H);
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        ctx.fillRect(Math.round(x2), RULER_H + WAVE_H / 2, 1, CUE_TOP - RULER_H - WAVE_H / 2 + CUE_H);

        ctx.fillStyle = selected
          ? "rgba(59,130,246,0.45)"
          : active
            ? "rgba(251,191,36,0.3)"
            : "rgba(255,255,255,0.14)";
        ctx.beginPath();
        ctx.roundRect(x1, CUE_TOP, Math.max(x2 - x1, 2), CUE_H, 4);
        ctx.fill();

        ctx.save();
        ctx.beginPath();
        ctx.rect(x1 + 4, CUE_TOP, Math.max(x2 - x1 - 8, 0), CUE_H);
        ctx.clip();
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(stripTags(cue.text), x1 + 4, CUE_TOP + 6);
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(`${start.toFixed(2)}s`, x1 + 4, CUE_TOP + 23);
        ctx.restore();
      }

      // Hover / scrub cursor
      const ghost = view.scrubTime ?? view.hoverTime;
      if (ghost !== null) {
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.fillRect(Math.round(xAt(ghost)), RULER_H, 1, WAVE_H);
      }

      // Playhead
      ctx.fillStyle = "rgba(239,68,68,0.95)";
      ctx.fillRect(Math.round(w / 2) - 1, 0, 2, CANVAS_H);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // --- Pointer ------------------------------------------------------------

  const drag = useRef<{
    mode: "offset" | "scrub";
    startX: number;
    startOffset: number;
    cueIndex: number | null;
    moved: boolean;
  } | null>(null);

  const timeAtX = (clientX: number): number => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const video = document.querySelector<HTMLVideoElement>(
      "[data-player-container] video",
    );
    const center = video ? video.currentTime : viewRef.current.fallbackTime;
    return center - span / 2 + ((clientX - rect.left) / rect.width) * span;
  };

  const cueAt = (time: number): number | null => {
    for (let i = 0; i < cues.length; i++) {
      const start = cues[i].startTime + offset;
      if (start > time) break;
      if (time < cues[i].endTime + offset) return i;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const time = timeAtX(e.clientX);
    e.currentTarget.setPointerCapture(e.pointerId);

    if (y >= CUE_TOP - 4) {
      drag.current = {
        mode: "offset",
        startX: e.clientX,
        startOffset: offset,
        cueIndex: cueAt(time),
        moved: false,
      };
      return;
    }

    if (selectedCue !== null && cues[selectedCue]) {
      // Second click of "pick a line, then its onset".
      applyOffset(snapToOnset(time) - cues[selectedCue].startTime);
      setSelectedCue(null);
      return;
    }

    drag.current = {
      mode: "scrub",
      startX: e.clientX,
      startOffset: offset,
      cueIndex: null,
      moved: false,
    };
    viewRef.current.scrubTime = time;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const time = timeAtX(e.clientX);
    if (!d) {
      const rect = e.currentTarget.getBoundingClientRect();
      viewRef.current.hoverTime = e.clientY - rect.top < CUE_TOP - 4 ? time : null;
      return;
    }
    if (Math.abs(e.clientX - d.startX) > 3) d.moved = true;
    if (d.mode === "offset" && d.moved) {
      const rect = e.currentTarget.getBoundingClientRect();
      const secPerPx = span / rect.width;
      applyOffset(d.startOffset + (e.clientX - d.startX) * secPerPx);
    } else if (d.mode === "scrub") {
      viewRef.current.scrubTime = time;
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === "offset" && !d.moved) {
      setSelectedCue((cur) => (d.cueIndex === cur ? null : d.cueIndex));
    } else if (d.mode === "scrub") {
      const time = viewRef.current.scrubTime;
      viewRef.current.scrubTime = null;
      if (time !== null) manager.seek(Math.max(0, time) * 1e7);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    const i = SPANS.indexOf(span);
    if (e.deltaY < 0 && i > 0) setSpan(SPANS[i - 1]);
    if (e.deltaY > 0 && i < SPANS.length - 1) setSpan(SPANS[i + 1]);
  };

  // --- Render -------------------------------------------------------------

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const buttonClass =
    "rounded-md px-2 py-1 text-xs tabular-nums text-white/80 hover:bg-white/15 hover:text-white transition-colors";

  return (
    <div
      className="absolute left-1/2 top-24 z-[60] w-[min(1100px,calc(100%-2rem))] -translate-x-1/2 rounded-2xl border border-white/10 p-3 text-white shadow-2xl backdrop-blur-xl"
      style={{ background: "rgba(20,20,20,0.72)" }}
      onClick={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
    >
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">Subtitle sync</div>
          <div className="truncate text-[11px] text-white/50">
            {track ? track.label : "Pick a subtitle track first"}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1">
          {NUDGES.slice(0, 3).map((n) => (
            <button key={n} className={buttonClass} onClick={() => applyOffset(offset + n)}>
              {n * 1000}ms
            </button>
          ))}
          <input
            className="mx-1 w-24 rounded-md bg-white/10 px-2 py-1 text-center text-sm font-semibold tabular-nums outline-none focus:bg-white/20"
            value={offsetInput ?? formatOffset(offset)}
            onFocus={() => setOffsetInput(offset.toFixed(3))}
            onChange={(e) => setOffsetInput(e.target.value)}
            onBlur={() => {
              const value = parseFloat((offsetInput ?? "").replace("−", "-"));
              if (Number.isFinite(value)) applyOffset(value);
              setOffsetInput(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setOffsetInput(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
            title="Offset in seconds; positive shows subtitles later"
          />
          {NUDGES.slice(3).map((n) => (
            <button key={n} className={buttonClass} onClick={() => applyOffset(offset + n)}>
              +{n * 1000}ms
            </button>
          ))}
          <button className={buttonClass} onClick={() => applyOffset(0)} title="Reset offset">
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          {SPANS.map((s) => (
            <button
              key={s}
              className={`${buttonClass} ${s === span ? "bg-white/20 text-white" : ""}`}
              onClick={() => setSpan(s)}
            >
              {s}s
            </button>
          ))}
          <button className={`${buttonClass} ml-1`} onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        className="block w-full cursor-crosshair touch-none select-none rounded-lg"
        style={{ height: CANVAS_H }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => (viewRef.current.hoverTime = null)}
        onWheel={onWheel}
      />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-white/50">
        <span>
          {selectedCue !== null
            ? "Now click where that line's speech starts in the waveform."
            : "Drag the subtitle row to shift it · click a line, then its onset in the waveform · click the waveform to seek · , . nudge 10 ms (Shift: 100 ms)"}
        </span>
        <span className="flex items-center gap-1">
          {audioError ? (
            <span className="text-amber-400">Audio: {audioError}</span>
          ) : null}
          {saveState === "saving" ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> Saving…
            </>
          ) : saveState === "saved" ? (
            "Saved"
          ) : saveState === "error" ? (
            <span className="text-red-400">Couldn&apos;t save offset</span>
          ) : null}
        </span>
      </div>
    </div>
  );
};
