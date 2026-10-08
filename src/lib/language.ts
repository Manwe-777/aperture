// Jellyfin reports ISO 639-2 codes ("spa"), OpenSubtitles ISO 639-1 ("es",
// "pt-BR"). Intl canonicalizes both to the short form.
export function canonicalLanguage(code: string): string {
  try {
    return Intl.getCanonicalLocales(code)[0] ?? code;
  } catch {
    return code;
  }
}

export function languageName(code: string): string {
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "language" }).of(
        canonicalLanguage(code),
      ) ?? code
    );
  } catch {
    return code;
  }
}
