/**
 * Shared utilities (SSOT).
 *
 * Small helpers that were previously copy-pasted across 10+ files.
 */

import fs from 'fs';

// ── Error handling ──────────────────────────────────────────────

/** Extract a human-readable message from an unknown caught value. */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extract message + stack from an unknown caught value. */
export function getErrorDetail(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

/**
 * Wrap a void-returning async fn so unhandled rejections are logged
 * instead of swallowed. Use for fire-and-forget promises.
 *
 * Example: `void safeAsync(() => doWork(), logger, 'doWork')`
 */
export function safeAsync(
  fn: () => Promise<unknown>,
  log: { warn: (obj: Record<string, unknown>, msg: string) => void },
  label: string,
): Promise<void> {
  return fn().then(
    () => {},
    (err) => {
      log.warn({ err, label }, `Unhandled async error in ${label}`);
    },
  );
}

// ── Input validation ───────────────────────────────────────────

/** Max Discord message input length we'll accept for processing. */
export const MAX_INPUT_MESSAGE_LENGTH = 32_000;

/** Max filename length after sanitisation. */
const MAX_FILENAME_LENGTH = 200;

/**
 * Sanitise a filename: strip path separators, null bytes, and control chars.
 * Returns a safe basename suitable for local disk storage.
 */
export function sanitizeFilename(raw: string): string {
  // Strip null bytes and control characters, then take basename
  const cleaned = raw.replace(/[\x00-\x1f]/g, '').replace(/[/\\]/g, '_');
  // Truncate to a reasonable length
  return cleaned.slice(0, MAX_FILENAME_LENGTH);
}

/**
 * Validate that a resolved path is contained within the expected directory.
 * Prevents path-traversal attacks via `../` in user-supplied segments.
 */
export function isPathWithin(child: string, parent: string): boolean {
  const resolvedChild = fs.realpathSync
    ? safeRealpath(child) ?? child
    : child;
  const resolvedParent = fs.realpathSync
    ? safeRealpath(parent) ?? parent
    : parent;
  return (
    resolvedChild === resolvedParent ||
    resolvedChild.startsWith(resolvedParent + '/')
  );
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    // File may not exist yet; fall back to the raw path
    return null;
  }
}

// ── JSON file I/O ───────────────────────────────────────────────

/** Read and parse a JSON file. Returns null on any failure. */
export function readJsonFile<T = unknown>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Write data as JSON to a file. */
export function writeJsonFile(
  filePath: string,
  data: unknown,
  pretty = false,
): void {
  fs.writeFileSync(
    filePath,
    JSON.stringify(data, null, pretty ? 2 : undefined),
  );
}

// ── Fetch with timeout ──────────────────────────────────────────

/** Wrapper around fetch() that aborts after timeoutMs. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Time formatting ─────────────────────────────────────────────

/** Format milliseconds as Korean elapsed time (e.g. "1시간 2분 30초"). */
export function formatElapsedKorean(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}시간`);
  if (minutes > 0) parts.push(`${minutes}분`);
  parts.push(`${seconds}초`);
  return parts.join(' ');
}
