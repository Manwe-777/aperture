"use client";
import React, { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "../../../components/ui/dropdown-menu";
import { AudioWaveform, Captions, Type } from "lucide-react";
import { useSetAtom } from "jotai";
import { subtitleSyncOpenAtom } from "../../../lib/atoms";
import { PlaybackContextValue } from "../../hooks/usePlaybackManager";
import {
  getInstalledSubtitles,
  getSubtitleTracks,
  type InstalledSubtitle,
} from "../../../actions";
import { Flag } from "../../../components/ui/flag";
import { languageName } from "../../../lib/language";
import { SettingsMenuButton } from "./SettingsMenuButton";

interface SubtitleTracksMenuProps {
  manager: PlaybackContextValue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const SubtitleTracksMenu: React.FC<SubtitleTracksMenuProps> = ({
  manager,
  open,
  onOpenChange,
}) => {
  const { playbackState } = manager;
  const { currentItem, currentMediaSource } = playbackState;
  const [subtitleTracks, setSubtitleTracks] = useState<any[]>([]);
  const openSync = useSetAtom(subtitleSyncOpenAtom);
  const subtitleOn = (playbackState.subtitleStreamIndex ?? -1) >= 0;
  // Same streams with the details recorded when they were added, by index.
  const [installedByIndex, setInstalledByIndex] = useState<
    Map<number, InstalledSubtitle>
  >(new Map());

  const [subtitleSize, setSubtitleSize] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("aperture-subtitle-size");
      return saved ? parseInt(saved, 10) : 100;
    }
    return 100;
  });

  useEffect(() => {
    async function fetchTracks() {
      if (currentItem?.Id && currentMediaSource?.Id) {
        try {
          const subs = await getSubtitleTracks(
            currentItem.Id,
            currentMediaSource.Id,
          );
          setSubtitleTracks(subs);
        } catch (error) {
          console.error("Failed to fetch subtitle tracks", error);
        }
        try {
          const installed = await getInstalledSubtitles(
            currentItem.Id,
            currentMediaSource.Id,
          );
          setInstalledByIndex(new Map(installed.map((s) => [s.index, s])));
        } catch (error) {
          console.error("Failed to fetch subtitle details", error);
        }
      }
    }
    fetchTracks();
  }, [currentItem?.Id, currentMediaSource?.Id]);

  const handleSubtitleSizeChange = (newSize: number) => {
    setSubtitleSize(newSize);
    localStorage.setItem("aperture-subtitle-size", String(newSize));
    manager.reportState({ subtitleSize: newSize });

    window.dispatchEvent(
      new CustomEvent("subtitle-size-change", { detail: { size: newSize } }),
    );
  };

  const handleSubtitleChange = (indexStr: string) => {
    const index = parseInt(indexStr);
    if (isNaN(index)) {
      return;
    }

    if (index === 9999) {
      manager.reportState({ subtitleStreamIndex: 9999 });
      return;
    }

    manager.setSubtitleStreamIndex(index);
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <SettingsMenuButton icon={Captions} isOpen={open} title="Subtitles" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        sideOffset={8}
        side="top"
        className="w-72 rounded-2xl overflow-hidden text-sm z-100 max-h-[60vh] overflow-y-auto"
        style={{
          background: "rgba(30, 30, 30, 0.65)",
          backdropFilter: "blur(40px)",
          WebkitBackdropFilter: "blur(40px)",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
        }}
      >
        <DropdownMenuRadioGroup
          value={String(playbackState.subtitleStreamIndex ?? -1)}
          onValueChange={handleSubtitleChange}
        >
          <DropdownMenuRadioItem
            value="-1"
            className="px-5 py-2.5 transition-colors hover:bg-white/10 text-white"
          >
            <span className="text-white/90 ml-3">Off</span>
          </DropdownMenuRadioItem>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              padding: "12px 20px 8px 20px",
            }}
          >
            <Type
              size={18}
              style={{ color: "rgba(255, 255, 255, 0.7)", flexShrink: 0 }}
            />

            <input
              type="range"
              min="10"
              max="400"
              value={subtitleSize}
              onChange={(e) =>
                handleSubtitleSizeChange(parseInt(e.target.value, 10))
              }
              style={
                {
                  flex: 1,
                  height: "6px",
                  borderRadius: "3px",
                  background: `linear-gradient(to right, white 0%, white ${((subtitleSize - 10) / 390) * 100}%, rgba(255, 255, 255, 0.2) ${((subtitleSize - 10) / 390) * 100}%, rgba(255, 255, 255, 0.2) 100%)`,
                  outline: "none",
                  WebkitAppearance: "none",
                  appearance: "none",
                  cursor: "pointer",
                } as React.CSSProperties & {
                  WebkitAppearance?: string;
                }
              }
            />
          </div>

          <button
            type="button"
            disabled={!subtitleOn}
            onClick={() => {
              openSync(true);
              onOpenChange(false);
            }}
            className="flex w-full items-center gap-2 px-5 py-2 text-left text-white/90 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <AudioWaveform className="ml-3 h-4 w-4" />
            Sync subtitles…
            {playbackState.subtitleOffset ? (
              <span className="ml-auto text-[11px] tabular-nums text-white/50">
                {playbackState.subtitleOffset > 0 ? "+" : ""}
                {playbackState.subtitleOffset.toFixed(3)}s
              </span>
            ) : null}
          </button>

          <DropdownMenuSeparator className="bg-white/10" />

          {subtitleTracks.map((track, i) => {
            const sub = installedByIndex.get(track.index);
            const language = sub?.language || "";
            const release =
              sub?.details?.release ||
              (sub?.isExternal && sub.path
                ? sub.path.split(/[\\/]/).pop()
                : sub?.title || "");
            const fps = sub?.details?.fps;
            return (
              <DropdownMenuRadioItem
                key={i}
                value={String(track.index)}
                className="px-5 py-2.5 transition-colors hover:bg-white/10 text-white"
              >
                <div className="ml-3 flex min-w-0 items-start gap-2">
                  {language ? (
                    <Flag language={language} size={16} className="mt-0.5 shrink-0" />
                  ) : null}
                  <div className="min-w-0">
                    <div className="text-white/90">
                      {language ? languageName(language) : track.label}
                      {sub?.isForced || sub?.details?.forced ? " · Forced" : ""}
                      {sub?.isHearingImpaired || sub?.details?.hearingImpaired
                        ? " · HI"
                        : ""}
                    </div>
                    {release || fps ? (
                      <div
                        className="truncate text-[11px] text-white/50"
                        title={release || undefined}
                      >
                        {[release, fps ? `${fps.toFixed(3)} fps` : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    ) : null}
                  </div>
                </div>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
