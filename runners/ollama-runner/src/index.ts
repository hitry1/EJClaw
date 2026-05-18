/**
 * EJClaw Ollama Runner
 *
 * Lightweight runner that sends prompts to a local Ollama instance via HTTP.
 * Designed for reviewer / arbiter roles where file-system access isn't needed.
 *
 * Input protocol:
 *   Stdin: Full RunnerInput JSON (read until EOF)
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  writeProtocolOutput,
  type RunnerStructuredOutput,
} from 'ejclaw-runners-shared';

interface RunnerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  roomRoleContext?: { role?: string };
}

interface RunnerOutput {
  status: 'success' | 'error';
  result: string | null;
  output?: RunnerStructuredOutput;
  newSessionId?: string;
  error?: string;
}

// ── Configuration ──────────────────────────────────────────────

const OLLAMA_BASE_URL = (
  process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
).replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3:latest';
const WORK_DIR = process.env.EJCLAW_WORK_DIR ?? '';
const MAX_DIFF_CHARS = 12_000;
const OLLAMA_TIMEOUT_MS = 120_000;

// ── Security limits ────────────────────────────────────────────

/** Maximum stdin payload size (1 MB). Prevents OOM from malformed input. */
const MAX_STDIN_BYTES = 1_048_576;

/** Maximum prompt length sent to Ollama (64k chars). */
const MAX_PROMPT_CHARS = 64_000;

/** Maximum response length accepted from Ollama (128k chars). */
const MAX_RESPONSE_CHARS = 128_000;

/** Allowed group folder name pattern (alphanumeric, hyphens, underscores). */
const SAFE_GROUP_FOLDER_RE = /^[\w-]+$/;

// ── Process-level error handling ───────────────────────────────

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
  writeProtocolOutput<RunnerOutput>({
    status: 'error',
    result: null,
    error: `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  writeProtocolOutput<RunnerOutput>({
    status: 'error',
    result: null,
    error: `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
  });
  process.exit(1);
});

// ── Helpers ────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[ollama-runner] ${message}`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let byteLength = 0;
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      byteLength += Buffer.byteLength(chunk, 'utf-8');
      if (byteLength > MAX_STDIN_BYTES) {
        reject(
          new Error(
            `Stdin payload exceeds ${MAX_STDIN_BYTES} bytes (received ${byteLength})`,
          ),
        );
        process.stdin.destroy();
        return;
      }
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ── Input validation ───────────────────────────────────────────

function validateRunnerInput(raw: unknown): RunnerInput {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Runner input must be a non-null object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) {
    throw new Error('Runner input must have a non-empty string "prompt"');
  }

  if (typeof obj.groupFolder !== 'string' || obj.groupFolder.length === 0) {
    throw new Error('Runner input must have a non-empty string "groupFolder"');
  }

  // Sanitize groupFolder to prevent path traversal
  if (!SAFE_GROUP_FOLDER_RE.test(obj.groupFolder)) {
    throw new Error(
      `Invalid groupFolder: must match ${SAFE_GROUP_FOLDER_RE} (got "${obj.groupFolder.slice(0, 50)}")`,
    );
  }

  if (typeof obj.chatJid !== 'string' || obj.chatJid.length === 0) {
    throw new Error('Runner input must have a non-empty string "chatJid"');
  }

  if (typeof obj.isMain !== 'boolean') {
    throw new Error('Runner input must have a boolean "isMain"');
  }

  // Validate optional fields
  if (
    obj.roomRoleContext !== undefined &&
    obj.roomRoleContext !== null &&
    typeof obj.roomRoleContext !== 'object'
  ) {
    throw new Error('Runner input "roomRoleContext" must be an object if provided');
  }

  const role = (obj.roomRoleContext as Record<string, unknown> | undefined)?.role;
  if (role !== undefined && typeof role !== 'string') {
    throw new Error('Runner input "roomRoleContext.role" must be a string if provided');
  }

  return {
    prompt: obj.prompt as string,
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
    groupFolder: obj.groupFolder as string,
    chatJid: obj.chatJid as string,
    isMain: obj.isMain as boolean,
    isScheduledTask:
      typeof obj.isScheduledTask === 'boolean' ? obj.isScheduledTask : undefined,
    assistantName:
      typeof obj.assistantName === 'string' ? obj.assistantName : undefined,
    roomRoleContext: obj.roomRoleContext as { role?: string } | undefined,
  };
}

// ── Git diff ───────────────────────────────────────────────────

function isValidWorkDir(workDir: string): boolean {
  if (!workDir) return false;
  // Must be an absolute path
  if (!path.isAbsolute(workDir)) return false;
  // Must not contain path traversal
  if (workDir.includes('..')) return false;
  return fs.existsSync(workDir);
}

function tryGetGitDiff(workDir: string): string {
  if (!isValidWorkDir(workDir)) return '';
  try {
    // Use spawnSync with args array to avoid shell injection
    const result = spawnSync('git', ['diff', 'HEAD'], {
      cwd: workDir,
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.slice(0, MAX_DIFF_CHARS);
    }
    const staged = spawnSync('git', ['diff', '--cached'], {
      cwd: workDir,
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (staged.status === 0) return staged.stdout.slice(0, MAX_DIFF_CHARS);
  } catch (err) {
    log(
      `Git diff failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return '';
}

// ── Prompt construction ────────────────────────────────────────

function buildSystemPrompt(role: string | undefined): string {
  if (role === 'reviewer') {
    return [
      'You are a code reviewer in a multi-agent software development system.',
      "Review the owner agent's work carefully and respond with one of:",
      '- "DONE" — work is complete and correct',
      '- "DONE_WITH_CONCERNS" — work is acceptable but has minor issues (explain briefly)',
      '- "BLOCKED" — work has critical problems that must be fixed (explain clearly)',
      'Be concise. Focus on correctness, completeness, and quality.',
    ].join('\n');
  }
  if (role === 'arbiter') {
    return [
      'You are an arbiter in a multi-agent software development system.',
      'Given a disagreement between owner and reviewer agents, decide the outcome.',
      'Respond with one of: DONE, DONE_WITH_CONCERNS, or BLOCKED.',
      'Give a brief explanation for your decision.',
    ].join('\n');
  }
  return 'You are a helpful AI assistant in a software development team.';
}

// ── Ollama API call ────────────────────────────────────────────

async function callOllama(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  // Enforce prompt size limit before sending
  const truncatedPrompt =
    userPrompt.length > MAX_PROMPT_CHARS
      ? userPrompt.slice(0, MAX_PROMPT_CHARS) +
        '\n\n[... prompt truncated due to size limit ...]'
      : userPrompt;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ollama',
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: truncatedPrompt },
        ],
        max_tokens: 2048,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch((bodyErr) => {
        log(
          `Failed to read Ollama error response body: ${bodyErr instanceof Error ? bodyErr.message : String(bodyErr)}`,
        );
        return '';
      });
      throw new Error(`Ollama HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';

    // Enforce response size limit
    if (content.length > MAX_RESPONSE_CHARS) {
      log(
        `Ollama response truncated: ${content.length} chars → ${MAX_RESPONSE_CHARS}`,
      );
      return content.slice(0, MAX_RESPONSE_CHARS);
    }

    return content;
  } finally {
    clearTimeout(timer);
  }
}

// ── Verdict parsing ────────────────────────────────────────────

function parseVerdict(
  text: string,
): RunnerStructuredOutput & { visibility: 'public' } {
  const upper = text.toUpperCase();
  let verdict: 'done' | 'done_with_concerns' | 'blocked' | undefined;
  if (
    upper.includes('DONE_WITH_CONCERNS') ||
    upper.includes('DONE WITH CONCERNS')
  ) {
    verdict = 'done_with_concerns';
  } else if (upper.includes('BLOCKED')) {
    verdict = 'blocked';
  } else if (upper.includes('DONE')) {
    verdict = 'done';
  }
  return { visibility: 'public', text, ...(verdict ? { verdict } : {}) };
}

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  let runnerInput: RunnerInput;

  try {
    const stdinData = await readStdin();
    const parsed = JSON.parse(stdinData) as unknown;
    runnerInput = validateRunnerInput(parsed);
    log(`Received input for group: ${runnerInput.groupFolder}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Input parsing/validation failed: ${errorMessage}`);
    writeProtocolOutput<RunnerOutput>({
      status: 'error',
      result: null,
      error: `Failed to parse/validate input: ${errorMessage}`,
    });
    process.exit(1);
  }

  const role = runnerInput.roomRoleContext?.role;
  log(`Role: ${role ?? 'none'}, model: ${OLLAMA_MODEL}`);

  let userPrompt = runnerInput.prompt;

  if (runnerInput.isScheduledTask) {
    userPrompt = `[SCHEDULED TASK]\n\n${userPrompt}`;
  }

  // Attach git diff for reviewer so Ollama can see actual file changes
  if (role === 'reviewer' && WORK_DIR) {
    const diff = tryGetGitDiff(WORK_DIR);
    if (diff) {
      userPrompt += `\n\n---\n### Git diff (workspace changes)\n\`\`\`diff\n${diff}\n\`\`\``;
      log(`Appended git diff (${diff.length} chars)`);
    }
  }

  const systemPrompt = buildSystemPrompt(role);

  try {
    log(`Calling Ollama at ${OLLAMA_BASE_URL} with model ${OLLAMA_MODEL}`);
    const responseText = await callOllama(systemPrompt, userPrompt);

    if (!responseText) {
      log('Ollama returned empty response');
      writeProtocolOutput<RunnerOutput>({
        status: 'error',
        result: null,
        error: 'Ollama returned an empty response',
      });
      process.exit(1);
    }

    log(`Got response (${responseText.length} chars)`);

    const output = parseVerdict(responseText);

    writeProtocolOutput<RunnerOutput>({
      status: 'success',
      result: responseText,
      output,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Ollama error: ${errorMessage}`);
    writeProtocolOutput<RunnerOutput>({
      status: 'error',
      result: null,
      error: `Ollama call failed: ${errorMessage}`,
    });
    process.exit(1);
  }
}

main();
