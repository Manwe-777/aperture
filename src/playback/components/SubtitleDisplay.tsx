import React, { useState, useEffect } from "react";
import {
  findActiveCue,
  loadCues,
  type SubtitleCue as SubtitleLine,
} from "../utils/subtitleCues";

interface SubtitleTrack {
  index: number;
  label: string;
  src: string;
  language?: string;
  kind?: string;
}

interface SubtitleDisplayProps {
  currentTime: number;
  subtitleStreamIndex?: number;
  textTracks?: SubtitleTrack[];
  isVisible?: boolean;
  isControlsVisible?: boolean;
  // Seconds to shift cues by; positive shows them later.
  subtitleOffset?: number;
}

/**
 * Parse HTML tags in subtitle text and convert to React elements with proper nesting
 */
function parseSubtitleHTML(text: string): React.ReactNode {
  const htmlRegex = /<(\/?)([a-zA-Z0-9-]+)[^>]*>/gi;
  const segments: (
    | React.ReactNode
    | { tag: string; isClosing: boolean; attributes: string }
  )[] = [];
  let lastIndex = 0;

  let match;
  while ((match = htmlRegex.exec(text)) !== null) {
    // Add text before this tag
    if (match.index > lastIndex) {
      segments.push(text.substring(lastIndex, match.index));
    }

    // Add tag marker
    segments.push({
      tag: match[2].toLowerCase(),
      isClosing: match[1] === "/",
      attributes: match[0],
    });

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    segments.push(text.substring(lastIndex));
  }

  // Recursively build React elements from segments
  function buildElements(
    items: any[],
    startIdx = 0,
  ): { elements: React.ReactNode[]; endIdx: number } {
    const elements: React.ReactNode[] = [];
    let idx = startIdx;

    while (idx < items.length) {
      const item = items[idx];

      // If it's text, just add it
      if (typeof item === "string") {
        elements.push(item);
        idx++;
      }
      // If it's a tag
      else if (item.tag) {
        if (item.isClosing) {
          // Return to parent level
          return { elements, endIdx: idx };
        } else {
          // Open tag - recursively parse children
          const { elements: childElements, endIdx: nextIdx } = buildElements(
            items,
            idx + 1,
          );

          // Create the appropriate element based on tag
          let element: React.ReactNode = <>{childElements}</>;

          switch (item.tag) {
            case "i":
              element = <i key={`i-${idx}`}>{childElements}</i>;
              break;
            case "b":
              element = <b key={`b-${idx}`}>{childElements}</b>;
              break;
            case "u":
              element = <u key={`u-${idx}`}>{childElements}</u>;
              break;
            case "s":
              element = <s key={`s-${idx}`}>{childElements}</s>;
              break;
            case "font":
              const style: React.CSSProperties = {};
              const colorMatch = item.attributes?.match(
                /color=(?:"([^"]+)"|'([^']+)'|([^>\s]+))/i,
              );
              if (colorMatch)
                style.color = colorMatch[1] || colorMatch[2] || colorMatch[3];

              const faceMatch = item.attributes?.match(
                /face=(?:"([^"]+)"|'([^']+)'|([^>\s]+))/i,
              );
              if (faceMatch)
                style.fontFamily = faceMatch[1] || faceMatch[2] || faceMatch[3];

              element = (
                <span key={`span-${idx}`} style={style}>
                  {childElements}
                </span>
              );
              break;
            default:
              element = <span key={`span-${idx}`}>{childElements}</span>;
          }

          elements.push(element);
          idx = nextIdx + 1; // Skip the closing tag
        }
      } else {
        idx++;
      }
    }

    return { elements, endIdx: items.length };
  }

  const { elements } = buildElements(segments);
  return elements;
}

export const SubtitleDisplay: React.FC<SubtitleDisplayProps> = ({
  currentTime,
  subtitleStreamIndex,
  textTracks = [],
  isVisible = true,
  isControlsVisible = true,
  subtitleOffset = 0,
}) => {
  const [allSubtitles, setAllSubtitles] = useState<Map<number, SubtitleLine[]>>(
    new Map(),
  );
  const [currentSubtitle, setCurrentSubtitle] = useState<SubtitleLine | null>(
    null,
  );
  const [subtitleSize, setSubtitleSize] = useState<number>(100);

  // Load subtitle size from localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("aperture-subtitle-size");
      if (saved) {
        setSubtitleSize(parseInt(saved, 10));
      }
    }
  }, []);

  // Listen for storage changes (subtitle size updates)
  useEffect(() => {
    const handleStorageChange = () => {
      if (typeof window !== "undefined") {
        const saved = localStorage.getItem("aperture-subtitle-size");
        if (saved) {
          setSubtitleSize(parseInt(saved, 10));
        }
      }
    };

    const handleSubtitleSizeEvent = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail?.size) {
        setSubtitleSize(customEvent.detail.size);
      }
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("subtitle-size-change", handleSubtitleSizeEvent);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(
        "subtitle-size-change",
        handleSubtitleSizeEvent,
      );
    };
  }, []);

  // Fetch and parse all subtitle files
  useEffect(() => {
    if (!textTracks || textTracks.length === 0) {
      setAllSubtitles(new Map());
      setCurrentSubtitle(null);
      return;
    }

    const loadAllSubtitles = async () => {
      const subtitleMap = new Map<number, SubtitleLine[]>();

      for (const track of textTracks) {
        try {
          subtitleMap.set(track.index, await loadCues(track.src));
        } catch (error) {
          console.error(`Error loading subtitles for ${track.label}:`, error);
        }
      }

      setAllSubtitles(subtitleMap);
    };

    loadAllSubtitles();
  }, [textTracks]);

  // Update current subtitle based on selected track and playback time
  useEffect(() => {
    if (subtitleStreamIndex === undefined || subtitleStreamIndex === -1) {
      setCurrentSubtitle(null);
      return;
    }

    const subtitles = allSubtitles.get(subtitleStreamIndex);
    if (!subtitles || subtitles.length === 0) {
      setCurrentSubtitle(null);
      return;
    }

    // timeupdate only fires ~4x a second, too coarse to judge sync by. Read
    // the video's clock every frame instead; re-render only when the cue changes.
    const video = document.querySelector<HTMLVideoElement>(
      "[data-player-container] video",
    );
    let shown = -2;
    const update = (time: number) => {
      const index = findActiveCue(subtitles, time - subtitleOffset);
      if (index !== shown) {
        shown = index;
        setCurrentSubtitle(index >= 0 ? subtitles[index] : null);
      }
    };

    if (!video) {
      update(currentTime);
      return;
    }
    let frame = requestAnimationFrame(function tick() {
      update(video.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [currentTime, subtitleStreamIndex, allSubtitles, subtitleOffset]);

  if (!isVisible || !currentSubtitle) {
    return null;
  }

  return (
    <div
      className="absolute left-0 right-0 flex justify-center pointer-events-none transition-all duration-300"
      style={{
        bottom: isControlsVisible ? "176px" : "112px",
        zIndex: 40,
      }}
    >
      <div
        style={{
          maxWidth: "95%",
          textAlign: "center",
        }}
      >
        <div
          className="text-white leading-relaxed whitespace-pre-wrap"
          style={{
            fontSize: `${20 * (subtitleSize / 100)}px`,
            fontFamily: '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
            fontWeight: 400,
            textShadow:
              "2px 2px 4px rgba(0, 0, 0, 1), -2px -2px 4px rgba(0, 0, 0, 1), 2px -2px 4px rgba(0, 0, 0, 1), -2px 2px 4px rgba(0, 0, 0, 1)",
            letterSpacing: "0.5px",
            lineHeight: "1.4",
          }}
        >
          {parseSubtitleHTML(currentSubtitle.text)}
        </div>
      </div>
    </div>
  );
};
