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
      pendingLogs = [];
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      const logs = await window.ossApi.listLogs();
      set({ logs: trimLogs(logs) });
    },
    addLog: (log) => {
      pendingLogs.push(log);
      scheduleFlush();
    },
    clearLogs: async () => {
      pendingLogs = [];
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      await window.ossApi.clearLogs();
      set({ logs: [] });
    },
    setLevel: (level) => set({ level })
  };
});

function appendLogs(currentLogs: LogEntry[], nextLogs: LogEntry[]): LogEntry[] {
  if (nextLogs.length >= MAX_RENDERER_LOGS) {
    return nextLogs.slice(-MAX_RENDERER_LOGS);
  }
  const keptCurrentLogs = currentLogs.slice(
    Math.max(0, currentLogs.length + nextLogs.length - MAX_RENDERER_LOGS)
  );
  return [...keptCurrentLogs, ...nextLogs];
}

function trimLogs(logs: LogEntry[]): LogEntry[] {
  return logs.length > MAX_RENDERER_LOGS ? logs.slice(-MAX_RENDERER_LOGS) : logs;
}
