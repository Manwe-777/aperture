import { NextRequest, NextResponse } from "next/server";
import { getOpenSubtitlesConfig } from "@/src/actions/store/server-actions";
import { isSubtitleFileAdded } from "@/src/actions/subtitles-search";
import {
  downloadSubtitle,
  OpenSubtitlesError,
} from "@/src/lib/opensubtitles";

export async function POST(req: NextRequest) {
  const config = await getOpenSubtitlesConfig();
  if (!config?.apiKey || !config?.username || !config?.password) {
    return NextResponse.json(
      {
        message:
          "OpenSubtitles is not configured. Add your credentials in Settings.",
      },
      { status: 400 },
    );
  }

  let body: { fileId?: number; itemId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: "Invalid request body" }, { status: 400 });
  }

  const fileId = Number(body.fileId);
  if (!Number.isFinite(fileId) || fileId <= 0) {
    return NextResponse.json(
      { message: "A valid fileId is required" },
      { status: 400 },
    );
  }

  // Re-downloading spends quota for a file the item already has.
  if (body.itemId) {
    try {
      if (await isSubtitleFileAdded(body.itemId, fileId)) {
        return NextResponse.json(
          { message: "This subtitle is already added to this title" },
          { status: 409 },
        );
      }
    } catch (error) {
      console.error("Could not check for an existing subtitle:", error);
    }
  }

  try {
    const result = await downloadSubtitle(config, fileId);
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof OpenSubtitlesError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : "Subtitle download failed";
    return NextResponse.json({ message }, { status });
  }
}
