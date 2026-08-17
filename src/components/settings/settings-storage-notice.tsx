"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, HardDrive } from "lucide-react";
import { getSettingsStorageInfo } from "@/src/actions/store/server-actions";

/**
 * Integration config is stored on the Aperture server rather than in the
 * browser, so it survives logout and follows you between devices. This tells
 * the user where it lives — and warns loudly when the data directory is not
 * writable, since settings would then silently vanish on restart.
 */
export default function SettingsStorageNotice() {
  const [info, setInfo] = useState<{ path: string; writable: boolean } | null>(
    null,
  );

  useEffect(() => {
    getSettingsStorageInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  if (!info) return null;

  if (!info.writable) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-600 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          <span className="font-medium">
            Settings cannot be saved on the server.
          </span>{" "}
          <span className="break-all">{info.path}</span> is not writable — mount
          a volume there and set <code>APERTURE_DATA_DIR</code>, or these
          settings will be lost when the container restarts.
        </span>
      </div>
    );
  }

  return (
    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <HardDrive className="h-3 w-3 shrink-0" />
      Saved on the Aperture server (<span className="break-all">
        {info.path}
      </span>
      ), shared by all users and kept across devices and sign-outs.
    </p>
  );
}
