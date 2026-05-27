import { t } from '@shared/i18n';
import type { TaskFailureCategory, TaskFailureInfo } from '@shared/types';

export class AppError extends Error {
  constructor(
    message: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class PartialOperationError extends AppError {
  constructor(message: string, detail?: string) {
    super(message, detail);
    this.name = 'PartialOperationError';
  }
}

export function normalizeError(error: unknown, fallback = t('error.operationFailed')): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    const shape = errorShape(error);
    return new AppError(mapFriendlyMessage(shape, fallback), formatErrorDetail(shape));
  }

  return new AppError(fallback, String(error));
}

export function classifyError(error: unknown): TaskFailureCategory {
  const { name, code, message, statusCode } = errorShape(error);
  const text = `${name} ${code ?? ''} ${message}`.toLowerCase();

  if (
    text.includes('aborted') ||
    text.includes('abort') ||
    text.includes('任务已取消') ||
    text.includes('task canceled')
  ) {
    return 'user_canceled';
  }
  if (
    text.includes('getaddrinfo') ||
    text.includes('enotfound') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('socket hang up') ||
    text.includes('network') ||
    text.includes('timeout') ||
    text.includes('timed out')
  ) {
    return 'network';
  }
  if (
    text.includes('invalidaccesskeyid') ||
    text.includes('signaturedoesnotmatch') ||
    text.includes('signature') ||
    statusCode === 401
  ) {
    return 'auth';
  }
  if (
    text.includes('accessdenied') ||
    text.includes('forbidden') ||
    text.includes('permission') ||
    statusCode === 403
  ) {
    return 'permission';
  }
  if (
    text.includes('nosuchbucket') ||
    text.includes('nosuchkey') ||
    text.includes('notfound') ||
    statusCode === 404
  ) {
    return 'not_found';
  }
  if (
    text.includes('already exists') ||
    text.includes('目标已存在') ||
    text.includes('already exists') ||
    text.includes('conflict') ||
    statusCode === 409 ||
    statusCode === 412
  ) {
    return 'conflict';
  }
  if (
    text.includes('路径') ||
    text.includes('path') ||
    text.includes('eacces') ||
    text.includes('eperm') ||
    text.includes('ebusy')
  ) {
    return 'path_safety';
  }
  if (
    text.includes('checksum algorithm') ||
    text.includes('baddigest') ||
    text.includes('invalidpart') ||
    text.includes('entitytoosmall') ||
    text.includes('sha256') ||
    text.includes('content-md5') ||
    text.includes('notimplemented')
  ) {
    return 's3_compatibility';
  }
  return 'unknown';
}

export function isRetryableError(error: unknown): boolean {
  const { message, statusCode } = errorShape(error);
  const text = message.toLowerCase();
  if (statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
    return true;
  }
  return (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('socket hang up') ||
    text.includes('temporarily unavailable')
  );
}

export function buildFailureInfo(
  error: unknown,
  retryable = isRetryableError(error),
  retryAfterMs?: number
): TaskFailureInfo {
  const normalized = normalizeError(error);
  return {
    category: classifyError(error),
    message: normalized.message,
    detail: normalized.detail,
    retryable,
    retryAfterMs,
    occurredAt: new Date().toISOString()
  };
}

function mapFriendlyMessage(error: ErrorShape, fallback: string): string {
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();
  const code = error.code?.toLowerCase() ?? '';

  if (message.includes('getaddrinfo') || message.includes('enotfound')) {
    return t('error.endpointUnreachable');
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return t('error.networkTimeout');
  }
  if (
    name.includes('abort') ||
    message.includes('aborted') ||
    message.includes('任务已取消') ||
    message.includes('task canceled')
  ) {
    return t('error.taskCanceled');
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return t('error.requestTimeout');
  }
  if (name.includes('invalidaccesskeyid') || code.includes('invalidaccesskeyid')) {
    return t('error.invalidAccessKeyId');
  }
  if (
    name.includes('signaturedoesnotmatch') ||
    code.includes('signaturedoesnotmatch') ||
    message.includes('signature')
  ) {
    return t('error.invalidSecret');
  }
  if (message.includes('checksum algorithm') || code.includes('baddigest')) {
    if (message.includes('sha256')) {
      return t('error.checksumSha256');
    }
    return t('error.checksumRejected');
  }
  if (code.includes('entitytoosmall') || code.includes('invalidpart')) {
    return t('error.multipartRejected');
  }
  if (name.includes('nosuchbucket') || code.includes('nosuchbucket')) {
    return t('error.bucketNotFound');
  }
  if (name.includes('nosuchkey') || name.includes('notfound') || code.includes('nosuchkey')) {
    return t('error.objectNotFound');
  }
  if (
    name.includes('accessdenied') ||
    code.includes('accessdenied') ||
    message.includes('forbidden')
  ) {
    return t('error.permissionDenied');
  }
  if (message.includes('ebusy') || message.includes('eperm')) {
    return t('error.localFileBusy');
  }
  if (message.includes('eacces')) {
    return t('error.downloadPathNotWritable');
  }

  if (
    (name.includes('unknownerror') ||
      code.includes('unknownerror') ||
      message === 'unknownerror') &&
    error.statusCode
  ) {
    return t('error.s3Unknown', { statusCode: error.statusCode });
  }
  if (error.statusCode === 429 || error.statusCode === 503) {
    return t('error.storageBusy');
  }
  if (error.statusCode !== undefined && error.statusCode >= 500) {
    return t('error.storageServer', { statusCode: error.statusCode });
  }
  if (error.statusCode !== undefined && error.statusCode >= 400) {
    return t('error.s3Failed', { statusCode: error.statusCode });
  }

  return error.message || fallback;
}

interface ErrorShape {
  name: string;
  code?: string;
  message: string;
  statusCode?: number;
  requestId?: string;
  extendedRequestId?: string;
  cfId?: string;
  attempts?: number;
}

function errorShape(error: unknown): ErrorShape {
  if (error instanceof AppError) {
    return { name: error.name, message: `${error.message} ${error.detail ?? ''}` };
  }
  if (error instanceof Error) {
    const metadata = awsMetadata(error);
    return {
      name: error.name,
      code: awsErrorCode(error),
      message: error.message,
      statusCode: metadata.httpStatusCode,
      requestId: metadata.requestId,
      extendedRequestId: metadata.extendedRequestId,
      cfId: metadata.cfId,
      attempts: metadata.attempts
    };
  }
  return { name: '', message: String(error) };
}

function formatErrorDetail(error: ErrorShape): string {
  const parts = [`${error.name ? `${error.name}: ` : ''}${error.message}`];
  if (error.code && error.code !== error.name) {
    parts.push(`code=${error.code}`);
  }
  if (error.statusCode !== undefined) {
    parts.push(`httpStatus=${error.statusCode}`);
  }
  if (error.requestId) {
    parts.push(`requestId=${error.requestId}`);
  }
  if (error.extendedRequestId) {
    parts.push(`extendedRequestId=${error.extendedRequestId}`);
  }
  if (error.cfId) {
    parts.push(`cfId=${error.cfId}`);
  }
  if (error.attempts !== undefined) {
    parts.push(`attempts=${error.attempts}`);
  }
  return parts.join('；');
}

function awsErrorCode(error: Error): string | undefined {
  const shaped = error as { Code?: unknown; code?: unknown };
  if (typeof shaped.Code === 'string') {
    return shaped.Code;
  }
  if (typeof shaped.code === 'string') {
    return shaped.code;
  }
  return undefined;
}

function awsMetadata(error: Error): {
  httpStatusCode?: number;
  requestId?: string;
  extendedRequestId?: string;
  cfId?: string;
  attempts?: number;
} {
  const metadata = (
    error as {
      $metadata?: {
        httpStatusCode?: unknown;
        requestId?: unknown;
        extendedRequestId?: unknown;
        cfId?: unknown;
        attempts?: unknown;
      };
    }
  ).$metadata;
  return {
    httpStatusCode:
      typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined,
    requestId: typeof metadata?.requestId === 'string' ? metadata.requestId : undefined,
    extendedRequestId:
      typeof metadata?.extendedRequestId === 'string' ? metadata.extendedRequestId : undefined,
    cfId: typeof metadata?.cfId === 'string' ? metadata.cfId : undefined,
    attempts: typeof metadata?.attempts === 'number' ? metadata.attempts : undefined
  };
}
