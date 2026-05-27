import { basename, resolve } from 'node:path';
import { t } from '@shared/i18n';
import type {
  BatchOperationReport,
  ConnectionConfig,
  CopyRequest,
  DeleteRequest,
  DownloadRequest,
  MoveRequest,
  RenameRequest,
  TaskItem,
  TaskStats,
  TaskStatus,
  TaskType,
  TransferSettings,
  UploadRequest
} from '@shared/types';
import {
  AppError,
  buildFailureInfo,
  isRetryableError,
  normalizeError,
  PartialOperationError
} from './error';
import type { Logger } from './logger';
import {
  downloadTargetReservationKey,
  resolveDownloadTarget,
  type DownloadCollisionPolicy
} from './pathSafety';
import {
  assertBucketName,
  assertS3Key,
  assertS3MoveTarget,
  joinS3Key,
  normalizeS3Prefix
} from './s3Safety';
import type {
  OperationResult,
  ProgressHandler,
  S3Service,
  StatsHandler,
  TransferProgressMeta
} from './s3Service';

type TaskRunner = (
  task: TaskItem,
  updateProgress: ProgressHandler,
  updateStats: StatsHandler,
  signal: AbortSignal
) => Promise<OperationResult | void>;

type ObjectTransferTaskType = Extract<TaskType, 'copy' | 'move' | 'rename'>;
type ObjectTransferPolicy = NonNullable<CopyRequest['targetExistsPolicy']>;

interface ObjectTransferTaskInput {
  sourceBucket: string;
  sourceKey: string;
  targetBucket: string;
  targetKey: string;
  targetExistsPolicy?: ObjectTransferPolicy;
}

type ObjectTransferTaskContext = Required<ObjectTransferTaskInput>;

interface InternalTask {
  item: TaskItem;
  runner: TaskRunner;
  abortController: AbortController;
  reservedDownloadTarget?: string;
  reservedUploadTarget?: string;
}

interface TaskReservations {
  reservedDownloadTarget?: string;
  reservedUploadTarget?: string;
}

const TERMINAL_STATUSES: TaskStatus[] = [
  'success',
  'failed',
  'partial_success',
  'canceled',
  'stopped'
];
const PROGRESS_EMIT_INTERVAL_MS = 250;
const SHUTDOWN_WAIT_MS = 3000;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];
const MAX_RETRY_BACKOFF_MS = 10000;

export class TaskManager {
  private tasks = new Map<string, InternalTask>();
  private queue: string[] = [];
  private running = new Set<string>();
  private activeRuns = new Set<Promise<void>>();
  private lastEmitAt = new Map<string, number>();
  private reservedDownloadTargets = new Set<string>();
  private reservedUploadTargets = new Set<string>();
  private emitter?: (task: TaskItem) => void;
  private concurrent = 3;
  private shuttingDown = false;

  constructor(
    private readonly s3: S3Service,
    private readonly logger: Logger
  ) {}

  setEmitter(emitter: (task: TaskItem) => void): void {
    this.emitter = emitter;
  }

  clearEmitter(): void {
    this.emitter = undefined;
  }

  setConcurrentTransfers(value: number): void {
    this.concurrent = Math.max(1, Math.min(16, value));
    void this.process();
  }

  list(): TaskItem[] {
    return [...this.tasks.values()]
      .map((task) => structuredClone(task.item))
      .sort((a, b) => safeText(b.createdAt).localeCompare(safeText(a.createdAt)));
  }

  enqueueUpload(
    connection: ConnectionConfig,
    request: UploadRequest,
    retryCount: number,
    chunkSizeMb: number,
    multipartConcurrency: number
  ): TaskItem[] {
    if (this.shuttingDown) {
      throw new AppError(t('error.appShuttingDown'));
    }

    const bucket = assertBucketName(request.bucket);
    const prefix = normalizeS3Prefix(request.prefix);
    const tasks: TaskItem[] = [];
    const requestUploadTargets = new Set<string>();

    for (const filePath of request.filePaths) {
      const fileName = basename(filePath);
      const key = joinS3Key(prefix, fileName);
      const target = `${bucket}/${key}`;
      const reservationKey = uploadTargetReservationKey(filePath, target);
      if (
        requestUploadTargets.has(reservationKey) ||
        this.reservedUploadTargets.has(reservationKey)
      ) {
        continue;
      }

      requestUploadTargets.add(reservationKey);
      this.reservedUploadTargets.add(reservationKey);
      tasks.push(
        this.enqueue(
          'upload',
          fileName,
          filePath,
          target,
          connection,
          retryCount,
          { total: 1, processed: 0, success: 0, failed: 0, skipped: 0 },
          async (_task, updateProgress, _updateStats, signal) => {
            await this.withConnection(connection, (s3) =>
              s3.uploadObject(
                bucket,
                key,
                filePath,
                chunkSizeMb,
                multipartConcurrency,
                (progress, transferred, total, meta) => {
                  updateProgress(progress, transferred, total, meta);
                },
                signal
              )
            );
          },
          { reservedUploadTarget: reservationKey }
        )
      );
    }

    for (const directoryPath of request.directoryPaths ?? []) {
      const folderName = basename(directoryPath);
      const rootKey = joinS3Key(prefix, folderName);
      const target = `${bucket}/${rootKey}/`;
      const reservationKey = uploadTargetReservationKey(directoryPath, target);
      if (
        requestUploadTargets.has(reservationKey) ||
        this.reservedUploadTargets.has(reservationKey)
      ) {
        continue;
      }

      requestUploadTargets.add(reservationKey);
      this.reservedUploadTargets.add(reservationKey);
      tasks.push(
        this.enqueue(
          'upload',
          folderName,
          directoryPath,
          target,
          connection,
          retryCount,
          { total: 0, processed: 0, success: 0, failed: 0, skipped: 0 },
          async (_task, updateProgress, updateStats, signal) =>
            this.withConnection(connection, (s3) =>
              s3.uploadDirectory(
                bucket,
                prefix,
                directoryPath,
                chunkSizeMb,
                multipartConcurrency,
                request.preserveEmptyFolders ?? true,
                updateProgress,
                updateStats,
                signal
              )
            ),
          { reservedUploadTarget: reservationKey }
        )
      );
    }

    this.logger.operation('taskUpload', 'start', t('task.uploadQueued', { count: tasks.length }), {
      total: tasks.length
    });
    return tasks;
  }

  async enqueueDownload(
    connection: ConnectionConfig,
    request: DownloadRequest,
    defaultFolder: string,
    retryCount: number,
    chunkSizeMb: number,
    multipartConcurrency: number,
    overwritePolicy: TransferSettings['overwritePolicy']
  ): Promise<TaskItem> {
    const bucket = assertBucketName(request.bucket);
    const key = assertS3Key(request.key);
    const collisionPolicy = toDownloadCollisionPolicy(overwritePolicy);
    const target = await this.resolveAndReserveDownloadTarget(
      defaultFolder,
      request.savePath,
      key,
      collisionPolicy
    );
    const task = this.enqueue(
      'download',
      basename(key),
      `${bucket}/${key}`,
      target.filePath,
      connection,
      retryCount,
      { total: 1, processed: 0, success: 0, failed: 0, skipped: 0 },
      async (_task, updateProgress, _updateStats, signal) => {
        if (target.skipped) {
          const stats = { total: 1, processed: 1, success: 0, failed: 0, skipped: 1 };
          this.logger.operation(
            'taskDownload',
            'success',
            t('task.skippedSameName', { path: target.filePath }),
            stats
          );
          return { stats, errors: [], failedItems: [] };
        }

        await this.withConnection(connection, (s3) =>
          s3.downloadObject(
            bucket,
            key,
            target.filePath,
            chunkSizeMb,
            multipartConcurrency,
            (progress, transferred, total, meta) => {
              updateProgress(progress, transferred, total, meta);
            },
            signal
          )
        );
      },
      { reservedDownloadTarget: target.reservationKey }
    );
    this.logger.operation('taskDownload', 'start', t('task.downloadQueued', { target: `${bucket}/${key}` }));
    return task;
  }

  enqueueDelete(
    connection: ConnectionConfig,
    request: DeleteRequest,
    retryCount: number
  ): TaskItem {
    const bucket = assertBucketName(request.bucket);
    const keys = normalizeDeleteKeys(request);
    return this.enqueue(
      'delete',
      keys.length === 1 ? basename(keys[0]) : `${keys.length} objects`,
      keys.length === 1 ? `${bucket}/${keys[0]}` : `${bucket}/${keys.length} objects`,
      '',
      connection,
      retryCount,
      { total: keys.length, processed: 0, success: 0, failed: 0, skipped: 0 },
      async (_task, _updateProgress, updateStats, signal) => {
        if (keys.length === 1 && !keys[0].endsWith('/')) {
          await this.withConnection(connection, (s3) => s3.deleteObject(bucket, keys[0], signal));
          return;
        }

        const result = await this.withConnection(connection, (s3) =>
          s3.deleteObjects(bucket, keys, signal)
        );
        updateStats(result.stats);
        return result;
      }
    );
  }

  enqueueCopy(
    connection: ConnectionConfig,
    request: CopyRequest,
    retryCount: number,
    chunkSizeMb: number,
    multipartConcurrency: number
  ): TaskItem {
    return this.enqueueObjectTransferTask(
      'copy',
      connection,
      retryCount,
      request,
      (s3, task, signal) =>
        s3.copyObject(
          task.sourceBucket,
          task.sourceKey,
          task.targetBucket,
          task.targetKey,
          task.targetExistsPolicy,
          chunkSizeMb,
          multipartConcurrency,
          signal
        )
    );
  }

  enqueueMove(
    connection: ConnectionConfig,
    request: MoveRequest,
    retryCount: number,
    chunkSizeMb: number,
    multipartConcurrency: number
  ): TaskItem {
    const safeTarget = assertS3MoveTarget(
      request.sourceBucket,
      request.sourceKey,
      request.targetBucket,
      request.targetKey
    );
    return this.enqueueObjectTransferTask(
      'move',
      connection,
      retryCount,
      {
        ...request,
        ...safeTarget
      },
      (s3, task, signal) =>
        s3.moveObject(
          task.sourceBucket,
          task.sourceKey,
          task.targetBucket,
          task.targetKey,
          task.targetExistsPolicy,
          chunkSizeMb,
          multipartConcurrency,
          signal
        )
    );
  }

  enqueueRename(
    connection: ConnectionConfig,
    request: RenameRequest,
    retryCount: number,
    chunkSizeMb: number,
    multipartConcurrency: number
  ): TaskItem {
    const safeTarget = assertS3MoveTarget(
      request.bucket,
      request.oldKey,
      request.bucket,
      request.newKey
    );
    return this.enqueueObjectTransferTask(
      'rename',
      connection,
      retryCount,
      {
        sourceBucket: safeTarget.sourceBucket,
        sourceKey: safeTarget.sourceKey,
        targetBucket: safeTarget.targetBucket,
        targetKey: safeTarget.targetKey,
        targetExistsPolicy: 'autoRename'
      },
      (s3, task, signal) =>
        s3.renameObject(
          task.sourceBucket,
          task.sourceKey,
          task.targetKey,
          'autoRename',
          chunkSizeMb,
          multipartConcurrency,
          signal
        )
    );
  }

  private enqueueObjectTransferTask(
    type: ObjectTransferTaskType,
    connection: ConnectionConfig,
    retryCount: number,
    input: ObjectTransferTaskInput,
    runner: (
      s3: S3Service,
      task: ObjectTransferTaskContext,
      signal: AbortSignal
    ) => Promise<OperationResult>
  ): TaskItem {
    const sourceBucket = assertBucketName(input.sourceBucket);
    const targetBucket = assertBucketName(input.targetBucket);
    const sourceKey = assertS3Key(input.sourceKey, { allowTrailingSlash: true });
    const targetKey = assertS3Key(input.targetKey, { allowTrailingSlash: true });
    const taskContext: ObjectTransferTaskContext = {
      sourceBucket,
      sourceKey,
      targetBucket,
      targetKey,
      targetExistsPolicy: input.targetExistsPolicy ?? 'autoRename'
    };

    return this.enqueue(
      type,
      basename(sourceKey.endsWith('/') ? sourceKey.slice(0, -1) : sourceKey),
      `${sourceBucket}/${sourceKey}`,
      `${targetBucket}/${targetKey}`,
      connection,
      retryCount,
      { total: 1, processed: 0, success: 0, failed: 0, skipped: 0 },
      async (_task, _updateProgress, updateStats, signal) => {
        const result = await this.withConnection(connection, (s3) =>
          runner(s3, taskContext, signal)
        );
        updateStats(result.stats);
        return result;
      }
    );
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATUSES.includes(task.item.status)) {
      return;
    }

    task.item.status = 'canceled';
    task.item.completedAt = new Date().toISOString();
    task.item.updatedAt = task.item.completedAt;
    task.item.durationMs = durationMs(task.item);
    task.abortController.abort();
    this.queue = this.queue.filter((id) => id !== taskId);
    if (!this.running.has(taskId)) {
      this.releaseTaskReservations(task);
    }
    this.emit(task.item, true);
    this.logger.operation(
      'task',
      'canceled',
      t('task.canceled', { name: task.item.name }),
      task.item.stats,
      undefined,
      {
        module: 'Task',
        taskId: task.item.id
      }
    );

    if (!this.running.has(taskId)) {
      await this.process();
    }
  }

  async retry(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.item.status !== 'failed') {
      return;
    }

    this.reserveExistingTaskReservations(task);
    const now = new Date().toISOString();
    task.item.status = 'pending';
    task.item.progress = 0;
    task.item.errorMessage = undefined;
    task.item.failure = undefined;
    task.item.report = undefined;
    task.item.partStats = undefined;
    task.item.retries = 0;
    task.item.startedAt = undefined;
    task.item.completedAt = undefined;
    task.item.durationMs = undefined;
    task.item.transferredBytes = undefined;
    task.item.totalBytes = undefined;
    task.item.completedParts = undefined;
    task.item.totalParts = undefined;
    task.item.updatedAt = now;
    task.item.stats = resetStats(task.item.stats);
    task.abortController = new AbortController();
    this.queue.push(taskId);
    this.emit(task.item, true);
    await this.process();
  }

  clearCompleted(): void {
    for (const [id, task] of this.tasks) {
      if (TERMINAL_STATUSES.includes(task.item.status)) {
        this.releaseTaskReservations(task);
        this.tasks.delete(id);
        this.lastEmitAt.delete(id);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    const now = new Date().toISOString();
    for (const taskId of this.queue) {
      const task = this.tasks.get(taskId);
      if (!task) continue;
      task.item.status = 'canceled';
      task.item.updatedAt = now;
      task.item.completedAt = now;
      this.releaseTaskReservations(task);
      this.emit(task.item, true);
    }
    this.queue = [];

    for (const taskId of this.running) {
      const task = this.tasks.get(taskId);
      if (!task) continue;
      task.item.status = 'canceled';
      task.item.updatedAt = now;
      task.item.completedAt = now;
      task.item.durationMs = durationMs(task.item);
      task.abortController.abort();
      this.emit(task.item, true);
    }

    await Promise.race([
      Promise.allSettled([...this.activeRuns]),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS))
    ]);
    this.clearEmitter();
  }

  private enqueue(
    type: TaskType,
    name: string,
    source: string,
    target: string,
    connection: ConnectionConfig,
    maxRetries: number,
    stats: TaskStats,
    runner: TaskRunner,
    reservations: TaskReservations = {}
  ): TaskItem {
    if (this.shuttingDown) {
      throw new AppError(t('error.appShuttingDown'));
    }

    const now = new Date().toISOString();
    const task: TaskItem = {
      id: crypto.randomUUID(),
      connectionId: connection.id,
      connectionName: connection.profileName,
      type,
      name,
      source,
      target,
      progress: 0,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      retries: 0,
      maxRetries,
      stats
    };

    this.tasks.set(task.id, {
      item: task,
      runner,
      abortController: new AbortController(),
      ...reservations
    });
    this.queue.push(task.id);
    this.emit(task, true);
    void this.process();
    return structuredClone(task);
  }

  private async process(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    while (this.running.size < this.concurrent && this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      const internal = this.tasks.get(taskId);
      if (!internal || internal.item.status !== 'pending') {
        continue;
      }
      const runPromise = this.run(internal);
      this.activeRuns.add(runPromise);
      runPromise.finally(() => this.activeRuns.delete(runPromise));
    }
  }

  private async run(internal: InternalTask): Promise<void> {
    const task = internal.item;
    this.running.add(task.id);
    const startedAt = new Date().toISOString();
    task.status = 'running';
    task.startedAt = startedAt;
    task.updatedAt = startedAt;
    this.emit(task, true);
    this.logger.operation('task', 'start', t('task.start', { name: task.name }), task.stats, undefined, {
      module: 'Task',
      taskId: task.id
    });

    try {
      const result = await internal.runner(
        task,
        (progress, transferred, total, meta) => {
          if (task.status !== 'running') {
            return;
          }
          task.progress = Math.max(task.progress, Math.max(0, Math.min(100, progress)));
          this.updateTransferProgress(task, transferred, total, meta);
          task.speed = this.calculateSpeed(task, transferred, total);
          task.updatedAt = new Date().toISOString();
          this.emit(task);
        },
        (stats) => {
          task.stats = { ...stats };
          task.updatedAt = new Date().toISOString();
          this.emit(task);
        },
        internal.abortController.signal
      );

      if (!this.isCanceled(task)) {
        this.completeFromResult(task, result);
      }
    } catch (error) {
      this.failTask(task, error, internal);
    } finally {
      this.running.delete(task.id);
      if (TERMINAL_STATUSES.includes(task.status)) {
        this.releaseTaskReservations(internal);
      }
      void this.process();
    }
  }

  private completeFromResult(task: TaskItem, result?: OperationResult | void): void {
    if (result?.stats) {
      task.stats = result.stats;
      if (result.errors.length > 0) {
        task.errorMessage = result.errors.slice(0, 5).join('\n');
      }
      task.report = buildBatchReport(result);
      if (result.failedItems.length > 0) {
        const firstFailedItem = result.failedItems[0];
        task.failure = {
          category: firstFailedItem.category,
          message: firstFailedItem.reason,
          detail: firstFailedItem.detail,
          retryable: false,
          occurredAt: new Date().toISOString()
        };
      } else {
        task.failure = undefined;
      }
    } else if (task.stats) {
      task.stats = {
        ...task.stats,
        processed: task.stats.total || 1,
        success: task.stats.total || 1
      };
      task.report = buildReportFromStats(task.stats);
      task.failure = undefined;
    }

    const failed = task.stats?.failed ?? 0;
    const successful = (task.stats?.success ?? 0) + (task.stats?.skipped ?? 0);
    task.status =
      failed > 0 && successful > 0 ? 'partial_success' : failed > 0 ? 'failed' : 'success';
    task.progress = 100;
    if (task.status === 'success' && task.totalBytes !== undefined) {
      task.transferredBytes = task.totalBytes;
    }
    if (task.status === 'success' && task.totalParts !== undefined) {
      task.completedParts = task.totalParts;
    }
    task.completedAt = new Date().toISOString();
    task.updatedAt = task.completedAt;
    task.durationMs = durationMs(task);
    const operationStatus =
      task.status === 'partial_success'
        ? 'partial_success'
        : task.status === 'failed'
          ? 'failed'
          : 'success';
    this.logger.operation(
      'task',
      operationStatus,
      t('task.finish', { name: task.name }),
      task.stats,
      task.errorMessage,
      {
        module: 'Task',
        taskId: task.id
      }
    );
    this.emit(task, true);
  }

  private failTask(task: TaskItem, error: unknown, internal: InternalTask): void {
    const normalized = normalizeError(error);
    const retryAfterMs = retryDelayMs(task.retries);
    const retryable = isRetryableError(error);
    task.failure = buildFailureInfo(error, retryable, retryable ? retryAfterMs : undefined);
    task.errorMessage = normalized.message;
    task.updatedAt = new Date().toISOString();

    if (this.isCanceled(task) || internal.abortController.signal.aborted) {
      task.status = 'canceled';
      task.failure = buildFailureInfo(error, false);
      task.completedAt = task.updatedAt;
      task.durationMs = durationMs(task);
      this.emit(task, true);
      return;
    }

    if (error instanceof PartialOperationError) {
      task.status = 'partial_success';
      task.completedAt = task.updatedAt;
      task.durationMs = durationMs(task);
      this.logger.operation(
        'task',
        'partial_success',
        t('task.partialSuccess', { name: task.name }),
        task.stats,
        normalized.detail,
        { module: 'Task', taskId: task.id }
      );
      this.emit(task, true);
      return;
    }

    task.retries += 1;
    if (retryable && task.retries <= task.maxRetries) {
      task.status = 'pending';
      internal.abortController = new AbortController();
      this.logger.warn(
        t('task.retryLater', { seconds: retryAfterMs / 1000, name: task.name }),
        normalized.detail,
        'Task'
      );
      setTimeout(() => {
        const current = this.tasks.get(task.id);
        if (!current || current.item.status !== 'pending' || this.shuttingDown) {
          return;
        }
        this.queue.push(task.id);
        this.emit(current.item, true);
        void this.process();
      }, retryAfterMs);
    } else {
      task.status = 'failed';
      task.completedAt = task.updatedAt;
      task.durationMs = durationMs(task);
      this.logger.operation(
        'task',
        'failed',
        t('task.failed', { name: task.name }),
        task.stats,
        normalized.detail ?? normalized.message,
        { module: 'Task', taskId: task.id }
      );
    }

    this.emit(task, true);
  }

  private emit(task: TaskItem, force = false): void {
    const now = Date.now();
    const last = this.lastEmitAt.get(task.id) ?? 0;
    if (!force && now - last < PROGRESS_EMIT_INTERVAL_MS) {
      return;
    }
    this.lastEmitAt.set(task.id, now);
    this.emitter?.(structuredClone(task));
  }

  private updateTransferProgress(
    task: TaskItem,
    transferred?: number,
    total?: number,
    meta?: TransferProgressMeta
  ): void {
    if (transferred !== undefined && Number.isFinite(transferred)) {
      task.transferredBytes = Math.max(
        task.transferredBytes ?? 0,
        Math.max(0, Math.round(transferred))
      );
    }
    if (total !== undefined && Number.isFinite(total)) {
      task.totalBytes = Math.max(task.totalBytes ?? 0, Math.max(0, Math.round(total)));
    }
    if (meta?.completedParts !== undefined && Number.isFinite(meta.completedParts)) {
      task.completedParts = Math.max(
        task.completedParts ?? 0,
        Math.max(0, Math.round(meta.completedParts))
      );
    }
    if (meta?.totalParts !== undefined && Number.isFinite(meta.totalParts)) {
      task.totalParts = Math.max(task.totalParts ?? 0, Math.max(0, Math.round(meta.totalParts)));
    }
    if (task.completedParts !== undefined || task.totalParts !== undefined) {
      const remainingBytes =
        task.totalBytes !== undefined && task.transferredBytes !== undefined
          ? Math.max(0, task.totalBytes - task.transferredBytes)
          : undefined;
      task.partStats = {
        totalParts: task.totalParts,
        completedParts: task.completedParts,
        failedParts: task.failure ? 1 : 0,
        retriedParts: task.retries,
        activeParts: this.activePartCount(task, meta),
        averageSpeed: task.speed,
        estimatedSecondsRemaining:
          task.speed && remainingBytes !== undefined
            ? Math.ceil(remainingBytes / task.speed)
            : undefined
      };
    }
  }

  private activePartCount(task: TaskItem, meta?: TransferProgressMeta): number {
    if (meta?.activeParts !== undefined && Number.isFinite(meta.activeParts)) {
      return Math.max(0, Math.round(meta.activeParts));
    }
    if (
      task.status !== 'running' ||
      task.totalParts === undefined ||
      task.completedParts === task.totalParts
    ) {
      return 0;
    }
    return Math.max(1, Math.min(4, task.totalParts - (task.completedParts ?? 0)));
  }

  private async withConnection<T>(
    connection: ConnectionConfig,
    runner: (s3: S3Service) => Promise<T>
  ): Promise<T> {
    const scopedS3 = this.s3.forConnection(connection);
    try {
      return await runner(scopedS3);
    } finally {
      scopedS3.clearActiveConnection();
    }
  }

  private isCanceled(task: TaskItem): boolean {
    return task.status === 'canceled';
  }

  private calculateSpeed(task: TaskItem, transferred?: number, total?: number): number | undefined {
    if (!transferred || !total) {
      return undefined;
    }
    const baseTime = task.startedAt ?? task.createdAt;
    const seconds = Math.max(1, (Date.now() - new Date(baseTime).getTime()) / 1000);
    return Math.round(transferred / seconds);
  }

  private async resolveAndReserveDownloadTarget(
    defaultFolder: string,
    savePath: string | undefined,
    key: string,
    collisionPolicy: DownloadCollisionPolicy
  ): Promise<DownloadTargetResolutionWithReservation> {
    for (let attempt = 0; attempt < 10000; attempt += 1) {
      const target = await resolveDownloadTarget(defaultFolder, savePath, key, collisionPolicy, {
        reservedTargets: this.reservedDownloadTargets
      });
      if (target.skipped) {
        return target;
      }

      const reservationKey = downloadTargetReservationKey(target.filePath);
      if (!this.reservedDownloadTargets.has(reservationKey)) {
        this.reservedDownloadTargets.add(reservationKey);
        return { ...target, reservationKey };
      }

      if (collisionPolicy === 'overwrite') {
        throw new AppError(t('error.downloadTargetReserved'));
      }
    }

    throw new AppError(t('error.downloadPathUnavailable'));
  }

  private reserveExistingTaskReservations(task: InternalTask): void {
    this.reserveExistingDownloadTarget(task);
    this.reserveExistingUploadTarget(task);
  }

  private reserveExistingDownloadTarget(task: InternalTask): void {
    if (task.item.type !== 'download') {
      return;
    }

    const reservationKey = downloadTargetReservationKey(task.item.target);
    if (this.reservedDownloadTargets.has(reservationKey)) {
      throw new AppError(t('error.downloadTargetReserved'));
    }

    this.reservedDownloadTargets.add(reservationKey);
    task.reservedDownloadTarget = reservationKey;
  }

  private reserveExistingUploadTarget(task: InternalTask): void {
    if (task.item.type !== 'upload') {
      return;
    }

    const reservationKey = uploadTargetReservationKey(task.item.source, task.item.target);
    if (this.reservedUploadTargets.has(reservationKey)) {
      throw new AppError(t('error.duplicateUploadTask'));
    }

    this.reservedUploadTargets.add(reservationKey);
    task.reservedUploadTarget = reservationKey;
  }

  private releaseTaskReservations(task: InternalTask): void {
    this.releaseDownloadTarget(task);
    this.releaseUploadTarget(task);
  }

  private releaseDownloadTarget(task: InternalTask): void {
    if (!task.reservedDownloadTarget) {
      return;
    }

    this.reservedDownloadTargets.delete(task.reservedDownloadTarget);
    task.reservedDownloadTarget = undefined;
  }

  private releaseUploadTarget(task: InternalTask): void {
    if (!task.reservedUploadTarget) {
      return;
    }

    this.reservedUploadTargets.delete(task.reservedUploadTarget);
    task.reservedUploadTarget = undefined;
  }
}

type DownloadTargetResolutionWithReservation = Awaited<
  ReturnType<typeof resolveDownloadTarget>
> & {
  reservationKey?: string;
};

function normalizeDeleteKeys(request: DeleteRequest): string[] {
  const keys = request.keys?.length ? request.keys : request.key ? [request.key] : [];
  if (keys.length === 0) {
    throw new AppError(t('main.validation.deleteKeyRequired'));
  }
  return [...new Set(keys.map((key) => assertS3Key(key, { allowTrailingSlash: true })))];
}

function durationMs(task: TaskItem): number | undefined {
  if (!task.startedAt) {
    return undefined;
  }
  return Math.max(0, Date.now() - new Date(task.startedAt).getTime());
}

function resetStats(stats?: TaskStats): TaskStats | undefined {
  if (!stats) {
    return undefined;
  }
  return {
    total: stats.total,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0
  };
}

function buildBatchReport(result: OperationResult): BatchOperationReport {
  return {
    total: result.stats.total,
    success: result.stats.success,
    failed: result.stats.failed,
    skipped: result.stats.skipped,
    failedItems: result.failedItems
  };
}

function buildReportFromStats(stats: TaskStats): BatchOperationReport {
  return {
    total: stats.total,
    success: stats.success,
    failed: stats.failed,
    skipped: stats.skipped,
    failedItems: []
  };
}

function retryDelayMs(retries: number): number {
  return Math.min(
    RETRY_BACKOFF_MS[retries] ?? RETRY_BACKOFF_MS.at(-1) ?? 4000,
    MAX_RETRY_BACKOFF_MS
  );
}

function toDownloadCollisionPolicy(
  policy: TransferSettings['overwritePolicy']
): DownloadCollisionPolicy {
  if (policy === 'overwrite') {
    return 'overwrite';
  }
  if (policy === 'skip') {
    return 'skip';
  }
  return 'autoRename';
}

function uploadTargetReservationKey(sourcePath: string, target: string): string {
  return `${normalizeLocalPathForReservation(sourcePath)}\n${target}`;
}

function normalizeLocalPathForReservation(filePath: string): string {
  const normalized = resolve(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function safeText(value: string | undefined): string {
  return value ?? '';
}
