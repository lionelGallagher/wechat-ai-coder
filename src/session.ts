import { loadJson, saveJson, validateAccountId } from './store.js';
import { mkdirSync } from 'node:fs';
import { DATA_DIR, DEFAULT_WORKING_DIR } from './constants.js';
import { join } from 'node:path';
import { logger } from './logger.js';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');

export type SessionState = 'idle' | 'processing';
export type ProviderName = 'codex' | 'claude';
export const DEFAULT_PROVIDER: ProviderName = 'codex';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Session {
  provider?: ProviderName;
  providerSessionIds?: Partial<Record<ProviderName, string>>;
  previousProviderSessionIds?: Partial<Record<ProviderName, string>>;
  agentSessionId?: string;
  previousAgentSessionId?: string;
  /** Legacy Claude Code session fields kept so old JSON can be read and cleared. */
  sdkSessionId?: string;
  previousSdkSessionId?: string;
  workingDirectory: string;
  model?: string;
  state: SessionState;
  chatHistory: ChatMessage[];
  maxHistoryLength?: number;
}

const DEFAULT_MAX_HISTORY = 100;

export function parseProviderName(value: string): ProviderName | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude') return normalized;
  return undefined;
}

export function getSessionProvider(session: Session): ProviderName {
  return session.provider ?? DEFAULT_PROVIDER;
}

export function getProviderLabel(provider: ProviderName): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

export function getProviderSessionId(session: Session, provider: ProviderName = getSessionProvider(session)): string | undefined {
  const providerSessionId = session.providerSessionIds?.[provider];
  if (providerSessionId) return providerSessionId;
  if (provider === 'codex') return session.agentSessionId;
  return session.sdkSessionId;
}

export function setProviderSessionId(session: Session, provider: ProviderName, sessionId: string | undefined): void {
  const ids: Partial<Record<ProviderName, string>> = { ...(session.providerSessionIds ?? {}) };
  if (sessionId) {
    ids[provider] = sessionId;
  } else {
    delete ids[provider];
  }
  session.providerSessionIds = ids;

  // Mirror into legacy fields for compatibility with existing JSON and commands.
  if (provider === 'codex') {
    session.agentSessionId = sessionId;
  } else {
    session.sdkSessionId = sessionId;
  }
}

export function createSessionStore() {
  function getSessionPath(accountId: string): string {
    validateAccountId(accountId);
    return join(SESSIONS_DIR, `${accountId}.json`);
  }

  function load(accountId: string): Session {
    validateAccountId(accountId);
    const session = loadJson<Session>(getSessionPath(accountId), {
      provider: DEFAULT_PROVIDER,
      workingDirectory: DEFAULT_WORKING_DIR,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: DEFAULT_MAX_HISTORY,
    });

    // Backward compatibility: ensure chatHistory exists
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    if (!session.maxHistoryLength) {
      session.maxHistoryLength = DEFAULT_MAX_HISTORY;
    }
    if (!session.provider) {
      session.provider = DEFAULT_PROVIDER;
    }
    if (!session.providerSessionIds) {
      session.providerSessionIds = {};
      if (session.agentSessionId) session.providerSessionIds.codex = session.agentSessionId;
      if (session.sdkSessionId) session.providerSessionIds.claude = session.sdkSessionId;
    }

    return session;
  }

  function save(accountId: string, session: Session): void {
    mkdirSync(SESSIONS_DIR, { recursive: true });

    // Trim chat history if it exceeds max length before saving
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }

    saveJson(getSessionPath(accountId), session);
  }

  function clear(accountId: string, currentSession?: Session): Session {
    const session: Session = {
      provider: currentSession?.provider ?? DEFAULT_PROVIDER,
      providerSessionIds: {},
      previousProviderSessionIds: undefined,
      agentSessionId: undefined,
      previousAgentSessionId: undefined,
      sdkSessionId: undefined,          // explicitly clear legacy fields so Object.assign removes them
      previousSdkSessionId: undefined,
      workingDirectory: currentSession?.workingDirectory ?? DEFAULT_WORKING_DIR,
      model: currentSession?.model,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: currentSession?.maxHistoryLength || DEFAULT_MAX_HISTORY,
    };
    save(accountId, session);
    return session;
  }

  function addChatMessage(session: Session, role: 'user' | 'assistant', content: string): void {
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    session.chatHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Trim if exceeds max length
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }
  }

  function getChatHistoryText(session: Session, limit?: number): string {
    const history = session.chatHistory || [];
    const messages = limit ? history.slice(-limit) : history;

    if (messages.length === 0) {
      return '暂无对话记录';
    }

    const lines: string[] = [];
    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleString('zh-CN');
      const role = msg.role === 'user' ? '用户' : 'Codex';
      lines.push(`[${time}] ${role}:`);
      lines.push(msg.content);
      lines.push('');
    }

    return lines.join('\n');
  }

  return { load, save, clear, addChatMessage, getChatHistoryText };
}
