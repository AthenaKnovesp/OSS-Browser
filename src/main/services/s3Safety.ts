import { relative, sep } from 'node:path';
import { t } from '@shared/i18n';
import { AppError } from './error';

const MAX_S3_KEY_BYTES = 1024;

export interface KeyValidationOptions {
  allowEmpty?: boolean;
  allowTrailingSlash?: boolean;
}

export interface S3MoveTarget {
  sourceBucket: string;
  sourceKey: string;
  targetBucket: string;
  targetKey: string;
}

export function assertBucketName(bucket: unknown): string {
  if (typeof bucket !== 'string' || !bucket.trim()) {
    throw new AppError(t('error.bucketRequired'));
  }

  const normalized = bucket.trim();
  if (normalized.includes('/') || normalized.includes('\\') || containsControlChars(normalized)) {
    throw new AppError(t('error.bucketInvalid'));
  }

  return normalized;
}

export function normalizeS3Prefix(prefix: unknown): string {
  if (prefix === undefined || prefix === null) {
    return '';
  }
  if (typeof prefix !== 'string') {
    throw new AppError(t('error.prefixString'));
  }

  const normalized = prefix.trim().replaceAll('\\', '/');
  if (!normalized) {
    return '';
  }

  const withSlash = normalized.endsWith('/') ? normalized : `${normalized}/`;
  assertS3Key(withSlash, { allowTrailingSlash: true });
  return withSlash;
}

export function joinS3Key(prefix: string, name: string): string {
  const normalizedPrefix = normalizeS3Prefix(prefix);
  const normalizedName = name.replaceAll('\\', '/').replace(/^\/+/, '');
  const key = `${normalizedPrefix}${normalizedName}`;
  assertS3Key(key, { allowTrailingSlash: false });
  return key;
}

export function assertS3Key(key: unknown, options: KeyValidationOptions = {}): string {
  if (typeof key !== 'string') {
    throw new AppError(t('error.keyString'));
  }

  const normalized = key.trim().replaceAll('\\', '/');
  if (!normalized && !options.allowEmpty) {
    throw new AppError(t('error.keyRequired'));
  }
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('/')) {
    throw new AppError(t('error.keyLeadingSlash'));
  }
  if (!options.allowTrailingSlash && normalized.endsWith('/')) {
    throw new AppError(t('error.fileKeyTrailingSlash'));
  }
  if (normalized.includes('//')) {
    throw new AppError(t('error.keyDuplicateSlash'));
  }
  if (containsControlChars(normalized)) {
    throw new AppError(t('error.keyControlChars'));
  }
  if (Buffer.byteLength(normalized, 'utf8') > MAX_S3_KEY_BYTES) {
    throw new AppError(t('error.keyTooLong'));
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new AppError(t('error.keyDotSegment'));
  }

  return normalized;
}

export function assertS3MoveTarget(
  sourceBucket: unknown,
  sourceKey: unknown,
  targetBucket: unknown,
  targetKey: unknown
): S3MoveTarget {
  const safeSourceBucket = assertBucketName(sourceBucket);
  const safeTargetBucket = assertBucketName(targetBucket);
  const safeSourceKey = assertS3Key(sourceKey, { allowTrailingSlash: true });
  const safeTargetKey = assertS3Key(targetKey, { allowTrailingSlash: true });

  if (safeSourceBucket === safeTargetBucket) {
    if (safeSourceKey === safeTargetKey) {
      throw new AppError(t('error.targetSameAsSource'));
    }
    if (safeSourceKey.endsWith('/') && safeTargetKey.startsWith(safeSourceKey)) {
      throw new AppError(t('error.folderMoveIntoSelf'));
    }
  }

  return {
    sourceBucket: safeSourceBucket,
    sourceKey: safeSourceKey,
    targetBucket: safeTargetBucket,
    targetKey: safeTargetKey
  };
}

export function encodeCopySource(bucket: string, key: string): string {
  const safeBucket = assertBucketName(bucket);
  const safeKey = assertS3Key(key, { allowTrailingSlash: true });
  return `${encodeURIComponent(safeBucket)}/${safeKey.split('/').map(encodeURIComponent).join('/')}`;
}

export function relativePathToS3Key(rootPath: string, filePath: string): string {
  const relativePath = relative(rootPath, filePath);
  if (!relativePath || relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
    throw new AppError(t('error.uploadPathOutsideFolder'));
  }

  const key = relativePath.split(sep).join('/');
  return assertS3Key(key);
}

export function replaceKeyPrefix(sourceKey: string, sourcePrefix: string, targetPrefix: string): string {
  const safeSourceKey = assertS3Key(sourceKey, { allowTrailingSlash: true });
  const safeSourcePrefix = normalizeS3Prefix(sourcePrefix);
  const safeTargetPrefix = normalizeS3Prefix(targetPrefix);
  if (!safeSourceKey.startsWith(safeSourcePrefix)) {
    throw new AppError(t('error.sourceNotInPrefix'));
  }

  const relativeKey = safeSourceKey.slice(safeSourcePrefix.length);
  return assertS3Key(`${safeTargetPrefix}${relativeKey}`, { allowTrailingSlash: true });
}

function containsControlChars(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
