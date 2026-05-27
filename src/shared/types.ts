export interface ConnectionConfig {
  id: string;
  profileName: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey?: string;
  sessionToken?: string;
  hasSecretAccessKey?: boolean;
  forcePathStyle: boolean;
  ssl: boolean;
  defaultBucket?: string;
  checksumAlgorithm?: 'CRC32' | 'SHA256' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface TransferSettings {
  defaultDownloadFolder: string;
  concurrentTransfers: number;
  multipartConcurrency: number;
  chunkSizeMb: number;
  retryCount: number;
  overwritePolicy: 'ask' | 'overwrite' | 'skip';
}

export interface SecuritySettings {
  rememberCredentialsLocally: boolean;
  requireConfirmationBeforeDelete: boolean;
}

export type AppLanguagePreference = 'system' | 'zh-CN' | 'en-US';
export type AppResolvedLanguage = Exclude<AppLanguagePreference, 'system'>;

export interface AppearanceSettings {
  language: AppLanguagePreference;
  disableHardwareAcceleration: boolean;
  disableGpuShaderDiskCache: boolean;
}

export interface AppConfig {
  connections: ConnectionConfig[];
  activeConnectionId?: string;
  compactMode: boolean;
  transferSettings: TransferSettings;
  securitySettings: SecuritySettings;
  appearanceSettings: AppearanceSettings;
}

export interface BucketInfo {
  name: string;
  creationDate?: string;
}

export interface ObjectItem {
  key: string;
  name: string;
  bucket: string;
  prefix: string;
  size?: number;
  type: string;
  storageClass?: string;
  lastModified?: string;
  isFolder: boolean;
  url?: string;
}

export interface ObjectListResult {
  objects: ObjectItem[];
  nextContinuationToken?: string;
  isTruncated: boolean;
}

export interface ObjectMetadata {
  contentType?: string;
  contentLength?: number;
  lastModified?: string;
  storageClass?: string;
  etag?: string;
  metadata: Record<string, string>;
}

export type TaskType = 'upload' | 'download' | 'delete' | 'copy' | 'move' | 'rename';
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'success'
  | 'failed'
  | 'partial_success'
  | 'canceled';

export interface TaskStats {
  total: number;
  processed: number;
  success: number;
  failed: number;
  skipped: number;
}

export type TaskFailureCategory =
  | 'network'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'path_safety'
  | 's3_compatibility'
  | 'user_canceled'
  | 'unknown';

export interface TaskFailureInfo {
  category: TaskFailureCategory;
  message: string;
  detail?: string;
  retryable: boolean;
  retryAfterMs?: number;
  occurredAt: string;
}

export interface BatchOperationFailedItem {
  key: string;
  reason: string;
  category: TaskFailureCategory;
  detail?: string;
}

export interface BatchOperationReport {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  failedItems: BatchOperationFailedItem[];
}

export interface TaskPartStats {
  totalParts?: number;
  completedParts?: number;
  failedParts?: number;
  retriedParts?: number;
  activeParts?: number;
  averageSpeed?: number;
  estimatedSecondsRemaining?: number;
}

export interface TaskItem {
  id: string;
  connectionId?: string;
  connectionName?: string;
  type: TaskType;
  name: string;
  source: string;
  target: string;
  progress: number;
  status: TaskStatus;
  speed?: number;
  transferredBytes?: number;
  totalBytes?: number;
  completedParts?: number;
  totalParts?: number;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  errorMessage?: string;
  retries: number;
  maxRetries: number;
  stats?: TaskStats;
  failure?: TaskFailureInfo;
  report?: BatchOperationReport;
  partStats?: TaskPartStats;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'success';
export type S3OperationStatus = 'start' | 'success' | 'failed' | 'partial_success' | 'canceled';
export type LogModule = 'S3' | 'Task' | 'Config' | 'IPC' | 'Renderer';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  detail?: string;
  operation?: string;
  operationStatus?: S3OperationStatus;
  stats?: Partial<TaskStats>;
  module?: LogModule;
  taskId?: string;
  bucket?: string;
  keySummary?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  buckets?: BucketInfo[];
  message: string;
}

export interface UploadRequest {
  bucket: string;
  prefix: string;
  filePaths: string[];
  directoryPaths?: string[];
  preserveEmptyFolders?: boolean;
}

export interface DownloadRequest {
  bucket: string;
  key: string;
  savePath?: string;
  size?: number;
}

export interface DeleteRequest {
  bucket: string;
  key?: string;
  keys?: string[];
}

export interface CopyRequest {
  sourceBucket: string;
  sourceKey: string;
  targetBucket: string;
  targetKey: string;
  targetExistsPolicy?: 'overwrite' | 'skip' | 'autoRename';
}

export type MoveRequest = CopyRequest;

export interface RenameRequest {
  bucket: string;
  oldKey: string;
  newKey: string;
}

export interface AppDiagnostics {
  appName: string;
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  generatedAt: string;
  userDataPath: string;
  configFilePath: string;
  configSummary: AppConfig;
  recentLogs: LogEntry[];
  failedTasks: TaskItem[];
}
