import {
  AbortMultipartUploadCommand,
  ChecksumAlgorithm,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCopyCommand,
  type HeadObjectCommandOutput
} from '@aws-sdk/client-s3';
import { Upload, type Progress as UploadProgress } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { lookup } from 'mime-types';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { t } from '@shared/i18n';
import type {
  BatchOperationFailedItem,
  BucketInfo,
  ConnectionConfig,
  ObjectItem,
  ObjectListResult,
  ObjectMetadata,
  TaskStats,
  TestConnectionResult
} from '@shared/types';
import { scanDirectory } from './directoryScanner';
import { AppError, classifyError, normalizeError } from './error';
import type { Logger } from './logger';
import { createS3Client, s3ClientKey } from './s3ClientFactory';
import {
  assertFileSize,
  chunk,
  createByteRanges,
  createProgressTransform,
  createStats,
  isAbortLike,
  partCountFor,
  removeTempFile,
  runWithConcurrency,
  tempDownloadPath,
  throwIfAborted,
  uniqueKeys,
  writeRange
} from './s3TransferUtils';
import {
  assertBucketName,
  assertS3Key,
  assertS3MoveTarget,
  encodeCopySource,
  joinS3Key,
  normalizeS3Prefix,
  relativePathToS3Key,
  replaceKeyPrefix
} from './s3Safety';

export interface TransferProgressMeta {
  completedParts?: number;
  totalParts?: number;
  activeParts?: number;
}

export type ProgressHandler = (
  progress: number,
  transferred?: number,
  total?: number,
  meta?: TransferProgressMeta
) => void;
export type StatsHandler = (stats: TaskStats) => void;
export type TargetExistsPolicy = 'overwrite' | 'skip' | 'autoRename';

export interface OperationResult {
  stats: TaskStats;
  targetKey?: string;
  errors: string[];
  failedItems: BatchOperationFailedItem[];
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MIN_PART_SIZE = 5 * MIB;
const MAX_PART_SIZE = 5 * GIB;
const MAX_MULTIPART_PARTS = 10000;
const DEFAULT_PART_SIZE_MB = 16;
const DEFAULT_QUEUE_SIZE = 4;
const DEFAULT_MULTIPART_CONCURRENCY = 4;
const MAX_MULTIPART_CONCURRENCY = 16;
const MULTIPART_TRANSFER_THRESHOLD = 100 * MIB;
const SINGLE_COPY_LIMIT = 5 * GIB;
const DELETE_OBJECTS_BATCH_SIZE = 1000;
export class S3Service {
  private activeConnection?: ConnectionConfig;
  private activeClient?: S3Client;
  private activeClientKey?: string;

  constructor(private readonly logger: Logger) {}

  forConnection(connection: ConnectionConfig): S3Service {
    const service = new S3Service(this.logger);
    service.setActiveConnection(structuredClone(connection));
    return service;
  }

  setActiveConnection(connection: ConnectionConfig): void {
    const nextClientKey = s3ClientKey(connection);
    if (this.activeClientKey !== nextClientKey) {
      this.activeClient?.destroy();
      this.activeClient = undefined;
      this.activeClientKey = nextClientKey;
    }
    this.activeConnection = connection;
  }

  clearActiveConnection(): void {
    this.activeClient?.destroy();
    this.activeClient = undefined;
    this.activeClientKey = undefined;
    this.activeConnection = undefined;
  }

  shutdown(): void {
    this.clearActiveConnection();
  }

  async testConnection(config: ConnectionConfig): Promise<TestConnectionResult> {
    const client = createS3Client(config);
    const defaultBucket = config.defaultBucket?.trim();
    try {
      this.logger.operation('testConnection', 'start', t('s3.testStart', { name: config.profileName }));
      if (defaultBucket) {
        const bucket = assertBucketName(defaultBucket);
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        this.logger.operation(
          'testConnection',
          'success',
          t('s3.testSuccessWithBucket', { name: config.profileName, bucket })
        );
        return {
          ok: true,
          buckets: [{ name: bucket }],
          message: t('s3.testBucketAccessible', { bucket })
        };
      }

      const output = await client.send(new ListBucketsCommand({}));
      const buckets = (output.Buckets ?? []).map((bucket) => ({
        name: bucket.Name ?? '',
        creationDate: bucket.CreationDate?.toISOString()
      }));
      this.logger.operation('testConnection', 'success', t('s3.testSuccess'));
      return { ok: true, buckets, message: t('s3.testSuccess') };
    } catch (error) {
      const normalized = normalizeError(error, t('error.connectionTestFailed'));
      this.logger.operation(
        'testConnection',
        'failed',
        normalized.message,
        undefined,
        normalized.detail
      );
      return {
        ok: false,
        message: defaultBucket
          ? normalized.message
          : t('s3.defaultBucketHint', { message: normalized.message })
      };
    } finally {
      client.destroy();
    }
  }

  async listBuckets(signal?: AbortSignal): Promise<BucketInfo[]> {
    try {
      this.logger.operation('listBuckets', 'start', t('s3.listBucketsStart'));
      const output = await this.client().send(new ListBucketsCommand({}), { abortSignal: signal });
      const buckets = (output.Buckets ?? [])
        .filter((bucket) => bucket.Name)
        .map((bucket) => ({
          name: bucket.Name!,
          creationDate: bucket.CreationDate?.toISOString()
        }));
      this.logger.operation('listBuckets', 'success', t('s3.listBucketsSuccess', { count: buckets.length }));
      return buckets;
    } catch (error) {
      this.logFailedOrCanceled('listBuckets', error, t('s3.listBucketsFailed'));
      throw normalizeError(error, t('s3.listBucketsFailed'));
    }
  }

  async listObjects(
    bucket: string,
    prefix: string,
    continuationToken?: string,
    maxKeys = 1000,
    signal?: AbortSignal
  ): Promise<ObjectListResult> {
    const safeBucket = assertBucketName(bucket);
    const normalizedPrefix = normalizeS3Prefix(prefix);
    try {
      this.logger.operation(
        'listObjects',
        'start',
        t('s3.listObjectsStart', { target: `${safeBucket}/${normalizedPrefix}` })
      );
      const folders = new Map<string, ObjectItem>();
      const files = new Map<string, ObjectItem>();

      const output = await this.client().send(
        new ListObjectsV2Command({
          Bucket: safeBucket,
          Prefix: normalizedPrefix,
          Delimiter: '/',
          MaxKeys: maxKeys,
          ContinuationToken: continuationToken
        }),
        { abortSignal: signal }
      );

      for (const item of output.CommonPrefixes ?? []) {
        if (!item.Prefix || folders.has(item.Prefix)) {
          continue;
        }
        assertS3Key(item.Prefix, { allowTrailingSlash: true });
        folders.set(item.Prefix, {
          key: item.Prefix,
          name: this.nameFromKey(item.Prefix, normalizedPrefix),
          bucket: safeBucket,
          prefix: normalizedPrefix,
          type: 'Folder',
          storageClass: undefined,
          isFolder: true
        });
      }

      for (const item of output.Contents ?? []) {
        if (!item.Key || item.Key === normalizedPrefix || files.has(item.Key)) {
          continue;
        }
        assertS3Key(item.Key, { allowTrailingSlash: item.Key.endsWith('/') });
        files.set(item.Key, {
          key: item.Key,
          name: this.nameFromKey(item.Key, normalizedPrefix),
          bucket: safeBucket,
          prefix: normalizedPrefix,
          size: item.Size,
          type: item.Key.endsWith('/') ? 'Folder' : lookup(item.Key) || 'application/octet-stream',
          storageClass: item.StorageClass || 'Standard',
          lastModified: item.LastModified?.toISOString(),
          isFolder: item.Key.endsWith('/')
        });
      }

      const objects = [...folders.values(), ...files.values()].sort(
        (a, b) =>
          Number(b.isFolder) - Number(a.isFolder) || objectName(a).localeCompare(objectName(b))
      );
      this.logger.operation(
        'listObjects',
        'success',
        t('s3.listObjectsSuccess', { target: `${safeBucket}/${normalizedPrefix}` })
      );
      return {
        objects,
        nextContinuationToken: output.NextContinuationToken,
        isTruncated: Boolean(output.IsTruncated && output.NextContinuationToken)
      };
    } catch (error) {
      this.logFailedOrCanceled('listObjects', error, t('s3.listObjectsFailed'));
      throw normalizeError(error, t('s3.listObjectsFailed'));
    }
  }

  async listObjectsFlat(
    bucket: string,
    prefix: string,
    continuationToken?: string,
    maxKeys = 1000,
    signal?: AbortSignal
  ): Promise<ObjectListResult> {
    const safeBucket = assertBucketName(bucket);
    const normalizedPrefix = normalizeS3Prefix(prefix);
    try {
      this.logger.operation(
        'listObjects',
        'start',
        t('s3.listObjectsFlatStart', { target: `${safeBucket}/${normalizedPrefix}` })
      );
      const output = await this.client().send(
        new ListObjectsV2Command({
          Bucket: safeBucket,
          Prefix: normalizedPrefix,
          MaxKeys: maxKeys,
          ContinuationToken: continuationToken
        }),
        { abortSignal: signal }
      );

      const objects: ObjectItem[] = [];
      for (const item of output.Contents ?? []) {
        if (!item.Key) {
          continue;
        }
        assertS3Key(item.Key, { allowTrailingSlash: item.Key.endsWith('/') });
        objects.push({
          key: item.Key,
          name: this.nameFromKey(item.Key, normalizedPrefix),
          bucket: safeBucket,
          prefix: normalizedPrefix,
          size: item.Size,
          type: item.Key.endsWith('/') ? 'Folder' : lookup(item.Key) || 'application/octet-stream',
          storageClass: item.StorageClass || 'Standard',
          lastModified: item.LastModified?.toISOString(),
          isFolder: item.Key.endsWith('/')
        });
      }

      this.logger.operation(
        'listObjects',
        'success',
        t('s3.listObjectsFlatSuccess', { target: `${safeBucket}/${normalizedPrefix}` })
      );
      return {
        objects,
        nextContinuationToken: output.NextContinuationToken,
        isTruncated: Boolean(output.IsTruncated && output.NextContinuationToken)
      };
    } catch (error) {
      this.logFailedOrCanceled('listObjects', error, t('s3.listObjectsFailed'));
      throw normalizeError(error, t('s3.listObjectsFailed'));
    }
  }

  async listFolders(
    bucket: string,
    prefix: string,
    continuationToken?: string,
    signal?: AbortSignal
  ): Promise<ObjectListResult> {
    const safeBucket = assertBucketName(bucket);
    const normalizedPrefix = normalizeS3Prefix(prefix);
    try {
      this.logger.operation(
        'listFolders',
        'start',
        t('s3.listFoldersStart', { target: `${safeBucket}/${normalizedPrefix}` })
      );
      const folders = new Map<string, ObjectItem>();

      const output = await this.client().send(
        new ListObjectsV2Command({
          Bucket: safeBucket,
          Prefix: normalizedPrefix,
          Delimiter: '/',
          MaxKeys: 1000,
          ContinuationToken: continuationToken
        }),
        { abortSignal: signal }
      );

      for (const item of output.CommonPrefixes ?? []) {
        if (!item.Prefix || folders.has(item.Prefix)) {
          continue;
        }
        assertS3Key(item.Prefix, { allowTrailingSlash: true });
        folders.set(item.Prefix, {
          key: item.Prefix,
          name: this.nameFromKey(item.Prefix, normalizedPrefix),
          bucket: safeBucket,
          prefix: normalizedPrefix,
          type: 'Folder',
          storageClass: undefined,
          isFolder: true
        });
      }

      for (const item of output.Contents ?? []) {
        if (
          !item.Key ||
          item.Key === normalizedPrefix ||
          !item.Key.endsWith('/') ||
          folders.has(item.Key)
        ) {
          continue;
        }
        assertS3Key(item.Key, { allowTrailingSlash: true });
        folders.set(item.Key, {
          key: item.Key,
          name: this.nameFromKey(item.Key, normalizedPrefix),
          bucket: safeBucket,
          prefix: normalizedPrefix,
          size: item.Size,
          type: 'Folder',
          storageClass: item.StorageClass || 'Standard',
          lastModified: item.LastModified?.toISOString(),
          isFolder: true
        });
      }

      const objects = [...folders.values()].sort((a, b) =>
        objectName(a).localeCompare(objectName(b))
      );
      this.logger.operation(
        'listFolders',
        'success',
        t('s3.listFoldersSuccess', { target: `${safeBucket}/${normalizedPrefix}` })
      );
      return {
        objects,
        nextContinuationToken: output.NextContinuationToken,
        isTruncated: Boolean(output.IsTruncated && output.NextContinuationToken)
      };
    } catch (error) {
      this.logFailedOrCanceled('listFolders', error, t('s3.listFoldersFailed'));
      throw normalizeError(error, t('s3.listFoldersFailed'));
    }
  }

  async uploadObject(
    bucket: string,
    key: string,
    filePath: string,
    partSizeMb: number,
    multipartConcurrency = DEFAULT_MULTIPART_CONCURRENCY,
    onProgress?: ProgressHandler,
    signal?: AbortSignal
  ): Promise<void> {
    const safeBucket = assertBucketName(bucket);
    const safeKey = assertS3Key(key);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new AppError(t('error.uploadFailed'), t('error.onlyRegularFiles'));
    }

    throwIfAborted(signal);
    const partSize = this.normalizePartSize(partSizeMb, fileStat.size);
    this.logger.operation('uploadObject', 'start', t('s3.uploadObjectStart', { target: `${safeBucket}/${safeKey}` }));
    try {
      try {
        await this.uploadObjectWithChecksum(
          safeBucket,
          safeKey,
          filePath,
          fileStat.size,
          partSize,
          multipartConcurrency,
          onProgress,
          signal
        );
      } catch (error) {
        if (
          !isAbortLike(error) &&
          isChecksumMustBeSha256Error(error) &&
          this.activeConnection?.checksumAlgorithm !== 'SHA256'
        ) {
          this.logger.warn(
            t('s3.sha256Retry'),
            normalizeError(error).detail
          );
          await this.uploadObjectWithChecksum(
            safeBucket,
            safeKey,
            filePath,
            fileStat.size,
            partSize,
            multipartConcurrency,
            onProgress,
            signal,
            ChecksumAlgorithm.SHA256
          );
        } else {
          throw error;
        }
      }
      const totalParts = partCountFor(fileStat.size, partSize);
      onProgress?.(100, fileStat.size, fileStat.size, {
        completedParts: totalParts,
        totalParts,
        activeParts: 0
      });
      this.logger.operation('uploadObject', 'success', t('s3.uploadObjectSuccess', { target: `${safeBucket}/${safeKey}` }));
    } catch (error) {
      this.logFailedOrCanceled('uploadObject', error, t('error.uploadFailed'));
      throw normalizeError(error, t('error.uploadFailed'));
    }
  }

  async uploadDirectory(
    bucket: string,
    prefix: string,
    directoryPath: string,
    partSizeMb: number,
    multipartConcurrency: number,
    preserveEmptyFolders: boolean,
    onProgress?: ProgressHandler,
    onStats?: StatsHandler,
    signal?: AbortSignal
  ): Promise<OperationResult> {
    const safeBucket = assertBucketName(bucket);
    const rootInfo = await stat(directoryPath);
    if (!rootInfo.isDirectory()) {
      throw new AppError(t('error.uploadFailed'), t('error.uploadDirectoryNotDirectory'));
    }

    const rootPrefix = joinS3Key(prefix, basename(directoryPath));
    this.logger.operation(
      'uploadDirectory',
      'start',
      t('s3.uploadFolderStart', { target: `${safeBucket}/${rootPrefix}/` })
    );
    const scan = await scanDirectory(directoryPath, signal);
    const totalItems =
      scan.files.length + (preserveEmptyFolders ? scan.emptyDirectories.length : 0) + scan.skipped;
    const stats = createStats(totalItems);
    stats.skipped = scan.skipped;
    stats.processed = scan.skipped;
    const result: OperationResult = {
      stats,
      errors: [...scan.errors],
      failedItems: [...scan.failedItems]
    };
    onStats?.({ ...stats });

    const totalBytes = scan.files.reduce((sum, file) => sum + file.size, 0);
    const loadedByFile = new Map<string, number>();
    let completedBytes = 0;
    const emitProgress = (): void => {
      const inFlightBytes = [...loadedByFile.values()].reduce((sum, value) => sum + value, 0);
      const loaded = completedBytes + inFlightBytes;
      onProgress?.(
        totalBytes > 0 ? Math.min(99, Math.round((loaded / totalBytes) * 100)) : 0,
        loaded,
        totalBytes
      );
    };

    await runWithConcurrency(
      scan.files,
      DEFAULT_QUEUE_SIZE,
      async (file) => {
        throwIfAborted(signal);
        const relativeKey = relativePathToS3Key(directoryPath, file.path);
        const targetKey = joinS3Key(rootPrefix, relativeKey);
        try {
          await this.uploadObject(
            safeBucket,
            targetKey,
            file.path,
            partSizeMb,
            multipartConcurrency,
            (_progress, transferred) => {
              loadedByFile.set(file.path, transferred ?? 0);
              emitProgress();
            },
            signal
          );
          completedBytes += file.size;
          loadedByFile.delete(file.path);
          stats.success += 1;
        } catch (error) {
          loadedByFile.delete(file.path);
          if (isAbortLike(error)) {
            throw error;
          }
          stats.failed += 1;
          addOperationError(result, targetKey, error);
        } finally {
          stats.processed += 1;
          onStats?.({ ...stats });
        }
      },
      signal
    );

    if (preserveEmptyFolders) {
      for (const emptyDirectory of scan.emptyDirectories) {
        throwIfAborted(signal);
        const placeholderKey =
          emptyDirectory === directoryPath
            ? `${rootPrefix}/`
            : `${joinS3Key(rootPrefix, relativePathToS3Key(directoryPath, emptyDirectory))}/`;
        try {
          await this.createFolder(safeBucket, placeholderKey, signal);
          stats.success += 1;
        } catch (error) {
          if (isAbortLike(error)) {
            throw error;
          }
          stats.failed += 1;
          addOperationError(result, placeholderKey, error);
        } finally {
          stats.processed += 1;
          onStats?.({ ...stats });
        }
      }
    }

    onProgress?.(100, totalBytes, totalBytes);
    this.logOperationResult(
      'uploadDirectory',
      result,
      t('s3.uploadFolderSuccess', { target: `${safeBucket}/${rootPrefix}/` })
    );
    return result;
  }

  async downloadObject(
    bucket: string,
    key: string,
    savePath: string,
    partSizeMb?: number,
    multipartConcurrency = DEFAULT_MULTIPART_CONCURRENCY,
    onProgress?: ProgressHandler,
    signal?: AbortSignal
  ): Promise<void> {
    const safeBucket = assertBucketName(bucket);
    const safeKey = assertS3Key(key);
    try {
      throwIfAborted(signal);
      this.logger.operation('downloadObject', 'start', t('s3.downloadObjectStart', { target: `${safeBucket}/${safeKey}` }));
      await mkdir(dirname(savePath), { recursive: true });
      const metadata = await this.client().send(
        new HeadObjectCommand({ Bucket: safeBucket, Key: safeKey }),
        {
          abortSignal: signal
        }
      );
      const total = metadata.ContentLength ?? 0;
      const partSize = this.normalizePartSize(partSizeMb ?? DEFAULT_PART_SIZE_MB, total);

      if (total >= MULTIPART_TRANSFER_THRESHOLD && total > partSize) {
        await this.downloadObjectInRanges(
          safeBucket,
          safeKey,
          savePath,
          total,
          partSize,
          multipartConcurrency,
          metadata.ETag,
          onProgress,
          signal
        );
      } else {
        await this.downloadObjectSingle(safeBucket, safeKey, savePath, total, onProgress, signal);
      }
      this.logger.operation('downloadObject', 'success', t('s3.downloadObjectSuccess', { target: `${safeBucket}/${safeKey}` }));
    } catch (error) {
      this.logFailedOrCanceled('downloadObject', error, t('error.downloadFailed'));
      throw normalizeError(error, t('error.downloadFailed'));
    }
  }

  async deleteObject(bucket: string, key: string, signal?: AbortSignal): Promise<void> {
    const safeBucket = assertBucketName(bucket);
    const safeKey = assertS3Key(key, { allowTrailingSlash: true });
    try {
      this.logger.operation('deleteObject', 'start', t('s3.deleteObjectStart', { target: `${safeBucket}/${safeKey}` }));
      await this.client().send(
        new DeleteObjectCommand({
          Bucket: safeBucket,
          Key: safeKey
        }),
        { abortSignal: signal }
      );
      this.logger.operation('deleteObject', 'success', t('s3.deleteObjectSuccess', { target: `${safeBucket}/${safeKey}` }));
    } catch (error) {
      this.logFailedOrCanceled('deleteObject', error, t('error.deleteFailed'));
      throw normalizeError(error, t('error.deleteFailed'));
    }
  }

  async deleteObjects(
    bucket: string,
    keys: string[],
    signal?: AbortSignal
  ): Promise<OperationResult> {
    const safeBucket = assertBucketName(bucket);
    const safeKeys = uniqueKeys(keys.map((key) => assertS3Key(key, { allowTrailingSlash: true })));
    const expandedKeys = await this.expandDeleteKeys(safeBucket, safeKeys, signal);
    const result: OperationResult = {
      stats: createStats(expandedKeys.length),
      errors: [],
      failedItems: []
    };

    this.logger.operation('deleteObjects', 'start', t('s3.deleteObjectsStart', { bucket: safeBucket }), result.stats);
    for (const batch of chunk(expandedKeys, DELETE_OBJECTS_BATCH_SIZE)) {
      throwIfAborted(signal);
      try {
        const output = await this.client().send(
          new DeleteObjectsCommand({
            Bucket: safeBucket,
            Delete: {
              Objects: batch.map((Key) => ({ Key })),
              Quiet: false
            }
          }),
          { abortSignal: signal }
        );
        const failed = output.Errors?.length ?? 0;
        result.stats.failed += failed;
        result.stats.success += batch.length - failed;
        for (const error of output.Errors ?? []) {
          addOperationError(
            result,
            error.Key ?? 'unknown',
            error.Message ?? error.Code ?? t('error.deleteFailed')
          );
        }
      } catch (error) {
        if (isAbortLike(error)) {
          throw error;
        }
        result.stats.failed += batch.length;
        for (const key of batch) {
          addOperationError(result, key, error);
        }
      } finally {
        result.stats.processed += batch.length;
      }
    }

    this.logOperationResult('deleteObjects', result, t('s3.deleteObjectsSuccess', { bucket: safeBucket }));
    return result;
  }

  async copyObject(
    sourceBucket: string,
    sourceKey: string,
    targetBucket: string,
    targetKey: string,
    targetExistsPolicy: TargetExistsPolicy = 'autoRename',
    partSizeMb = DEFAULT_PART_SIZE_MB,
    multipartConcurrency = DEFAULT_MULTIPART_CONCURRENCY,
    signal?: AbortSignal
  ): Promise<OperationResult> {
    const safeSourceBucket = assertBucketName(sourceBucket);
    const safeTargetBucket = assertBucketName(targetBucket);
    const safeSourceKey = assertS3Key(sourceKey, { allowTrailingSlash: true });
    const safeTargetKey = assertS3Key(targetKey, { allowTrailingSlash: true });

    if (safeSourceKey.endsWith('/')) {
      return this.copyPrefix(
        safeSourceBucket,
        safeSourceKey,
        safeTargetBucket,
        safeTargetKey,
        targetExistsPolicy,
        partSizeMb,
        multipartConcurrency,
        signal
      );
    }

    const result: OperationResult = { stats: createStats(1), errors: [], failedItems: [] };
    this.logger.operation(
      'copyObject',
      'start',
      t('s3.copyObjectStart', { target: `${safeSourceBucket}/${safeSourceKey}` })
    );
    try {
      const resolved = await this.resolveTargetKey(
        safeTargetBucket,
        safeTargetKey,
        targetExistsPolicy,
        signal
      );
      result.targetKey = resolved.key;
      if (resolved.skipped) {
        result.stats.skipped = 1;
        result.stats.processed = 1;
        this.logOperationResult(
          'copyObject',
          result,
          t('s3.copyObjectSkipped', { target: `${safeTargetBucket}/${safeTargetKey}` })
        );
        return result;
      }

      await this.copySingleObject(
        safeSourceBucket,
        safeSourceKey,
        safeTargetBucket,
        resolved.key,
        partSizeMb,
        multipartConcurrency,
        signal
      );
      result.stats.success = 1;
      result.stats.processed = 1;
      this.logOperationResult(
        'copyObject',
        result,
        t('s3.copyObjectSuccess', { target: `${safeTargetBucket}/${resolved.key}` })
      );
      return result;
    } catch (error) {
      if (isAbortLike(error)) {
        this.logger.operation(
          'copyObject',
          'canceled',
          t('s3.copyObjectCanceled', { target: `${safeSourceBucket}/${safeSourceKey}` })
        );
      } else {
        this.logger.operation(
          'copyObject',
          'failed',
          t('error.copyFailed'),
          result.stats,
          normalizeError(error).detail
        );
      }
      throw normalizeError(error, t('error.copyFailed'));
    }
  }

  async moveObject(
    sourceBucket: string,
    sourceKey: string,
    targetBucket: string,
    targetKey: string,
    targetExistsPolicy: TargetExistsPolicy = 'autoRename',
    partSizeMb = DEFAULT_PART_SIZE_MB,
    multipartConcurrency = DEFAULT_MULTIPART_CONCURRENCY,
    signal?: AbortSignal
  ): Promise<OperationResult> {
    const safeTarget = assertS3MoveTarget(sourceBucket, sourceKey, targetBucket, targetKey);
    if (safeTarget.sourceKey.endsWith('/')) {
      return this.movePrefix(
        safeTarget.sourceBucket,
        safeTarget.sourceKey,
        safeTarget.targetBucket,
        safeTarget.targetKey,
        targetExistsPolicy,
        partSizeMb,
        multipartConcurrency,
        signal
      );
    }

    const result = await this.copyObject(
      safeTarget.sourceBucket,
      safeTarget.sourceKey,
      safeTarget.targetBucket,
      safeTarget.targetKey,
      targetExistsPolicy,
      partSizeMb,
      multipartConcurrency,
      signal
    );
    if (result.stats.skipped > 0) {
      return result;
    }

    try {
      throwIfAborted(signal);
      await this.deleteObject(safeTarget.sourceBucket, safeTarget.sourceKey, signal);
      this.logger.operation(
        'moveObject',
        'success',
        t('s3.moveObjectSuccess', { target: `${safeTarget.sourceBucket}/${safeTarget.sourceKey}` }),
        result.stats
      );
      return result;
    } catch (error) {
      const normalized = normalizeError(error, t('error.copyCompletedDeleteSourceFailed'));
      result.stats.failed += 1;
      result.stats.processed = Math.max(result.stats.processed, 1);
      addOperationError(
        result,
        safeTarget.sourceKey,
        `${t('error.targetCreatedDeleteSourceFailed')}: ${normalized.message}`
      );
      this.logger.operation(
        'moveObject',
        'partial_success',
        t('error.targetCreatedDeleteSourceFailed'),
        result.stats,
        normalized.detail
      );
      return result;
    }
  }

  async renameObject(
    bucket: string,
    oldKey: string,
    newKey: string,
    targetExistsPolicy: TargetExistsPolicy = 'autoRename',
    partSizeMb = DEFAULT_PART_SIZE_MB,
    multipartConcurrency = DEFAULT_MULTIPART_CONCURRENCY,
    signal?: AbortSignal
  ): Promise<OperationResult> {
    return this.moveObject(
      bucket,
      oldKey,
      bucket,
      newKey,
      targetExistsPolicy,
      partSizeMb,
      multipartConcurrency,
      signal
    );
  }

  async createFolder(bucket: string, prefix: string, signal?: AbortSignal): Promise<void> {
    const safeBucket = assertBucketName(bucket);
    const safeKey = assertS3Key(prefix.endsWith('/') ? prefix : `${prefix}/`, {
      allowTrailingSlash: true
    });
    try {
      this.logger.operation('createFolder', 'start', t('s3.createFolderStart', { target: `${safeBucket}/${safeKey}` }));
      await this.client().send(
        new PutObjectCommand({
          Bucket: safeBucket,
          Key: safeKey,
          Body: '',
          ...this.checksumParams()
        }),
        { abortSignal: signal }
      );
      this.logger.operation('createFolder', 'success', t('s3.createFolderSuccess', { target: `${safeBucket}/${safeKey}` }));
    } catch (error) {
      this.logFailedOrCanceled('createFolder', error, t('error.createFolderFailed'));
      throw normalizeError(error, t('error.createFolderFailed'));
    }
  }

  async getObjectMetadata(
    bucket: string,
    key: string,
    signal?: AbortSignal
  ): Promise<ObjectMetadata> {
    const safeBucket = assertBucketName(bucket);
    const safeKey = assertS3Key(key, { allowTrailingSlash: true });
    try {
      this.logger.operation(
        'getObjectMetadata',
        'start',
        t('s3.metadataStart', { target: `${safeBucket}/${safeKey}` })
      );
      const output = await this.client().send(
        new HeadObjectCommand({ Bucket: safeBucket, Key: safeKey }),
        {
          abortSignal: signal
        }
      );
      this.logger.operation(
        'getObjectMetadata',
        'success',
        t('s3.metadataSuccess', { target: `${safeBucket}/${safeKey}` })
      );
      return {
        contentType: output.ContentType,
        contentLength: output.ContentLength,
        lastModified: output.LastModified?.toISOString(),
        storageClass: output.StorageClass,
        etag: output.ETag,
        metadata: output.Metadata ?? {}
      };
    } catch (error) {
      this.logFailedOrCanceled('getObjectMetadata', error, t('error.metadataFailed'));
      throw normalizeError(error, t('error.metadataFailed'));
    }
  }

  async generateObjectUrl(bucket: string, key: string): Promise<string> {
    const safeBucket = assertBucketName(bucket);
    const safeKey = assertS3Key(key);
    try {
      this.logger.operation(
        'generateObjectUrl',
        'start',
        t('s3.urlStart', { target: `${safeBucket}/${safeKey}` })
      );
      const url = await getSignedUrl(
        this.client(),
        new GetObjectCommand({ Bucket: safeBucket, Key: safeKey }),
        {
          expiresIn: 60 * 60
        }
      );
      this.logger.operation(
        'generateObjectUrl',
        'success',
        t('s3.urlSuccess', { target: `${safeBucket}/${safeKey}` })
      );
      return url;
    } catch (error) {
      this.logFailedOrCanceled('generateObjectUrl', error, t('error.urlFailed'));
      throw normalizeError(error, t('error.urlFailed'));
    }
  }

  async listAllObjectKeys(bucket: string, prefix: string, signal?: AbortSignal): Promise<string[]> {
    const safeBucket = assertBucketName(bucket);
    const safePrefix = normalizeS3Prefix(prefix);
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      throwIfAborted(signal);
      const output = await this.client().send(
        new ListObjectsV2Command({
          Bucket: safeBucket,
          Prefix: safePrefix,
          MaxKeys: 1000,
          ContinuationToken: continuationToken
        }),
        { abortSignal: signal }
      );
      for (const object of output.Contents ?? []) {
        if (object.Key) {
          keys.push(assertS3Key(object.Key, { allowTrailingSlash: object.Key.endsWith('/') }));
        }
      }
      continuationToken = output.IsTruncated ? output.NextContinuationToken : undefined;
    } while (continuationToken);

    return keys;
  }

  private async expandDeleteKeys(
    bucket: string,
    keys: string[],
    signal?: AbortSignal
  ): Promise<string[]> {
    const expandedKeys: string[] = [];
    for (const key of keys) {
      throwIfAborted(signal);
      if (!key.endsWith('/')) {
        expandedKeys.push(key);
        continue;
      }

      const prefixKeys = await this.listAllObjectKeys(bucket, key, signal);
      expandedKeys.push(...(prefixKeys.length > 0 ? prefixKeys : [key]));
    }
    return uniqueKeys(expandedKeys);
  }

  private client(): S3Client {
    const connection = this.connection();
    const nextClientKey = s3ClientKey(connection);
    if (!this.activeClient || this.activeClientKey !== nextClientKey) {
      this.activeClient?.destroy();
      this.activeClient = createS3Client(connection);
      this.activeClientKey = nextClientKey;
    }
    return this.activeClient;
  }

  private connection(): ConnectionConfig {
    if (!this.activeConnection) {
      throw new AppError(t('error.s3ConnectionRequired'));
    }
    if (!this.activeConnection.secretAccessKey) {
      throw new AppError(t('config.secretMissing'));
    }
    return this.activeConnection;
  }

  private nameFromKey(key: string, prefix: string): string {
    const relative = key.slice(prefix.length);
    return relative.endsWith('/') ? relative.slice(0, -1) : relative;
  }

  private async uploadObjectSingle(
    bucket: string,
    key: string,
    filePath: string,
    size: number,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
    checksumAlgorithm?: ChecksumAlgorithm
  ): Promise<void> {
    const stream = createReadStream(filePath);
    const progress = createProgressTransform(size, onProgress, 1);
    const abortStream = (): void => {
      stream.destroy(new AppError(t('error.taskCanceled')));
      progress.destroy(new AppError(t('error.taskCanceled')));
    };
    signal?.addEventListener('abort', abortStream, { once: true });

    try {
      await this.client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: stream.pipe(progress),
          ContentLength: size,
          ContentType: lookup(filePath) || undefined,
          ...this.checksumParams(checksumAlgorithm)
        }),
        { abortSignal: signal }
      );
    } finally {
      signal?.removeEventListener('abort', abortStream);
      stream.destroy();
      progress.destroy();
    }
  }

  private async uploadObjectMultipart(
    bucket: string,
    key: string,
    filePath: string,
    size: number,
    partSize: number,
    multipartConcurrency: number,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
    checksumAlgorithm?: ChecksumAlgorithm
  ): Promise<void> {
    const totalParts = partCountFor(size, partSize);
    const checksumParams = this.checksumParams(checksumAlgorithm);
    const queueSize = this.normalizeQueueSize(size, partSize, multipartConcurrency);
    const stream = createReadStream(filePath);
    const uploadController = new AbortController();
    const abortUpload = (): void => {
      stream.destroy(new AppError(t('error.taskCanceled')));
      uploadController.abort();
    };
    signal?.addEventListener('abort', abortUpload, { once: true });

    try {
      const upload = new Upload({
        client: this.client(),
        params: {
          Bucket: bucket,
          Key: key,
          Body: stream,
          ContentLength: size,
          ContentType: lookup(filePath) || undefined,
          ...checksumParams
        },
        queueSize,
        partSize,
        leavePartsOnError: false,
        abortController: uploadController
      });
      upload.on('httpUploadProgress', (progress: UploadProgress) => {
        const loaded = Math.min(size, Math.max(0, Math.round(progress.loaded ?? 0)));
        const completedParts = this.completedPartsFromLoaded(loaded, size, partSize, totalParts);
        onProgress?.(Math.min(99, Math.round((loaded / size) * 100)), loaded, size, {
          completedParts,
          totalParts,
          activeParts: this.activePartCount(totalParts, completedParts, queueSize)
        });
      });
      await upload.done();
    } finally {
      signal?.removeEventListener('abort', abortUpload);
      stream.destroy();
    }
  }

  private async downloadObjectSingle(
    bucket: string,
    key: string,
    savePath: string,
    expectedSize: number,
    onProgress?: ProgressHandler,
    signal?: AbortSignal
  ): Promise<void> {
    const tempPath = tempDownloadPath(savePath);
    try {
      const output = await this.client().send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: signal
      });
      const body = output.Body as Readable | undefined;
      if (!body) {
        throw new AppError(t('error.downloadFailed'), t('error.s3EmptyBody'));
      }

      let loaded = 0;
      const progress = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          loaded += chunk.length;
          onProgress?.(
            expectedSize > 0 ? Math.round((loaded / expectedSize) * 100) : 0,
            loaded,
            expectedSize,
            {
              completedParts: loaded >= expectedSize ? 1 : 0,
              totalParts: 1
            }
          );
          callback(null, chunk);
        }
      });

      await pipeline(body, progress, createWriteStream(tempPath), { signal });
      if (expectedSize >= 0 && loaded !== expectedSize) {
        throw new AppError(
          t('error.downloadFailed'),
          t('error.incompleteDownload', { loaded, expected: expectedSize })
        );
      }
      await assertFileSize(tempPath, expectedSize);
      await rename(tempPath, savePath);
      onProgress?.(100, expectedSize, expectedSize, { completedParts: 1, totalParts: 1 });
    } catch (error) {
      await removeTempFile(tempPath);
      throw error;
    }
  }

  private async downloadObjectInRanges(
    bucket: string,
    key: string,
    savePath: string,
    total: number,
    partSize: number,
    multipartConcurrency: number,
    etag?: string,
    onProgress?: ProgressHandler,
    signal?: AbortSignal
  ): Promise<void> {
    const tempPath = tempDownloadPath(savePath);
    try {
      const ranges = createByteRanges(total, partSize);
      const file = await open(tempPath, 'w');
      try {
        await file.truncate(total);
      } finally {
        await file.close();
      }

      let loaded = 0;
      let completedParts = 0;
      const queueSize = this.normalizeQueueSize(total, partSize, multipartConcurrency);
      await runWithConcurrency(
        ranges,
        queueSize,
        async ({ start, end }) => {
          throwIfAborted(signal);
          const output = await this.client().send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: key,
              Range: `bytes=${start}-${end}`,
              IfMatch: etag
            }),
            { abortSignal: signal }
          );
          const body = output.Body as Readable | undefined;
          if (!body) {
            throw new AppError(
              t('error.downloadFailed'),
              t('error.partEmptyBody', { start, end })
            );
          }
          await writeRange(
            tempPath,
            start,
            end,
            body,
            (bytes) => {
              loaded += bytes;
              onProgress?.(Math.min(99, Math.round((loaded / total) * 100)), loaded, total, {
                completedParts,
                totalParts: ranges.length,
                activeParts: this.activePartCount(ranges.length, completedParts, queueSize)
              });
            },
            signal
          );
          completedParts += 1;
          onProgress?.(Math.min(99, Math.round((loaded / total) * 100)), loaded, total, {
            completedParts,
            totalParts: ranges.length,
            activeParts: this.activePartCount(ranges.length, completedParts, queueSize)
          });
        },
        signal
      );

      await assertFileSize(tempPath, total);
      await rename(tempPath, savePath);
      onProgress?.(100, total, total, {
        completedParts: ranges.length,
        totalParts: ranges.length,
        activeParts: 0
      });
    } catch (error) {
      await removeTempFile(tempPath);
      throw error;
    }
  }

  private async copySingleObject(
    sourceBucket: string,
    sourceKey: string,
    targetBucket: string,
    targetKey: string,
    partSizeMb: number,
    multipartConcurrency: number,
    signal?: AbortSignal
  ): Promise<void> {
    const metadata = await this.client().send(
      new HeadObjectCommand({ Bucket: sourceBucket, Key: sourceKey }),
      { abortSignal: signal }
    );
    const size = metadata.ContentLength ?? 0;
    if (size >= SINGLE_COPY_LIMIT) {
      await this.copyObjectMultipart(
        sourceBucket,
        sourceKey,
        targetBucket,
        targetKey,
        size,
        metadata,
        partSizeMb,
        multipartConcurrency,
        signal
      );
    } else {
      await this.client().send(
        new CopyObjectCommand({
          Bucket: targetBucket,
          Key: targetKey,
          CopySource: encodeCopySource(sourceBucket, sourceKey),
          MetadataDirective: 'COPY'
        }),
        { abortSignal: signal }
      );
    }
  }

  private async copyPrefix(
    sourceBucket: string,
    sourcePrefix: string,
    targetBucket: string,
    targetPrefix: string,
    targetExistsPolicy: TargetExistsPolicy,
    partSizeMb: number,
    multipartConcurrency: number,
    signal?: AbortSignal
  ): Promise<OperationResult> {
    return this.copyOrMovePrefix(
      'copyPrefix',
      t('taskType.copy'),
      sourceBucket,
      sourcePrefix,
      targetBucket,
      targetPrefix,
      targetExistsPolicy,
      partSizeMb,
      multipartConcurrency,
      false,
      signal
    );
  }

  private async movePrefix(
    sourceBucket: string,
    sourcePrefix: string,
    targetBucket: string,
    targetPrefix: string,
    targetExistsPolicy: TargetExistsPolicy,
    partSizeMb: number,
    multipartConcurrency: number,
    signal?: AbortSignal
  ): Promise<OperationResult> {
    return this.copyOrMovePrefix(
      'movePrefix',
      t('taskType.move'),
      sourceBucket,
      sourcePrefix,
      targetBucket,
      targetPrefix,
      targetExistsPolicy,
      partSizeMb,
      multipartConcurrency,
      true,
      signal
    );
  }

  private async copyOrMovePrefix(
    operation: 'copyPrefix' | 'movePrefix',
    label: string,
    sourceBucket: string,
    sourcePrefix: string,
    targetBucket: string,
    targetPrefix: string,
    targetExistsPolicy: TargetExistsPolicy,
    partSizeMb: number,
    multipartConcurrency: number,
    deleteSourceAfterCopy: boolean,
    signal?: AbortSignal
  ): Promise<OperationResult> {
    const sourceKeys = await this.listAllObjectKeys(sourceBucket, sourcePrefix, signal);
    const result: OperationResult = {
      stats: createStats(sourceKeys.length),
      errors: [],
      failedItems: []
    };
    this.logger.operation(
      operation,
      'start',
      t('s3.prefixOperationStart', { action: label, target: `${sourceBucket}/${sourcePrefix}` }),
      result.stats
    );

    await runWithConcurrency(
      sourceKeys,
      DEFAULT_QUEUE_SIZE,
      async (sourceKey) => {
        throwIfAborted(signal);
        const candidateTargetKey = replaceKeyPrefix(sourceKey, sourcePrefix, targetPrefix);
        let copied = false;
        try {
          const resolved = await this.resolveTargetKey(
            targetBucket,
            candidateTargetKey,
            targetExistsPolicy,
            signal
          );
          if (resolved.skipped) {
            result.stats.skipped += 1;
            return;
          }
          await this.copySingleObject(
            sourceBucket,
            sourceKey,
            targetBucket,
            resolved.key,
            partSizeMb,
            multipartConcurrency,
            signal
          );
          copied = true;
          if (deleteSourceAfterCopy) {
            await this.deleteObject(sourceBucket, sourceKey, signal);
          }
          result.stats.success += 1;
        } catch (error) {
          if (isAbortLike(error) && (!deleteSourceAfterCopy || !copied)) {
            throw error;
          }
          result.stats.failed += 1;
          if (deleteSourceAfterCopy) {
            const message = copied
              ? t('error.targetCreatedDeleteSourceFailed')
              : t('error.copyFailedSourceKept');
            addOperationError(result, sourceKey, `${message}; ${normalizeError(error).message}`);
          } else {
            addOperationError(result, sourceKey, error);
          }
        } finally {
          result.stats.processed += 1;
        }
      },
      signal
    );

    this.logOperationResult(
      operation,
      result,
      t('s3.prefixOperationSuccess', { action: label, target: `${sourceBucket}/${sourcePrefix}` })
    );
    return result;
  }

  private async copyObjectMultipart(
    sourceBucket: string,
    sourceKey: string,
    targetBucket: string,
    targetKey: string,
    total: number,
    sourceMetadata: HeadObjectCommandOutput,
    partSizeMb: number,
    multipartConcurrency: number,
    signal?: AbortSignal
  ): Promise<void> {
    const partSize = this.normalizePartSize(partSizeMb, total);
    const ranges = createByteRanges(total, partSize);
    const queueSize = this.normalizeQueueSize(total, partSize, multipartConcurrency);
    let uploadId: string | undefined;

    try {
      const created = await this.client().send(
        new CreateMultipartUploadCommand({
          Bucket: targetBucket,
          Key: targetKey,
          CacheControl: sourceMetadata.CacheControl,
          ContentDisposition: sourceMetadata.ContentDisposition,
          ContentEncoding: sourceMetadata.ContentEncoding,
          ContentLanguage: sourceMetadata.ContentLanguage,
          ContentType: sourceMetadata.ContentType,
          Expires: sourceMetadata.Expires,
          Metadata: sourceMetadata.Metadata,
          WebsiteRedirectLocation: sourceMetadata.WebsiteRedirectLocation
        }),
        { abortSignal: signal }
      );
      uploadId = created.UploadId;
      if (!uploadId) {
        throw new AppError(t('error.copyFailed'), t('error.multipartUploadIdMissing'));
      }

      const parts: Array<{ ETag: string; PartNumber: number }> = new Array(ranges.length);
      await runWithConcurrency(
        ranges.map((range, index) => ({ ...range, partNumber: index + 1 })),
        queueSize,
        async ({ start, end, partNumber }) => {
          throwIfAborted(signal);
          const copied = await this.client().send(
            new UploadPartCopyCommand({
              Bucket: targetBucket,
              Key: targetKey,
              UploadId: uploadId,
              PartNumber: partNumber,
              CopySource: encodeCopySource(sourceBucket, sourceKey),
              CopySourceRange: `bytes=${start}-${end}`
            }),
            { abortSignal: signal }
          );
          const etag = copied.CopyPartResult?.ETag;
          if (!etag) {
            throw new AppError(
              t('error.copyFailed'),
              t('error.multipartPartEtagMissing', { partNumber })
            );
          }
          parts[partNumber - 1] = {
            ETag: etag,
            PartNumber: partNumber
          };
        },
        signal
      );

      await this.client().send(
        new CompleteMultipartUploadCommand({
          Bucket: targetBucket,
          Key: targetKey,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts
          }
        }),
        { abortSignal: signal }
      );
    } catch (error) {
      if (uploadId) {
        await this.abortMultipartCopy(targetBucket, targetKey, uploadId);
      }
      throw error;
    }
  }

  private async abortMultipartCopy(bucket: string, key: string, uploadId: string): Promise<void> {
    await this.abortMultipartUpload(bucket, key, uploadId, t('error.abortMultipartCleanupFailed'));
  }

  private async abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    fallback: string
  ): Promise<void> {
    try {
      await this.client().send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId
        })
      );
    } catch (abortError) {
      const normalized = normalizeError(abortError, fallback);
      this.logger.warn(normalized.message, normalized.detail);
    }
  }

  private async resolveTargetKey(
    bucket: string,
    key: string,
    policy: TargetExistsPolicy,
    signal?: AbortSignal
  ): Promise<{ key: string; skipped: boolean }> {
    if (policy === 'overwrite') {
      return { key, skipped: false };
    }

    const exists = await this.objectExists(bucket, key, signal);
    if (!exists) {
      return { key, skipped: false };
    }
    if (policy === 'skip') {
      return { key, skipped: true };
    }

    for (let index = 1; index < 10000; index += 1) {
      const candidate = withObjectKeySuffix(key, ` (${index})`);
      if (!(await this.objectExists(bucket, candidate, signal))) {
        return { key: candidate, skipped: false };
      }
    }

    throw new AppError(t('error.targetKeyUnavailable'));
  }

  private async objectExists(bucket: string, key: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: signal
      });
      return true;
    } catch (error) {
      const normalized = normalizeError(error);
      if (
        normalized.message === t('error.objectNotFound') ||
        normalized.message === '对象不存在'
      ) {
        return false;
      }
      throw error;
    }
  }

  private async uploadObjectWithChecksum(
    bucket: string,
    key: string,
    filePath: string,
    size: number,
    partSize: number,
    multipartConcurrency: number,
    onProgress?: ProgressHandler,
    signal?: AbortSignal,
    checksumAlgorithm?: ChecksumAlgorithm
  ): Promise<void> {
    if (size < MULTIPART_TRANSFER_THRESHOLD) {
      await this.uploadObjectSingle(
        bucket,
        key,
        filePath,
        size,
        onProgress,
        signal,
        checksumAlgorithm
      );
      return;
    }

    await this.uploadObjectMultipart(
      bucket,
      key,
      filePath,
      size,
      partSize,
      multipartConcurrency,
      onProgress,
      signal,
      checksumAlgorithm
    );
  }

  private checksumParams(checksumAlgorithm?: ChecksumAlgorithm): {
    ChecksumAlgorithm?: ChecksumAlgorithm;
  } {
    if (checksumAlgorithm) {
      return { ChecksumAlgorithm: checksumAlgorithm };
    }
    if (this.activeConnection?.checksumAlgorithm === 'CRC32') {
      return { ChecksumAlgorithm: ChecksumAlgorithm.CRC32 };
    }
    if (this.activeConnection?.checksumAlgorithm === 'SHA256') {
      return { ChecksumAlgorithm: ChecksumAlgorithm.SHA256 };
    }
    return {};
  }

  private normalizePartSize(partSizeMb: number, objectSize?: number): number {
    const normalized = Number.isFinite(partSizeMb) ? Math.floor(partSizeMb) : DEFAULT_PART_SIZE_MB;
    const requested = Math.max(MIN_PART_SIZE, Math.min(MAX_PART_SIZE, normalized * MIB));
    const required = objectSize ? Math.ceil(objectSize / MAX_MULTIPART_PARTS) : MIN_PART_SIZE;
    return Math.max(MIN_PART_SIZE, Math.min(MAX_PART_SIZE, Math.max(requested, required)));
  }

  private normalizeQueueSize(
    total: number,
    partSize: number,
    preferredQueueSize = DEFAULT_MULTIPART_CONCURRENCY
  ): number {
    const partCount = Math.ceil(total / partSize);
    if (partCount <= 1) {
      return 1;
    }
    const normalized = Number.isFinite(preferredQueueSize)
      ? Math.floor(preferredQueueSize)
      : DEFAULT_MULTIPART_CONCURRENCY;
    return Math.max(1, Math.min(MAX_MULTIPART_CONCURRENCY, normalized, partCount));
  }

  private completedPartsFromLoaded(
    loaded: number,
    total: number,
    partSize: number,
    totalParts: number
  ): number {
    if (loaded >= total) {
      return totalParts;
    }
    return Math.max(0, Math.min(totalParts, Math.floor(loaded / partSize)));
  }

  private activePartCount(totalParts: number, completedParts: number, queueSize: number): number {
    const remainingParts = totalParts - completedParts;
    if (remainingParts <= 0) {
      return 0;
    }
    return Math.max(1, Math.min(queueSize, remainingParts));
  }

  private logFailedOrCanceled(operation: string, error: unknown, fallback: string): void {
    const normalized = normalizeError(error, fallback);
    const status = isAbortLike(error) ? 'canceled' : 'failed';
    this.logger.operation(operation, status, normalized.message, undefined, normalized.detail);
  }

  private logOperationResult(operation: string, result: OperationResult, message: string): void {
    const status =
      result.stats.failed > 0 && result.stats.success > 0
        ? 'partial_success'
        : result.stats.failed > 0
          ? 'failed'
          : 'success';
    this.logger.operation(
      operation,
      status,
      message,
      result.stats,
      result.errors.join('\n') || undefined
    );
  }
}

function objectName(object: ObjectItem): string {
  return object.name || object.key || '';
}

function addOperationError(result: OperationResult, key: string, error: unknown): void {
  const message = formatOperationError(key, error);
  result.errors.push(message);
  if (typeof error === 'string') {
    result.failedItems.push({
      key,
      reason: error,
      category: 'unknown'
    });
    return;
  }
  const normalized = normalizeError(error);
  result.failedItems.push({
    key,
    reason: normalized.message,
    category: classifyError(error),
    detail: normalized.detail
  });
}

function formatOperationError(target: string, error: unknown): string {
  if (typeof error === 'string') {
    return `${target}: ${error}`;
  }
  const normalized = normalizeError(error);
  return `${target}: ${normalized.message}${normalized.detail ? ` (${normalized.detail})` : ''}`;
}

function isChecksumMustBeSha256Error(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /checksum algorithm/i.test(message) && /sha256/i.test(message);
}

function withObjectKeySuffix(key: string, suffix: string): string {
  if (key.endsWith('/')) {
    const withoutSlash = key.slice(0, -1);
    const slashIndex = withoutSlash.lastIndexOf('/');
    const folder = slashIndex >= 0 ? `${withoutSlash.slice(0, slashIndex + 1)}` : '';
    const name = slashIndex >= 0 ? withoutSlash.slice(slashIndex + 1) : withoutSlash;
    return assertS3Key(`${folder}${name}${suffix}/`, { allowTrailingSlash: true });
  }

  const slashIndex = key.lastIndexOf('/');
  const folder = slashIndex >= 0 ? `${key.slice(0, slashIndex + 1)}` : '';
  const name = slashIndex >= 0 ? key.slice(slashIndex + 1) : key;
  const dotIndex = name.lastIndexOf('.');
  const nextName =
    dotIndex > 0
      ? `${name.slice(0, dotIndex)}${suffix}${name.slice(dotIndex)}`
      : `${name}${suffix}`;
  return assertS3Key(`${folder}${nextName}`);
}
