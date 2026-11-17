import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { IPC_CHANNELS, type OssApi } from '@shared/ipc';
import type { LogEntry, TaskItem } from '@shared/types';

export type DesktopInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export type DesktopListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void
) => Promise<UnlistenFn>;

export function normalizeDesktopError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return Object.assign(new Error(String(error.message)), error);
  }
  return new Error(String(error));
}

export async function createDesktopApi(
  call: DesktopInvoke = tauriInvoke,
  subscribe: DesktopListen = listen
): Promise<{ api: OssApi; dispose: () => void }> {
  const tasks = new Set<(task: TaskItem) => void>();
  const logs = new Set<(log: LogEntry) => void>();
  const maximized = new Set<(value: boolean) => void>();
  const results = await Promise.allSettled([
    subscribe<TaskItem>(IPC_CHANNELS.TASK_UPDATED, ({ payload }) =>
      tasks.forEach((f) => f(payload))
    ),
    subscribe<LogEntry>(IPC_CHANNELS.LOG_ADDED, ({ payload }) => logs.forEach((f) => f(payload))),
    subscribe<boolean>(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, ({ payload }) =>
      maximized.forEach((f) => f(payload))
    )
  ]);
  const unlisteners = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    unlisteners.forEach((f) => f());
    throw normalizeDesktopError(failure.reason);
  }
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    try {
      return await call<T>('dispatch', { channel, args });
    } catch (error) {
      throw normalizeDesktopError(error);
    }
  };
  const api: OssApi = {
    windowMinimize: () => invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    windowMaximize: () => invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
    isWindowMaximized: () => invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    windowClose: () => invoke(IPC_CHANNELS.WINDOW_CLOSE),
    selectFiles: () => invoke(IPC_CHANNELS.DIALOG_SELECT_FILES),
    selectFolder: () => invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDER),
    selectUploadFolder: () => invoke(IPC_CHANNELS.DIALOG_SELECT_UPLOAD_FOLDER),
    getConfig: () => invoke(IPC_CHANNELS.CONFIG_GET),
    saveConnection: (connection) => invoke(IPC_CHANNELS.CONFIG_SAVE_CONNECTION, connection),
    deleteConnection: (id) => invoke(IPC_CHANNELS.CONFIG_DELETE_CONNECTION, id),
    setActiveConnection: (id) => invoke(IPC_CHANNELS.CONFIG_SET_ACTIVE_CONNECTION, id),
    saveSettings: (config) => invoke(IPC_CHANNELS.CONFIG_SAVE_SETTINGS, config),
    testConnection: (connection) => invoke(IPC_CHANNELS.S3_TEST_CONNECTION, connection),
    listBuckets: (id) => invoke(IPC_CHANNELS.S3_LIST_BUCKETS, id),
    listObjects: (...args) => invoke(IPC_CHANNELS.S3_LIST_OBJECTS, ...args),
    listObjectsFlat: (...args) => invoke(IPC_CHANNELS.S3_LIST_OBJECTS_FLAT, ...args),
    listFolders: (...args) => invoke(IPC_CHANNELS.S3_LIST_FOLDERS, ...args),
    createFolder: (...args) => invoke(IPC_CHANNELS.S3_CREATE_FOLDER, ...args),
    getObjectMetadata: (...args) => invoke(IPC_CHANNELS.S3_METADATA, ...args),
    generateObjectUrl: (...args) => invoke(IPC_CHANNELS.S3_GENERATE_URL, ...args),
    uploadObjects: (request) => invoke(IPC_CHANNELS.TASK_UPLOAD, request),
    downloadObject: (request) => invoke(IPC_CHANNELS.TASK_DOWNLOAD, request),
    deleteObject: (request) => invoke(IPC_CHANNELS.TASK_DELETE, request),
    copyObject: (request) => invoke(IPC_CHANNELS.TASK_COPY, request),
    moveObject: (request) => invoke(IPC_CHANNELS.TASK_MOVE, request),
    renameObject: (request) => invoke(IPC_CHANNELS.TASK_RENAME, request),
    listTasks: () => invoke(IPC_CHANNELS.TASK_LIST),
    cancelTask: (id) => invoke(IPC_CHANNELS.TASK_CANCEL, id),
    retryTask: (id) => invoke(IPC_CHANNELS.TASK_RETRY, id),
    clearCompletedTasks: () => invoke(IPC_CHANNELS.TASK_CLEAR_COMPLETED),
    listLogs: () => invoke(IPC_CHANNELS.LOG_LIST),
    clearLogs: () => invoke(IPC_CHANNELS.LOG_CLEAR),
    getDiagnostics: () => invoke(IPC_CHANNELS.APP_GET_DIAGNOSTICS),
    exportDiagnostics: () => invoke(IPC_CHANNELS.APP_EXPORT_DIAGNOSTICS),
    onTaskUpdated: (listener) => {
      tasks.add(listener);
      return () => tasks.delete(listener);
    },
    onLogAdded: (listener) => {
      logs.add(listener);
      return () => logs.delete(listener);
    },
    onWindowMaximizedChanged: (listener) => {
      maximized.add(listener);
      return () => maximized.delete(listener);
    }
  };
  let disposed = false;
  return {
    api,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unlisteners.forEach((f) => f());
      tasks.clear();
      logs.clear();
      maximized.clear();
    }
  };
}

export async function initializeDesktopApi(): Promise<() => void> {
  if (!isTauri()) throw new Error('Tauri desktop runtime unavailable');
  const { api, dispose } = await createDesktopApi();
  window.ossApi = Object.freeze(api);
  return dispose;
}
