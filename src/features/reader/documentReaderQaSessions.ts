import type { DocumentChatSession, QaModelPreset } from '../../types/reader';

export function isQaRequestSessionSelected(
  readyWorkspaceId: string,
  requestWorkspaceId: string,
  selectedSessionId: string,
  requestSessionId: string,
): boolean {
  return Boolean(readyWorkspaceId && selectedSessionId &&
    readyWorkspaceId === requestWorkspaceId && selectedSessionId === requestSessionId);
}

export function resolveActiveQaSession(
  sessions: DocumentChatSession[],
  selectedSessionId: string,
): DocumentChatSession | null {
  return sessions.find((session) => session.id === selectedSessionId) ?? sessions[0] ?? null;
}

export function resolveQaSessionSelection(
  sessions: DocumentChatSession[],
  selectedSessionId: string,
): DocumentChatSession | null {
  if (!selectedSessionId) {
    return null;
  }

  return sessions.find((session) => session.id === selectedSessionId) ?? null;
}

export function removeQaSession(
  sessions: DocumentChatSession[],
  sessionId: string,
  createFallbackSession: () => DocumentChatSession,
): {
  sessions: DocumentChatSession[];
  selectedSessionId: string;
  removed: boolean;
} {
  const nextSessions = sessions.filter((session) => session.id !== sessionId);

  if (nextSessions.length === sessions.length) {
    return {
      sessions,
      selectedSessionId: '',
      removed: false,
    };
  }

  if (nextSessions.length === 0) {
    const fallbackSession = createFallbackSession();

    return {
      sessions: [fallbackSession],
      selectedSessionId: fallbackSession.id,
      removed: true,
    };
  }

  return {
    sessions: nextSessions,
    selectedSessionId: nextSessions[0].id,
    removed: true,
  };
}

export function resolveQaModelPreset(
  presets: QaModelPreset[],
  presetId: string,
): QaModelPreset | null {
  return presets.find((preset) => preset.id === presetId) ?? presets[0] ?? null;
}
