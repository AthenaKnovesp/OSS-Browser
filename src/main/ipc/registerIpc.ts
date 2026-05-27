import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { resolveLanguagePreference, setI18nLanguage, t } from '@shared/i18n';
import type {
  AppDiagnostics,
  AppConfig,
  ConnectionConfig,
  CopyRequest,
  DeleteRequest,
  DownloadRequest,
  MoveRequest,
  RenameRequest,
  TaskItem,
  UploadRequest
} from '@shared/types';
import { sanitizeLogText, type Logger } from '../services/logger';
import type { S3Service } from '../services/s3Service';
import type { TaskManager } from '../services/taskManager';
import type { ConfigStore } from '../store/configStore';
import { AppError, normalizeError } from '../services/error';
import {
  assertBucketName,
  assertS3Key,
  assertS3MoveTarget,
  normalizeS3Prefix
} from '../services/s3Safety';

interface IpcServices {
  window: BrowserWindow;
  configStore: ConfigStore;
  s3Service: S3Service;
  taskManager: TaskManager;
  logger: Logger;
}

export function registerIpc({
  window,
  configStore,
  s3Service,
  taskManager,
  logger
}: IpcServices): void {
  const emitMaximizedState = (): void => {
    window.webContents.send(
      IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED,
      window.isMaximized() || window.isFullScreen()
    );
  };

  window.on('maximize', emitMaximizedState);
  window.on('unmaximize', emitMaximizedState);
  window.on('enter-full-screen', emitMaximizedState);
  window.on('leave-full-screen', emitMaximizedState);

  const runWithTimeout = async <TResult>(
    runner: (signal: AbortSignal) => Promise<TResult>,
    timeoutMs = 30000
  ): Promise<TResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await runner(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  const refreshActiveConnection = async (): Promise<AppConfig> => {
    const config = await configStore.get();
    const active = await configStore.getActiveConnection();
    s3Service.setActiveConnection(active);
    taskManager.setConcurrentTransfers(config.transferSettings.concurrentTransfers);
    return config;
  };

  const syncRuntimeSettings = async (): Promise<AppConfig> => {
    const config = await configStore.get();
    setI18nLanguage(resolveLanguagePreference(config.appearanceSettings.language, app.getLocale()));
    taskManager.setConcurrentTransfers(config.transferSettings.concurrentTransfers);
    return config;
  };

  const refreshActiveTaskConnection = async (): Promise<{
    config: AppConfig;
    connection: ConnectionConfig;
  }> => {
    const config = await refreshActiveConnection();
    const connection = await configStore.getActiveConnection();
    return { config, connection };
  };

  const handle = <TArgs extends unknown[], TResult>(
    channel: string,
    handler: (...args: TArgs) => TResult | Promise<TResult>
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, ...args: TArgs) => {
      try {
        return await handler(...args);
      } catch (error) {
        const normalized = normalizeError(error, t('error.operationFailed'));
        logger.error(normalized.message, normalized.detail, 'IPC');
        throw normalized;
      }
    });
  };

  handle(IPC_CHANNELS.WINDOW_MINIMIZE, () => window.minimize());
  handle(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
    if (window.isFullScreen()) {
      window.setFullScreen(false);
    } else if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });
  handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, () => window.isMaximized() || window.isFullScreen());
  handle(IPC_CHANNELS.WINDOW_CLOSE, () => app.quit());

  handle(IPC_CHANNELS.DIALOG_SELECT_FILES, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: t('main.dialog.selectUploadFiles'),
      properties: ['openFile', 'multiSelections']
    });
    return result.canceled ? [] : result.filePaths;
  });

  handle(IPC_CHANNELS.DIALOG_SELECT_FOLDER, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: t('main.dialog.selectDownloadDirectory'),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  handle(IPC_CHANNELS.DIALOG_SELECT_UPLOAD_FOLDER, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: t('main.dialog.selectUploadFolder'),
      properties: ['openDirectory']
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  handle(IPC_CHANNELS.CONFIG_GET, async () => syncRuntimeSettings());

  handle(IPC_CHANNELS.CONFIG_SAVE_CONNECTION, async (connection: ConnectionConfig) => {
    const safeConnection = assertConnectionConfig(connection);
    const config = await configStore.saveConnection(safeConnection);
    await syncRuntimeSettings();
    logger.success(t('main.connectionSaved', { name: safeConnection.profileName }), undefined, 'Config');
    return config;
  });

  handle(IPC_CHANNELS.CONFIG_DELETE_CONNECTION, async (connectionId: string) => {
    assertNonEmptyString(connectionId, t('main.label.connectionId'));
    const config = await configStore.deleteConnection(connectionId);
    s3Service.clearActiveConnection();
    await syncRuntimeSettings();
    logger.info(t('main.connectionDeleted'), undefined, 'Config');
    return config;
  });

  handle(IPC_CHANNELS.CONFIG_SET_ACTIVE_CONNECTION, async (connectionId: string) => {
    assertNonEmptyString(connectionId, t('main.label.connectionId'));
    const config = await configStore.setActiveConnection(connectionId);
    await refreshActiveConnection();
    logger.info(t('main.activeConnectionChanged'), undefined, 'Config');
    return config;
  });

  handle(IPC_CHANNELS.CONFIG_SAVE_SETTINGS, async (partial: Partial<AppConfig>) => {
    assertPlainObject(partial, t('main.label.settings'));
    const config = await configStore.saveSettings(partial);
    await syncRuntimeSettings();
    logger.success(t('main.settingsSaved'), undefined, 'Config');
    return config;
  });

  handle(IPC_CHANNELS.S3_TEST_CONNECTION, async (connection: ConnectionConfig) =>
    s3Service.testConnection(
      await configStore.mergeWithStoredSecret(assertConnectionConfig(connection))
    )
  );

  handle(IPC_CHANNELS.S3_LIST_BUCKETS, async () => {
    await refreshActiveConnection();
    return runWithTimeout((signal) => s3Service.listBuckets(signal));
  });

  handle(
    IPC_CHANNELS.S3_LIST_OBJECTS,
    async (bucket: string, prefix: string, continuationToken?: string, maxKeys?: number) => {
      await refreshActiveConnection();
      assertBucketName(bucket);
      normalizeS3Prefix(prefix);
      if (continuationToken !== undefined) {
        assertNonEmptyString(continuationToken, 'ContinuationToken');
      }
      const normalizedMaxKeys = assertOptionalListMaxKeys(maxKeys);
      return runWithTimeout((signal) =>
        s3Service.listObjects(bucket, prefix, continuationToken, normalizedMaxKeys, signal)
      );
    }
  );

  handle(
    IPC_CHANNELS.S3_LIST_OBJECTS_FLAT,
    async (bucket: string, prefix: string, continuationToken?: string, maxKeys?: number) => {
      await refreshActiveConnection();
      assertBucketName(bucket);
      normalizeS3Prefix(prefix);
      if (continuationToken !== undefined) {
        assertNonEmptyString(continuationToken, 'ContinuationToken');
      }
      const normalizedMaxKeys = assertOptionalListMaxKeys(maxKeys);
      return runWithTimeout((signal) =>
        s3Service.listObjectsFlat(bucket, prefix, continuationToken, normalizedMaxKeys, signal)
      );
    }
  );

  handle(
    IPC_CHANNELS.S3_LIST_FOLDERS,
    async (bucket: string, prefix: string, continuationToken?: string) => {
      await refreshActiveConnection();
      assertBucketName(bucket);
      normalizeS3Prefix(prefix);
      if (continuationToken !== undefined) {
        assertNonEmptyString(continuationToken, 'ContinuationToken');
      }
      return runWithTimeout((signal) =>
        s3Service.listFolders(bucket, prefix, continuationToken, signal)
      );
    }
  );

  handle(IPC_CHANNELS.S3_CREATE_FOLDER, async (bucket: string, prefix: string) => {
    await refreshActiveConnection();
    assertBucketName(bucket);
    normalizeS3Prefix(prefix);
    await s3Service.createFolder(bucket, prefix);
    logger.success(t('main.folderCreated', { prefix }));
  });

  handle(IPC_CHANNELS.S3_METADATA, async (bucket: string, key: string) => {
    await refreshActiveConnection();
    assertBucketName(bucket);
    assertS3Key(key, { allowTrailingSlash: true });
    return s3Service.getObjectMetadata(bucket, key);
  });

  handle(IPC_CHANNELS.S3_GENERATE_URL, async (bucket: string, key: string) => {
    await refreshActiveConnection();
    assertBucketName(bucket);
    assertS3Key(key);
    return s3Service.generateObjectUrl(bucket, key);
  });

  handle(IPC_CHANNELS.TASK_UPLOAD, async (request: UploadRequest) => {
    assertUploadRequest(request);
    const { config, connection } = await refreshActiveTaskConnection();
    return taskManager.enqueueUpload(
      connection,
      request,
      config.transferSettings.retryCount,
      config.transferSettings.chunkSizeMb,
      config.transferSettings.multipartConcurrency
    );
  });

  handle(IPC_CHANNELS.TASK_DOWNLOAD, async (request: DownloadRequest) => {
    assertDownloadRequest(request);
    const { config, connection } = await refreshActiveTaskConnection();
    return await taskManager.enqueueDownload(
      connection,
      request,
      config.transferSettings.defaultDownloadFolder || app.getPath('downloads'),
      config.transferSettings.retryCount,
      config.transferSettings.chunkSizeMb,
      config.transferSettings.multipartConcurrency,
      config.transferSettings.overwritePolicy
    );
  });

  handle(IPC_CHANNELS.TASK_DELETE, async (request: DeleteRequest) => {
    assertDeleteRequest(request);
    const { config, connection } = await refreshActiveTaskConnection();
    return taskManager.enqueueDelete(connection, request, config.transferSettings.retryCount);
  });

  handle(IPC_CHANNELS.TASK_COPY, async (request: CopyRequest) => {
    assertCopyRequest(request);
    const { config, connection } = await refreshActiveTaskConnection();
    return taskManager.enqueueCopy(
      connection,
      request,
      config.transferSettings.retryCount,
      config.transferSettings.chunkSizeMb,
      config.transferSettings.multipartConcurrency
    );
  });

  handle(IPC_CHANNELS.TASK_MOVE, async (request: MoveRequest) => {
    assertMoveRequest(request);
    const { config, connection } = await refreshActiveTaskConnection();
    return taskManager.enqueueMove(
      connection,
      request,
      config.transferSettings.retryCount,
      config.transferSettings.chunkSizeMb,
      config.transferSettings.multipartConcurrency
    );
  });

  handle(IPC_CHANNELS.TASK_RENAME, async (request: RenameRequest) => {
    assertRenameRequest(request);
    const { config, connection } = await refreshActiveTaskConnection();
    return taskManager.enqueueRename(
      connection,
      request,
      config.transferSettings.retryCount,
      config.transferSettings.chunkSizeMb,
      config.transferSettings.multipartConcurrency
    );
  });

  handle(IPC_CHANNELS.TASK_LIST, () => taskManager.list());
  handle(IPC_CHANNELS.TASK_CANCEL, async (taskId: string) =>
    taskManager.cancel(assertNonEmptyString(taskId, t('main.label.taskId')))
  );
  handle(IPC_CHANNELS.TASK_RETRY, async (taskId: string) =>
    taskManager.retry(assertNonEmptyString(taskId, t('main.label.taskId')))
  );
  handle(IPC_CHANNELS.TASK_CLEAR_COMPLETED, () => taskManager.clearCompleted());

  handle(IPC_CHANNELS.LOG_LIST, () => logger.list());
  handle(IPC_CHANNELS.LOG_CLEAR, async () => logger.clear());

  const getDiagnostics = async (): Promise<AppDiagnostics> => ({
    appName: app.getName(),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    generatedAt: new Date().toISOString(),
    userDataPath: app.getPath('userData'),
    configFilePath: configStore.getConfigFilePath(),
    configSummary: await configStore.get(),
    recentLogs: logger.list().slice(-200),
    failedTasks: taskManager
      .list()
      .filter((task) => ['failed', 'partial_success'].includes(task.status))
      .slice(0, 100)
      .map(sanitizeDiagnosticTask)
  });

  handle(IPC_CHANNELS.APP_GET_DIAGNOSTICS, getDiagnostics);
}

function assertPlainObject<T extends Record<string, unknown>>(value: unknown, label: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(t('main.validation.objectRequired', { label }));
  }
  return value as T;
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(t('main.validation.required', { label }));
  }
  return value.trim();
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new AppError(t('main.validation.stringArrayRequired', { label }));
  }
  return value.map((item) => item.trim());
}

function assertOptionalListMaxKeys(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new AppError(t('main.validation.maxKeys'));
  }
  return value;
}

function assertConnectionConfig(value: unknown): ConnectionConfig {
  const record = assertPlainObject<ConnectionConfig & Record<string, unknown>>(
    value,
    t('main.label.connectionConfig')
  );
  assertNonEmptyString(record.profileName, 'Profile Name');
  assertNonEmptyString(record.endpoint, 'Endpoint');
  assertNonEmptyString(record.region, 'Region');
  assertNonEmptyString(record.accessKeyId, 'Access Key ID');
  if (record.secretAccessKey !== undefined && typeof record.secretAccessKey !== 'string') {
    throw new AppError(t('main.validation.secretString'));
  }
  if (record.sessionToken !== undefined && typeof record.sessionToken !== 'string') {
    throw new AppError(t('main.validation.sessionTokenString'));
  }
  if (typeof record.forcePathStyle !== 'boolean' || typeof record.ssl !== 'boolean') {
    throw new AppError(t('main.validation.connectionBoolean'));
  }
  if (record.defaultBucket !== undefined) {
    if (typeof record.defaultBucket !== 'string') {
      throw new AppError(t('main.validation.defaultBucketString'));
    }
    record.defaultBucket = record.defaultBucket.trim()
      ? assertBucketName(record.defaultBucket)
      : undefined;
  }
  if (
    record.checksumAlgorithm !== undefined &&
    !['disabled', 'CRC32', 'SHA256'].includes(record.checksumAlgorithm)
  ) {
    throw new AppError(t('main.validation.checksumAlgorithm'));
  }
  return record;
}

function assertUploadRequest(value: unknown): UploadRequest {
  const request = assertPlainObject<UploadRequest & Record<string, unknown>>(
    value,
    t('main.label.uploadRequest')
  );
  request.bucket = assertBucketName(request.bucket);
  request.prefix = normalizeS3Prefix(request.prefix);
  request.filePaths = Array.isArray(request.filePaths)
    ? assertStringArray(request.filePaths, t('main.label.uploadFilePaths'))
    : [];
  if (request.directoryPaths !== undefined) {
    request.directoryPaths = assertStringArray(
      request.directoryPaths,
      t('main.label.uploadFolderPaths')
    );
  }
  if (
    request.filePaths.length === 0 &&
    (!request.directoryPaths || request.directoryPaths.length === 0)
  ) {
    throw new AppError(t('main.validation.uploadRequired'));
  }
  if (
    request.preserveEmptyFolders !== undefined &&
    typeof request.preserveEmptyFolders !== 'boolean'
  ) {
    throw new AppError(t('main.validation.preserveEmptyFoldersBoolean'));
  }
  return request;
}

function assertDownloadRequest(value: unknown): DownloadRequest {
  const request = assertPlainObject<DownloadRequest & Record<string, unknown>>(
    value,
    t('main.label.downloadRequest')
  );
  request.bucket = assertBucketName(request.bucket);
  request.key = assertS3Key(request.key);
  if (request.savePath !== undefined && typeof request.savePath !== 'string') {
    throw new AppError(t('main.validation.downloadPathString'));
  }
  if (request.size !== undefined && (typeof request.size !== 'number' || request.size < 0)) {
    throw new AppError(t('main.validation.objectSize'));
  }
  return request;
}

function assertDeleteRequest(value: unknown): DeleteRequest {
  const request = assertPlainObject<DeleteRequest & Record<string, unknown>>(
    value,
    t('main.label.deleteRequest')
  );
  request.bucket = assertBucketName(request.bucket);
  if (request.keys !== undefined) {
    request.keys = assertStringArray(request.keys, t('main.label.deleteKey')).map((key) =>
      assertS3Key(key, { allowTrailingSlash: true })
    );
  }
  if (request.key !== undefined) {
    request.key = assertS3Key(request.key, { allowTrailingSlash: true });
  }
  if (!request.key && (!request.keys || request.keys.length === 0)) {
    throw new AppError(t('main.validation.deleteKeyRequired'));
  }
  return request;
}

function assertCopyRequest(value: unknown): CopyRequest {
  const request = assertPlainObject<CopyRequest & Record<string, unknown>>(
    value,
    t('main.label.copyRequest')
  );
  request.sourceBucket = assertBucketName(request.sourceBucket);
  request.targetBucket = assertBucketName(request.targetBucket);
  request.sourceKey = assertS3Key(request.sourceKey, { allowTrailingSlash: true });
  request.targetKey = assertS3Key(request.targetKey, { allowTrailingSlash: true });
  if (
    request.targetExistsPolicy !== undefined &&
    !['overwrite', 'skip', 'autoRename'].includes(request.targetExistsPolicy)
  ) {
    throw new AppError(t('main.validation.targetExistsPolicy'));
  }
  return request;
}

function assertMoveRequest(value: unknown): MoveRequest {
  const request = assertPlainObject<MoveRequest & Record<string, unknown>>(
    value,
    t('main.label.moveRequest')
  );
  const safeTarget = assertS3MoveTarget(
    request.sourceBucket,
    request.sourceKey,
    request.targetBucket,
    request.targetKey
  );
  request.sourceBucket = safeTarget.sourceBucket;
  request.sourceKey = safeTarget.sourceKey;
  request.targetBucket = safeTarget.targetBucket;
  request.targetKey = safeTarget.targetKey;
  if (
    request.targetExistsPolicy !== undefined &&
    !['overwrite', 'skip', 'autoRename'].includes(request.targetExistsPolicy)
  ) {
    throw new AppError(t('main.validation.targetExistsPolicy'));
  }
  return request;
}

function assertRenameRequest(value: unknown): RenameRequest {
  const request = assertPlainObject<RenameRequest & Record<string, unknown>>(
    value,
    t('main.label.renameRequest')
  );
  const safeTarget = assertS3MoveTarget(
    request.bucket,
    request.oldKey,
    request.bucket,
    request.newKey
  );
  request.bucket = safeTarget.sourceBucket;
  request.oldKey = safeTarget.sourceKey;
  request.newKey = safeTarget.targetKey;
  return request;
}

function sanitizeDiagnosticTask(task: TaskItem): TaskItem {
  return {
    ...task,
    errorMessage: sanitizeLogText(task.errorMessage),
    failure: task.failure
      ? {
          ...task.failure,
          message: sanitizeLogText(task.failure.message) ?? task.failure.message,
          detail: sanitizeLogText(task.failure.detail)
        }
      : undefined,
    report: task.report
      ? {
          ...task.report,
          failedItems: task.report.failedItems.map((item) => ({
            ...item,
            reason: sanitizeLogText(item.reason) ?? item.reason,
            detail: sanitizeLogText(item.detail)
          }))
        }
      : undefined
  };
}
