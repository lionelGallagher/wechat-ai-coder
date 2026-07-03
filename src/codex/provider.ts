import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../logger.js';

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  systemPrompt?: string;
  images?: Array<{
    type: 'image';
    source: { type: 'base64'; media_type: string; data: string };
  }>;
  onText?: (text: string) => Promise<void> | void;
  onTurnEnd?: (stopReason: string) => Promise<void> | void;
  abortController?: AbortController;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
}

export interface CodexParserState {
  sessionId: string;
  textParts: string[];
  errorMessage?: string;
}

export interface CodexParserCallbacks {
  onText?: (text: string) => void;
  onTurnEnd?: (stopReason: string) => void;
}

export interface CodexCommandOptions {
  cwd: string;
  resume?: string;
  model?: string;
  imagePaths?: string[];
}

export interface CodexCommand {
  command: string;
  args: string[];
}

const TEMP_DIR = join(tmpdir(), 'wechat-ai-coder-codex');
const QUERY_TIMEOUT_MS = 60 * 60 * 1000;

function saveImageTemp(images: NonNullable<QueryOptions['images']>): string[] {
  mkdirSync(TEMP_DIR, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const ext = img.source.media_type.split('/')[1] || 'png';
    const fileName = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = join(TEMP_DIR, fileName);
    writeFileSync(filePath, Buffer.from(img.source.data, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* ignore cleanup failures */ }
  }
}

function errorMessageFrom(value: unknown): string {
  if (!value) return 'Unknown Codex error';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return JSON.stringify(value);
}

function findCodexJs(): string | undefined {
  const candidateDirs = [
    dirname(process.execPath),
    ...(process.env.PATH ?? '').split(delimiter),
  ].filter(Boolean);

  for (const dir of candidateDirs) {
    const candidate = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

function resolveCodexExecutable(): { command: string; prefixArgs: string[] } {
  if (process.env.WCC_CODEX_BIN) {
    return { command: process.env.WCC_CODEX_BIN, prefixArgs: [] };
  }

  if (process.platform === 'win32') {
    const codexJs = findCodexJs();
    if (codexJs) {
      return { command: process.execPath, prefixArgs: [codexJs] };
    }
  }

  return { command: 'codex', prefixArgs: [] };
}

export function buildCodexCommand(options: CodexCommandOptions): CodexCommand {
  const { command, prefixArgs } = resolveCodexExecutable();
  const args = options.resume
    ? [
        'exec',
        'resume',
        '--json',
        '-c',
        'approval_policy="never"',
        '-c',
        'sandbox_mode="danger-full-access"',
      ]
    : [
        'exec',
        '--json',
        '--cd',
        options.cwd,
        '--sandbox',
        'danger-full-access',
        '-c',
        'approval_policy="never"',
      ];

  if (options.model) args.push('--model', options.model);
  for (const imagePath of options.imagePaths ?? []) {
    args.push('--image', imagePath);
  }
  if (options.resume) args.push(options.resume);
  args.push('-');

  return { command, args: [...prefixArgs, ...args] };
}

export function buildCodexSpawnOptions(cwd: string): SpawnOptions {
  return {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    shell: false,
  };
}

export function handleCodexJsonLine(
  line: string,
  state: CodexParserState,
  callbacks: CodexParserCallbacks,
): void {
  if (!line.trim()) return;

  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  switch (obj.type) {
    case 'thread.started':
      if (obj.thread_id) state.sessionId = obj.thread_id;
      break;
    case 'item.completed': {
      const item = obj.item;
      if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text) {
        state.textParts.push(item.text);
        if (callbacks.onText) Promise.resolve(callbacks.onText(item.text)).catch(() => {});
      }
      break;
    }
    case 'turn.completed':
      state.errorMessage = undefined;
      if (callbacks.onTurnEnd) Promise.resolve(callbacks.onTurnEnd('end_turn')).catch(() => {});
      break;
    case 'turn.failed':
      state.errorMessage = errorMessageFrom(obj.error ?? obj.message);
      break;
    case 'error':
      state.errorMessage = errorMessageFrom(obj.error ?? obj.message);
      break;
    default:
      break;
  }
}

export async function codexQuery(options: QueryOptions): Promise<QueryResult> {
  const {
    prompt,
    cwd,
    resume,
    model,
    systemPrompt,
    images,
    onText,
    onTurnEnd,
    abortController,
  } = options;

  const tempImagePaths = images?.length ? saveImageTemp(images) : [];
  const { command, args } = buildCodexCommand({
    cwd,
    resume,
    model,
    imagePaths: tempImagePaths,
  });
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

  logger.info('Starting Codex CLI query', {
    cwd,
    model,
    resume: !!resume,
    hasImages: tempImagePaths.length > 0,
  });

  let child: ChildProcess | undefined;
  let settled = false;
  const parserState: CodexParserState = { sessionId: '', textParts: [] };

  return new Promise<QueryResult>((resolve) => {
    const finish = (result: QueryResult) => {
      if (settled) return;
      settled = true;
      cleanupTempFiles(tempImagePaths);
      resolve(result);
    };

    try {
      child = spawn(command, args, buildCodexSpawnOptions(cwd));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ text: '', sessionId: '', error: `Failed to spawn codex: ${msg}` });
      return;
    }

    child.stdin!.write(fullPrompt);
    child.stdin!.end();

    const timeoutId = setTimeout(() => {
      logger.warn('Codex CLI query timed out, killing process');
      child!.kill('SIGTERM');
      const partialText = parserState.textParts.join('\n').trim();
      finish({
        text: partialText,
        sessionId: parserState.sessionId,
        error: partialText ? undefined : 'Codex query timed out after 60 minutes',
      });
    }, QUERY_TIMEOUT_MS);

    const onAbort = () => {
      logger.info('Codex CLI query aborted');
      child!.kill('SIGTERM');
      const partialText = parserState.textParts.join('\n').trim();
      finish({ text: partialText, sessionId: parserState.sessionId });
    };
    abortController?.signal.addEventListener('abort', onAbort, { once: true });

    const stderrParts: string[] = [];
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderrParts.push(chunk);
    });

    const callbacks: CodexParserCallbacks = { onText, onTurnEnd };
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      handleCodexJsonLine(line, parserState, callbacks);
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);

      if (code !== 0 && code !== null && !parserState.textParts.length && !parserState.errorMessage) {
        const stderr = stderrParts.join('').trim();
        parserState.errorMessage = stderr || `codex exited with code ${code}`;
        logger.error('Codex CLI exited with error', { code, stderr: stderr.slice(0, 500) });
      }

      const fullText = parserState.textParts.join('\n').trim();
      if (!fullText && !parserState.errorMessage) {
        parserState.errorMessage = 'Codex returned an empty response.';
      }

      logger.info('Codex CLI query completed', {
        sessionId: parserState.sessionId,
        textLength: fullText.length,
        hasError: !!parserState.errorMessage,
      });

      finish({
        text: fullText,
        sessionId: parserState.sessionId,
        error: parserState.errorMessage,
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);
      finish({ text: '', sessionId: parserState.sessionId, error: `Failed to spawn codex: ${err.message}` });
    });
  });
}
