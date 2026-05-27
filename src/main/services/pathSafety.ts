import { access, constants, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, parse, resolve, sep } from 'node:path';
import { t } from '@shared/i18n';
import { AppError } from './error';

export type DownloadCollisionPolicy = 'autoRename' | 'overwrite' | 'skip';

export interface DownloadTargetResolution {
  filePath: string;
  skipped: boolean;
}

export interface DownloadTargetOptions {
  reservedTargets?: ReadonlySet<string>;
}

export function assertPathInside(parentDir: string, candidatePath: string): string {
  const parent = normalizeForCompare(resolve(parentDir));
  const candidate = normalizeForCompare(resolve(candidatePath));
  if (candidate !== parent && !candidate.startsWith(`${parent}${sep}`)) {
    throw new AppError(t('error.pathTraversalBlocked'));
  }
  return resolve(candidatePath);
}

export async function resolveDownloadTarget(
  baseFolder: string,
  requestedSavePath: string | undefined,
  objectKey: string,
  collisionPolicy: DownloadCollisionPolicy,
  options: DownloadTargetOptions = {}
): Promise<DownloadTargetResolution> {
  const folder = resolve(baseFolder);
  await ensureDirectoryWritable(folder);

  const requested = requestedSavePath?.trim();
  const rawTarget = requested ? resolve(requested) : join(folder, basename(objectKey));
  const safeTarget = assertPathInside(folder, rawTarget);
  const reservedTargets = options.reservedTargets;

  if (collisionPolicy === 'overwrite') {
    if (isReservedTarget(safeTarget, reservedTargets)) {
      throw new AppError(t('error.downloadTargetReserved'));
    }
    return { filePath: safeTarget, skipped: false };
  }

  if (
    collisionPolicy === 'skip' &&
    ((await exists(safeTarget)) || isReservedTarget(safeTarget, reservedTargets))
  ) {
    return { filePath: safeTarget, skipped: true };
  }

  return { filePath: await nextAvailablePath(safeTarget, reservedTargets), skipped: false };
}

export async function ensureDirectoryWritable(folder: string): Promise<void> {
  const info = await stat(folder).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new AppError(t('error.downloadDirectoryMissing'));
  }
  await access(folder, constants.W_OK);
}

export function downloadTargetReservationKey(filePath: string): string {
  return normalizeForCompare(resolve(filePath));
}

async function nextAvailablePath(
  filePath: string,
  reservedTargets?: ReadonlySet<string>
): Promise<string> {
  if (!(await exists(filePath)) && !isReservedTarget(filePath, reservedTargets)) {
    return filePath;
  }

  const parsed = parse(filePath);
  const ext = extname(parsed.base);
  const stem = ext ? parsed.base.slice(0, -ext.length) : parsed.base;
  for (let index = 1; index < 10000; index += 1) {
    const candidate = join(dirname(filePath), `${stem} (${index})${ext}`);
    if (!(await exists(candidate)) && !isReservedTarget(candidate, reservedTargets)) {
      return candidate;
    }
  }

  throw new AppError(t('error.downloadPathUnavailable'));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isReservedTarget(filePath: string, reservedTargets?: ReadonlySet<string>): boolean {
  return reservedTargets?.has(downloadTargetReservationKey(filePath)) ?? false;
}

function normalizeForCompare(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}
