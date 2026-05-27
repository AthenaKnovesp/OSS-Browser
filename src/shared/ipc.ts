import type {
  AppDiagnostics,
  AppConfig,
  BucketInfo,
  ConnectionConfig,
  CopyRequest,
  DeleteRequest,
  DownloadRequest,
  LogEntry,
  MoveRequest,
  ObjectListResult,
  ObjectMetadata,
  RenameRequest,
  TaskItem,
  TestConnectionResult,
  UploadRequest
} from './types';

export const IPC_CHANNELS = {
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  WINDOW_MAXIMIZED_CHANGED: 'window:maximized-changed',
  WINDOW_CLOSE: 'window:close',
  DIALOG_SELECT_FILES: 'dialog:select-files',
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_SELECT_UPLOAD_FOLDER: 'dialog:select-upload-folder',
  CONFIG_GET: 'config:get',
  CONFIG_SAVE_CONNECTION: 'config:save-connection',
  CONFIG_DELETE_CONNECTION: 'config:delete-connection',
  CONFIG_SET_ACTIVE_CONNECTION: 'config:set-active-connection',
  CONFIG_SAVE_SETTINGS: 'config:save-settings',
  S3_TEST_CONNECTION: 's3:test-connection',
  S3_LIST_BUCKETS: 's3:list-buckets',
  S3_LIST_OBJECTS: 's3:list-objects',
  S3_LIST_OBJECTS_FLAT: 's3:list-objects-flat',
  S3_LIST_FOLDERS: 's3:list-folders',
  S3_CREATE_FOLDER: 's3:create-folder',
  S3_METADATA: 's3:metadata',
  S3_GENERATE_URL: 's3:generate-url',
  TASK_UPLOAD: 'task:upload',
  TASK_DOWNLOAD: 'task:download',
  TASK_DELETE: 'task:delete',
  TASK_COPY: 'task:copy',
  TASK_MOVE: 'task:move',
  TASK_RENAME: 'task:rename',
  TASK_LIST: 'task:list',
  TASK_CANCEL: 'task:cancel',
  TASK_RETRY: 'task:retry',
  TASK_CLEAR_COMPLETED: 'task:clear-completed',
  TASK_UPDATED: 'task:updated',
  LOG_LIST: 'log:list',
  LOG_CLEAR: 'log:clear',
  LOG_ADDED: 'log:added',
  APP_GET_DIAGNOSTICS: 'app:get-diagnostics'
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export interface OssApi {
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;
  windowClose: () => Promise<void>;
  selectFiles: () => Promise<string[]>;
  selectFolder: () => Promise<string | undefined>;
  selectUploadFolder: () => Promise<string | undefined>;
  getConfig: () => Promise<AppConfig>;
  saveConnection: (connection: ConnectionConfig) => Promise<AppConfig>;
  deleteConnection: (connectionId: string) => Promise<AppConfig>;
  setActiveConnection: (connectionId: string) => Promise<AppConfig>;
  saveSettings: (config: Partial<AppConfig>) => Promise<AppConfig>;
  testConnection: (connection: ConnectionConfig) => Promise<TestConnectionResult>;
  listBuckets: () => Promise<BucketInfo[]>;
  listObjects: (
    bucket: string,
    prefix: string,
    continuationToken?: string,
    maxKeys?: number
  ) => Promise<ObjectListResult>;
  listObjectsFlat: (
    bucket: string,
    prefix: string,
    continuationToken?: string,
    maxKeys?: number
  ) => Promise<ObjectListResult>;
  listFolders: (
    bucket: string,
    prefix: string,
    continuationToken?: string
  ) => Promise<ObjectListResult>;
  createFolder: (bucket: string, prefix: string) => Promise<void>;
  getObjectMetadata: (bucket: string, key: string) => Promise<ObjectMetadata>;
  generateObjectUrl: (bucket: string, key: string) => Promise<string>;
  uploadObjects: (request: UploadRequest) => Promise<TaskItem[]>;
  downloadObject: (request: DownloadRequest) => Promise<TaskItem>;
  deleteObject: (request: DeleteRequest) => Promise<TaskItem>;
  copyObject: (request: CopyRequest) => Promise<TaskItem>;
  moveObject: (request: MoveRequest) => Promise<TaskItem>;
  renameObject: (request: RenameRequest) => Promise<TaskItem>;
  listTasks: () => Promise<TaskItem[]>;
  cancelTask: (taskId: string) => Promise<void>;
  retryTask: (taskId: string) => Promise<void>;
  clearCompletedTasks: () => Promise<void>;
  listLogs: () => Promise<LogEntry[]>;
  clearLogs: () => Promise<void>;
  getDiagnostics: () => Promise<AppDiagnostics>;
  onTaskUpdated: (listener: (task: TaskItem) => void) => () => void;
  onLogAdded: (listener: (log: LogEntry) => void) => () => void;
  onWindowMaximizedChanged: (listener: (maximized: boolean) => void) => () => void;
}
