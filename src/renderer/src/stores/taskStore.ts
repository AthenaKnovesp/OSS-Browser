import { create } from 'zustand';
import type { TaskItem, TaskStatus } from '@shared/types';

interface TaskState {
  tasks: TaskItem[];
  loadTasks: () => Promise<void>;
  upsertTask: (task: TaskItem) => void;
  clearCompleted: () => Promise<void>;
}

const TASK_UPDATE_BATCH_MS = 100;
const TERMINAL_STATUSES = new Set<TaskStatus>([
  'success',
  'failed',
  'partial_success',
  'canceled',
  'stopped'
]);

export const useTaskStore = create<TaskState>((set, get) => {
  const pendingTaskUpdates = new Map<string, TaskItem>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flushPendingTaskUpdates = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (pendingTaskUpdates.size === 0) {
      return;
    }

    const updates = [...pendingTaskUpdates.values()];
    pendingTaskUpdates.clear();
    set((state) => mergeTaskUpdates(state, updates));
  };

  const scheduleFlush = (): void => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(flushPendingTaskUpdates, TASK_UPDATE_BATCH_MS);
  };

  return {
    tasks: [],
    loadTasks: async () => {
      pendingTaskUpdates.clear();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      const tasks = await window.ossApi.listTasks();
      set({ tasks: sortTasks(tasks) });
    },
    upsertTask: (task) => {
      pendingTaskUpdates.set(task.id, task);
      if (task.status === 'pending' || TERMINAL_STATUSES.has(task.status)) {
        flushPendingTaskUpdates();
        return;
      }
      scheduleFlush();
    },
    clearCompleted: async () => {
      pendingTaskUpdates.clear();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      await window.ossApi.clearCompletedTasks();
      await get().loadTasks();
    }
  };
});

function mergeTaskUpdates(state: TaskState, updates: TaskItem[]): TaskState | Pick<TaskState, 'tasks'> {
  if (updates.length === 0) {
    return state;
  }

  let changed = false;
  let tasks = state.tasks;

  for (const task of updates) {
    const existingIndex = tasks.findIndex((item) => item.id === task.id);
    if (existingIndex >= 0) {
      if (sameTask(tasks[existingIndex], task)) {
        continue;
      }
      if (tasks === state.tasks) {
        tasks = state.tasks.slice();
      }
      tasks[existingIndex] = task;
      changed = true;
      continue;
    }

    if (tasks === state.tasks) {
      tasks = state.tasks.slice();
    }
    insertTaskByCreatedAt(tasks, task);
    changed = true;
  }

  return changed ? { tasks } : state;
}

function insertTaskByCreatedAt(tasks: TaskItem[], task: TaskItem): void {
  const index = tasks.findIndex((item) => compareTaskCreatedAt(task, item) < 0);
  if (index === -1) {
    tasks.push(task);
    return;
  }
  tasks.splice(index, 0, task);
}

function sortTasks(tasks: TaskItem[]): TaskItem[] {
  return tasks.slice().sort(compareTaskCreatedAt);
}

function compareTaskCreatedAt(a: TaskItem, b: TaskItem): number {
  return safeText(b.createdAt).localeCompare(safeText(a.createdAt));
}

function sameTask(left: TaskItem, right: TaskItem): boolean {
  return (
    left.id === right.id &&
    left.connectionId === right.connectionId &&
    left.connectionName === right.connectionName &&
    left.type === right.type &&
    left.name === right.name &&
    left.source === right.source &&
    left.target === right.target &&
    left.progress === right.progress &&
    left.status === right.status &&
    left.speed === right.speed &&
    left.transferredBytes === right.transferredBytes &&
    left.totalBytes === right.totalBytes &&
    left.completedParts === right.completedParts &&
    left.totalParts === right.totalParts &&
    left.createdAt === right.createdAt &&
    left.startedAt === right.startedAt &&
    left.updatedAt === right.updatedAt &&
    left.completedAt === right.completedAt &&
    left.durationMs === right.durationMs &&
    left.errorMessage === right.errorMessage &&
    left.retries === right.retries &&
    left.maxRetries === right.maxRetries &&
    sameTaskStats(left.stats, right.stats) &&
    sameJson(left.failure, right.failure) &&
    sameJson(left.report, right.report) &&
    sameJson(left.partStats, right.partStats)
  );
}

function sameTaskStats(left: TaskItem['stats'], right: TaskItem['stats']): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.total === right.total &&
    left.processed === right.processed &&
    left.success === right.success &&
    left.failed === right.failed &&
    left.skipped === right.skipped
  );
}

function safeText(value: string | undefined): string {
  return value ?? '';
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}
