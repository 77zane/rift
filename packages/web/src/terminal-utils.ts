import type { SessionInfo } from "@rift/shared";

export type SizeMode = "follow-host" | "fit-local";

/**
 * Sanitizes pasted text or voice-IME dictation so trailing newlines NEVER auto-submit.
 * - When bracketed paste mode is enabled by the terminal app, normalizes CR/CRLF -> LF
 *   and wraps in atomic ESC[200~ ... ESC[201~.
 * - When bracketed paste mode is disabled, collapses internal newlines to spaces so
 *   multiline paste cannot execute prematurely line-by-line.
 */
export function sanitizePastedText(raw: string, bracketedPasteMode: boolean): string | null {
  const trimmedEnd = raw.replace(/[\r\n]+$/, "");
  if (!trimmedEnd) return null;

  if (bracketedPasteMode) {
    // Strip embedded bracketed-paste markers to prevent paste-escape breakout attacks
    const normalized = trimmedEnd
      .replace(/\x1b\[20[01]~/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    return `\x1b[200~${normalized}\x1b[201~`;
  }
  return trimmedEnd.replace(/[\r\n]+/g, " ");
}

/**
 * Returns true when the Relay server has restarted (new bootId), meaning cached
 * per-session byte cursors (`lastSeq`) are invalid and must be reset to trigger a
 * clean full replay on reattach.
 */
export function shouldResetSessionCursors(
  prevBootId: string | null,
  nextBootId: string | undefined
): boolean {
  return Boolean(prevBootId && nextBootId && prevBootId !== nextBootId);
}

/**
 * Default terminal sizing policy:
 * - Manual per-session override always wins.
 * - Headless (`+` remote-spawned) sessions default to `fit-local` (fill browser).
 * - Local desktop sessions default to `follow-host` (never squish desktop layout).
 */
export function resolveSizeMode(
  sess: Pick<SessionInfo, "sessionId" | "headless"> | null,
  overrides: ReadonlyMap<string, SizeMode>
): SizeMode {
  if (!sess) return "follow-host";
  const manual = overrides.get(sess.sessionId);
  if (manual) return manual;
  return sess.headless ? "fit-local" : "follow-host";
}
