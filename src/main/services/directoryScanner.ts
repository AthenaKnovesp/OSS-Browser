import { opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { t } from '@shared/i18n';
import type { BatchOperationFailedItem } from '@shared/types';
import { throwIfAborted } from './s3TransferUtils';

export interface DirectoryScanResult {
  files: Array<{ path: string; size: number }>;
  emptyDirectories: string[];
  skipped: number;
  errors: string[];
  failedItems: BatchOperationFailedItem[];
}

export async function scanDirectory(
  rootPath: string,
  signal?: AbortSignal
): Promise<DirectoryScanResult> {
  const result: DirectoryScanResult = {
    files: [],
    emptyDirectories: [],
    skipped: 0,
    errors: [],
    failedItems: []
  };

  const visit = async (directoryPath: string): Promise<boolean> => {
    throwIfAborted(signal);
    let hasUploadableChild = false;
    const dir = await opendir(directoryPath);
    try {
      for await (const entry of dir) {
        throwIfAborted(signal);
        const entryPath = join(directoryPath, entry.name);
        if (entry.isSymbolicLink()) {
          result.skipped += 1;
          addScanError(result, entryPath, t('scanner.skippedSymlink'));
          continue;
        }
        if (entry.isDirectory()) {
          const childHasFiles = await visit(entryPath);
          if (!childHasFiles) {
            result.emptyDirectories.push(entryPath);
          }
          hasUploadableChild = hasUploadableChild || childHasFiles;
          continue;
        }
        if (entry.isFile()) {
          const fileStat = await stat(entryPath);
          result.files.push({ path: entryPath, size: fileStat.size });
          hasUploadableChild = true;
          continue;
        }
        result.skipped += 1;
        addScanError(result, entryPath, t('scanner.skippedNonRegular'));
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    return hasUploadableChild;
  };

  const rootHasFiles = await visit(rootPath);
  if (!rootHasFiles) {
    result.emptyDirectories.push(rootPath);
  }

  return result;
}

function addScanError(result: DirectoryScanResult, key: string, reason: string): void {
  result.errors.push(`${key}: ${reason}`);
  result.failedItems.push({
    key,
    reason,
    category: 'path_safety'
  });
}
