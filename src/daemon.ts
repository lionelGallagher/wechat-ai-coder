import { spawn, spawnSync, type SpawnOptions, type StdioOptions } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA_DIR } from './constants.js';

export interface DaemonPaths {
  pidFile: string;
  logDir: string;
  stdoutLog: string;
  stderrLog: string;
}

export interface PidStatus {
  running: boolean;
  message: string;
  pid?: number;
}

export interface WindowsStartConfigInput {
  nodePath: string;
  mainPath: string;
  projectDir: string;
  env: NodeJS.ProcessEnv;
  stdio: StdioOptions;
}

export interface WindowsStartConfig {
  command: string;
  args: string[];
  options: SpawnOptions;
}

const SERVICE_NAME = 'wechat-ai-coder';
const PID_FILE_NAME = `${SERVICE_NAME}.pid`;

const __filename = fileURLToPath(import.meta.url);
const DIST_DIR = dirname(__filename);
const PROJECT_DIR = dirname(DIST_DIR);
const MAIN_PATH = join(DIST_DIR, 'main.js');
const BASH_DAEMON_PATH = join(PROJECT_DIR, 'scripts', 'daemon.sh');

export function createDaemonPaths(dataDir: string = DATA_DIR): DaemonPaths {
  const logDir = join(dataDir, 'logs');
  return {
    pidFile: join(dataDir, PID_FILE_NAME),
    logDir,
    stdoutLog: join(logDir, 'stdout.log'),
    stderrLog: join(logDir, 'stderr.log'),
  };
}

function parsePid(raw: string): number | undefined {
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function getPidStatus(pidFile: string): PidStatus {
  if (!existsSync(pidFile)) {
    return { running: false, message: 'Not running' };
  }

  const pid = parsePid(readFileSync(pidFile, 'utf8'));
  if (!pid) {
    return { running: false, message: 'Not running (invalid PID file)' };
  }

  if (isPidRunning(pid)) {
    return { running: true, message: `Running (PID: ${pid})`, pid };
  }

  return { running: false, message: 'Not running (stale PID file)', pid };
}

export function buildWindowsStartConfig(input: WindowsStartConfigInput): WindowsStartConfig {
  return {
    command: input.nodePath,
    args: [input.mainPath, 'start'],
    options: {
      cwd: input.projectDir,
      detached: true,
      env: input.env,
      stdio: input.stdio,
      windowsHide: true,
    },
  };
}

function ensureWindowsReady(paths: DaemonPaths): void {
  mkdirSync(paths.logDir, { recursive: true });
  if (!existsSync(MAIN_PATH)) {
    throw new Error(`Missing ${MAIN_PATH}. Run npm run build first.`);
  }
}

function startWindows(): void {
  const paths = createDaemonPaths();
  ensureWindowsReady(paths);

  const status = getPidStatus(paths.pidFile);
  if (status.running) {
    console.log(status.message);
    return;
  }
  if (existsSync(paths.pidFile)) {
    unlinkSync(paths.pidFile);
  }

  const stdoutFd = openSync(paths.stdoutLog, 'a');
  const stderrFd = openSync(paths.stderrLog, 'a');

  try {
    const config = buildWindowsStartConfig({
      nodePath: process.execPath,
      mainPath: MAIN_PATH,
      projectDir: PROJECT_DIR,
      env: process.env,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    const child = spawn(config.command, config.args, config.options);
    if (!child.pid) {
      throw new Error('Failed to start daemon: child process did not provide a PID.');
    }
    writeFileSync(paths.pidFile, `${child.pid}\n`, 'utf8');
    child.unref();
    console.log(`Started ${SERVICE_NAME} daemon (PID: ${child.pid})`);
    console.log(`Logs: ${paths.stdoutLog}`);
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function stopWindows(): Promise<void> {
  const paths = createDaemonPaths();
  const status = getPidStatus(paths.pidFile);

  if (!status.pid) {
    if (existsSync(paths.pidFile)) unlinkSync(paths.pidFile);
    console.log(status.message);
    return;
  }

  if (!status.running) {
    unlinkSync(paths.pidFile);
    console.log(status.message);
    return;
  }

  process.kill(status.pid, 'SIGTERM');
  for (let i = 0; i < 20; i++) {
    if (!isPidRunning(status.pid)) break;
    await wait(250);
  }
  if (isPidRunning(status.pid)) {
    process.kill(status.pid, 'SIGKILL');
  }
  rmSync(paths.pidFile, { force: true });
  console.log(`Stopped ${SERVICE_NAME} daemon (PID: ${status.pid})`);
}

function statusWindows(): void {
  const paths = createDaemonPaths();
  console.log(getPidStatus(paths.pidFile).message);
}

function tailText(path: string, maxLines = 80): string | undefined {
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, 'utf8');
  return content.split(/\r?\n/).slice(-maxLines).join('\n').trimEnd();
}

function latestBridgeLog(logDir: string): string | undefined {
  if (!existsSync(logDir)) return undefined;
  const logs = readdirSync(logDir)
    .filter(name => /^bridge-.*\.log$/.test(name))
    .map(name => join(logDir, name))
    .sort()
    .reverse();
  return logs[0];
}

function logsWindows(): void {
  const paths = createDaemonPaths();
  const files = [
    latestBridgeLog(paths.logDir),
    paths.stdoutLog,
    paths.stderrLog,
  ].filter((path): path is string => !!path);

  if (files.length === 0) {
    console.log('No logs found');
    return;
  }

  let printed = false;
  for (const file of files) {
    const text = tailText(file);
    if (!text) continue;
    console.log(`=== ${file} ===`);
    console.log(text);
    printed = true;
  }
  if (!printed) {
    console.log('No log content found');
  }
}

function delegateToBash(command: string): never {
  if (!existsSync(BASH_DAEMON_PATH)) {
    console.error(`Missing daemon script: ${BASH_DAEMON_PATH}`);
    process.exit(1);
  }

  const result = spawnSync('bash', [BASH_DAEMON_PATH, command], {
    cwd: PROJECT_DIR,
    env: process.env,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

function printUsage(): void {
  console.log('Usage: npm run daemon -- {start|stop|restart|status|logs}');
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || !['start', 'stop', 'restart', 'status', 'logs'].includes(command)) {
    printUsage();
    process.exit(command ? 1 : 0);
  }

  if (process.platform !== 'win32') {
    delegateToBash(command);
  }

  switch (command) {
    case 'start':
      startWindows();
      break;
    case 'stop':
      await stopWindows();
      break;
    case 'restart':
      await stopWindows();
      startWindows();
      break;
    case 'status':
      statusWindows();
      break;
    case 'logs':
      logsWindows();
      break;
  }
}

function isCliEntrypoint(): boolean {
  return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliEntrypoint()) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
