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

const OLLAMA_BASE_URL = (
  process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
).replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3:latest';
const WORK_DIR = process.env.EJCLAW_WORK_DIR ?? '';
const MAX_DIFF_CHARS = 12_000;
const OLLAMA_TIMEOUT_MS = 120_000;

function log(message: string): void {
  console.error(`[ollama-runner] ${message}`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function tryGetGitDiff(workDir: string): string {
  if (!workDir || !fs.existsSync(workDir)) return '';
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
  } catch {
    // ignore — git may not be available or not a repo
  }
  return '';
}

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

async function callOllama(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
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
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2048,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  } finally {
    clearTimeout(timer);
  }
}

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

async function main(): Promise<void> {
  let runnerInput: RunnerInput;

  try {
    const stdinData = await readStdin();
    runnerInput = JSON.parse(stdinData) as RunnerInput;
    log(`Received input for group: ${runnerInput.groupFolder}`);
  } catch (err) {
    writeProtocolOutput<RunnerOutput>({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
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
