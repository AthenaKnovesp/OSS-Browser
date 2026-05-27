import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type OssApi } from '@shared/ipc';
import type {
  AppDiagnostics,
  AppConfig,
  ConnectionConfig,
  CopyRequest,
  DeleteRequest,
  DownloadRequest,
  LogEntry,
  MoveRequest,
  RenameRequest,
  TaskItem,
  UploadRequest
} from '@shared/types';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args);

const api: OssApi = {
  windowMinimize: () => invoke<void>(IPC_CHANNELS.WINDOW_MINIMIZE),
  windowMaximize: () => invoke<void>(IPC_CHANNELS.WINDOW_MAXIMIZE),
  isWindowMaximized: () => invoke<boolean>(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
  windowClose: () => invoke<void>(IPC_CHANNELS.WINDOW_CLOSE),
  selectFiles: () => invoke<string[]>(IPC_CHANNELS.DIALOG_SELECT_FILES),
  selectFolder: () => invoke<string | undefined>(IPC_CHANNELS.DIALOG_SELECT_FOLDER),
  selectUploadFolder: () => invoke<string | undefined>(IPC_CHANNELS.DIALOG_SELECT_UPLOAD_FOLDER),
  getConfig: () => invoke<AppConfig>(IPC_CHANNELS.CONFIG_GET),
  saveConnection: (connection: ConnectionConfig) =>
    invoke<AppConfig>(IPC_CHANNELS.CONFIG_SAVE_CONNECTION, connection),
  deleteConnection: (connectionId: string) =>
    invoke<AppConfig>(IPC_CHANNELS.CONFIG_DELETE_CONNECTION, connectionId),
  setActiveConnection: (connectionId: string) =>
    invoke<AppConfig>(IPC_CHANNELS.CONFIG_SET_ACTIVE_CONNECTION, connectionId),
  saveSettings: (config: Partial<AppConfig>) =>
    invoke<AppConfig>(IPC_CHANNELS.CONFIG_SAVE_SETTINGS, config),
  testConnection: (connection: ConnectionConfig) =>
    invoke(IPC_CHANNELS.S3_TEST_CONNECTION, connection),
  listBuckets: () => invoke(IPC_CHANNELS.S3_LIST_BUCKETS),
  listObjects: (bucket: string, prefix: string, continuationToken?: string, maxKeys?: number) =>
    invoke(IPC_CHANNELS.S3_LIST_OBJECTS, bucket, prefix, continuationToken, maxKeys),
  listObjectsFlat: (bucket: string, prefix: string, continuationToken?: string, maxKeys?: number) =>
    invoke(IPC_CHANNELS.S3_LIST_OBJECTS_FLAT, bucket, prefix, continuationToken, maxKeys),
  listFolders: (bucket: string, prefix: string, continuationToken?: string) =>
    invoke(IPC_CHANNELS.S3_LIST_FOLDERS, bucket, prefix, continuationToken),
  createFolder: (bucket: string, prefix: string) =>
    invoke(IPC_CHANNELS.S3_CREATE_FOLDER, bucket, prefix),
  getObjectMetadata: (bucket: string, key: string) => invoke(IPC_CHANNELS.S3_METADATA, bucket, key),
  generateObjectUrl: (bucket: string, key: string) =>
    invoke(IPC_CHANNELS.S3_GENERATE_URL, bucket, key),
  uploadObjects: (request: UploadRequest) => invoke<TaskItem[]>(IPC_CHANNELS.TASK_UPLOAD, request),
  downloadObject: (request: DownloadRequest) =>
    invoke<TaskItem>(IPC_CHANNELS.TASK_DOWNLOAD, request),
  deleteObject: (request: DeleteRequest) => invoke<TaskItem>(IPC_CHANNELS.TASK_DELETE, request),
  copyObject: (request: CopyRequest) => invoke<TaskItem>(IPC_CHANNELS.TASK_COPY, request),
  moveObject: (request: MoveRequest) => invoke<TaskItem>(IPC_CHANNELS.TASK_MOVE, request),
  renameObject: (request: RenameRequest) => invoke<TaskItem>(IPC_CHANNELS.TASK_RENAME, request),
  listTasks: () => invoke<TaskItem[]>(IPC_CHANNELS.TASK_LIST),
  cancelTask: (taskId: string) => invoke<void>(IPC_CHANNELS.TASK_CANCEL, taskId),
  retryTask: (taskId: string) => invoke<void>(IPC_CHANNELS.TASK_RETRY, taskId),
  clearCompletedTasks: () => invoke<void>(IPC_CHANNELS.TASK_CLEAR_COMPLETED),
  listLogs: () => invoke<LogEntry[]>(IPC_CHANNELS.LOG_LIST),
  clearLogs: () => invoke<void>(IPC_CHANNELS.LOG_CLEAR),
  getDiagnostics: () => invoke<AppDiagnostics>(IPC_CHANNELS.APP_GET_DIAGNOSTICS),
  onTaskUpdated: (listener: (task: TaskItem) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, task: TaskItem): void => listener(task);
    ipcRenderer.on(IPC_CHANNELS.TASK_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_UPDATED, handler);
  },
  onLogAdded: (listener: (log: LogEntry) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, log: LogEntry): void => listener(log);
    ipcRenderer.on(IPC_CHANNELS.LOG_ADDED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LOG_ADDED, handler);
  },
  onWindowMaximizedChanged: (listener: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void =>
      listener(maximized);
    ipcRenderer.on(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, handler);
  }
};

contextBridge.exposeInMainWorld('ossApi', api);
