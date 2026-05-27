import { open, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { t } from '@shared/i18n';
import type { TaskStats } from '@shared/types';
import { AppError } from './error';

export interface ByteRange {
  start: number;
  end: number;
}

type ProgressHandler = (
  progress: number,
  transferred?: number,
  total?: number,
  meta?: {
    completedParts?: number;
    totalParts?: number;
  }
) => void;

export function createByteRanges(total: number, partSize: number): ByteRange[] {
  const ranges: ByteRange[] = [];
  for (let start = 0; start < total; start += partSize) {
    ranges.push({
      start,
      end: Math.min(total - 1, start + partSize - 1)
    });
  }
  return ranges;
}

export function partCountFor(total: number, partSize: number): number {
  if (total <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(total / Math.max(1, partSize)));
}

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  runner: (item: T) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      if (firstError) {
        return;
      }
      throwIfAborted(signal);
      const item = items[nextIndex];
      nextIndex += 1;
      try {
        await runner(item);
      } catch (error) {
        firstError ??= error;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) {
    throw firstError;
  }
}

export async function writeRange(
  filePath: string,
  start: number,
  end: number,
  body: Readable,
  onChunk: (bytes: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const file = await open(filePath, 'r+');
  const abortBody = (): void => {
    body.destroy(new AppError(t('error.taskCanceled')));
  };
  signal?.addEventListener('abort', abortBody, { once: true });
  try {
    let position = start;
    for await (const chunk of body) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await file.write(buffer, 0, buffer.length, position);
      position += buffer.length;
      onChunk(buffer.length);
    }
    if (position !== end + 1) {
      throw new AppError(
        t('error.downloadFailed'),
        t('error.incompletePart', { start, end })
      );
    }
  } finally {
    signal?.removeEventListener('abort', abortBody);
    body.destroy();
    await file.close();
  }
}

export async function assertFileSize(filePath: string, expectedSize: number): Promise<void> {
  const info = await stat(filePath);
  if (info.size !== expectedSize) {
    throw new AppError(
      t('error.downloadFailed'),
      t('error.tempFileSizeMismatch', { actual: info.size, expected: expectedSize })
    );
  }
}

export async function removeTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // 临时文件可能尚未创建或已被系统清理。
  }
}

export function tempDownloadPath(savePath: string): string {
  return join(
    dirname(savePath),
    `.${basename(savePath)}.oss-browser-${crypto.randomUUID()}.downloading`
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError(t('error.taskCanceled'));
  }
}

export function isAbortLike(error: unknown): boolean {
  if (
    error instanceof AppError &&
    (error.message === t('error.taskCanceled') || error.message === '任务已取消')
  ) {
    return true;
  }
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();
    return (
      name.includes('abort') ||
      message.includes('aborted') ||
      message.includes('任务已取消') ||
      message.includes('task canceled')
    );
  }
  return false;
}

export function createStats(total: number): TaskStats {
  return {
    total,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0
  };
}

export function createProgressTransform(
  total: number,
  onProgress?: ProgressHandler,
  totalParts?: number
): Transform {
  let loaded = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      loaded += chunk.length;
      onProgress?.(total > 0 ? Math.round((loaded / total) * 100) : 0, loaded, total, {
        completedParts: totalParts ? (loaded >= total ? totalParts : 0) : undefined,
        totalParts
      });
      callback(null, chunk);
    }
  });
}

export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export function uniqueKeys(keys: string[]): string[] {
  return [...new Set(keys)];
}
