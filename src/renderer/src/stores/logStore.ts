import { create } from 'zustand';
import type { LogEntry, LogLevel } from '@shared/types';

interface LogState {
  logs: LogEntry[];
  level?: LogLevel;
  loadLogs: () => Promise<void>;
  addLog: (log: LogEntry) => void;
  clearLogs: () => Promise<void>;
  setLevel: (level?: LogLevel) => void;
}

const MAX_RENDERER_LOGS = 2000;
const LOG_UPDATE_BATCH_MS = 100;

export const useLogStore = create<LogState>((set) => {
  let pendingLogs: LogEntry[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshotRequestId = 0;
  let loadingSnapshot = false;

  const flushPendingLogs = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (pendingLogs.length === 0) {
      return;
    }

    const logsToAppend = pendingLogs;
    pendingLogs = [];
    set((state) => ({ logs: appendLogs(state.logs, logsToAppend) }));
  };

  const scheduleFlush = (): void => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(flushPendingLogs, LOG_UPDATE_BATCH_MS);
  };

  return {
    logs: [],
    loadLogs: async () => {
      const requestId = ++snapshotRequestId;
      loadingSnapshot = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      try {
        const logs = await window.ossApi.listLogs();
        if (requestId !== snapshotRequestId) return;
        set({ logs: appendLogs(logs, pendingLogs) });
        pendingLogs = [];
      } finally {
        if (requestId === snapshotRequestId) {
          loadingSnapshot = false;
          if (pendingLogs.length > 0) scheduleFlush();
        }
      }
    },
    addLog: (log) => {
      pendingLogs.push(log);
      if (!loadingSnapshot) scheduleFlush();
    },
    clearLogs: async () => {
      const requestId = ++snapshotRequestId;
      flushPendingLogs();
      loadingSnapshot = true;
      try {
        await window.ossApi.clearLogs();
        if (requestId !== snapshotRequestId) return;
        set({ logs: appendLogs([], pendingLogs) });
        pendingLogs = [];
      } finally {
        if (requestId === snapshotRequestId) {
          loadingSnapshot = false;
          if (pendingLogs.length > 0) scheduleFlush();
        }
      }
    },
    setLevel: (level) => set({ level })
  };
});

function appendLogs(currentLogs: LogEntry[], nextLogs: LogEntry[]): LogEntry[] {
  const logs = new Map(currentLogs.map((log) => [log.id, log]));
  for (const log of nextLogs) logs.set(log.id, log);
  return trimLogs([...logs.values()]);
}

function trimLogs(logs: LogEntry[]): LogEntry[] {
  return logs.length > MAX_RENDERER_LOGS ? logs.slice(-MAX_RENDERER_LOGS) : logs;
}
