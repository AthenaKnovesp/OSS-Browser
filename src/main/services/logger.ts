import type { LogEntry, LogLevel, LogModule, S3OperationStatus, TaskStats } from '@shared/types';
import { t } from '@shared/i18n';

interface LogMetadata {
  module?: LogModule;
  taskId?: string;
  bucket?: string;
  keySummary?: string;
}

export class Logger {
  private logs: LogEntry[] = [];
  private onAdded?: (log: LogEntry) => void;

  setEmitter(emitter: (log: LogEntry) => void): void {
    this.onAdded = emitter;
  }

  list(): LogEntry[] {
    return [...this.logs].sort((a, b) => safeText(a.timestamp).localeCompare(safeText(b.timestamp)));
  }

  async clear(): Promise<void> {
    this.logs = [];
  }

  info(message: string, detail?: string, module?: LogModule): void {
    void this.write('info', message, detail, undefined, undefined, undefined, { module });
  }

  warn(message: string, detail?: string, module?: LogModule): void {
    void this.write('warn', message, detail, undefined, undefined, undefined, { module });
  }

  error(message: string, detail?: string, module?: LogModule): void {
    void this.write('error', message, detail, undefined, undefined, undefined, { module });
  }

  success(message: string, detail?: string, module?: LogModule): void {
    void this.write('success', message, detail, undefined, undefined, undefined, { module });
  }

  operation(
    operation: string,
    status: S3OperationStatus,
    message: string,
    stats?: Partial<TaskStats>,
    detail?: string,
    metadata?: LogMetadata
  ): void {
    const level = status === 'failed' ? 'error' : status === 'partial_success' ? 'warn' : status === 'success' ? 'success' : 'info';
    void this.write(level, message, detail, operation, status, stats, metadata);
  }

  clearEmitter(): void {
    this.onAdded = undefined;
  }

  private write(
    level: LogLevel,
    message: string,
    detail?: string,
    operation?: string,
    operationStatus?: S3OperationStatus,
    stats?: Partial<TaskStats>,
    metadata?: LogMetadata
  ): void {
    const log: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      message: sanitizeLogText(message) ?? '',
      detail: sanitizeLogText(detail),
      operation,
      operationStatus,
      stats,
      module: metadata?.module ?? inferLogModule(operation),
      taskId: sanitizeLogText(metadata?.taskId),
      bucket: sanitizeLogText(metadata?.bucket),
      keySummary: sanitizeLogText(metadata?.keySummary)
    };

    this.logs.push(log);
    if (this.logs.length > 5000) {
      this.logs = this.logs.slice(-5000);
    }
    this.onAdded?.(log);
  }
}

export function sanitizeLogText(value?: string): string | undefined {
  if (!value) {
    return value;
  }

  return value
    .replace(/https?:\/\/[^\s"'<>]*X-Amz-Signature=[^\s"'<>]*/gi, t('logger.redactedSignedUrl'))
    .replace(/([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s"'<>]+/gi, `$1${t('logger.redacted')}`)
    .replace(
      /\b(accessKeyId|secretAccessKey|sessionToken|Authorization|X-Amz-Signature|X-Amz-Credential)\b(["'\s:=]+)([^&\s"',}\]]+)/gi,
      `$1$2${t('logger.redacted')}`
    )
    .replace(/\b(AWS4-HMAC-SHA256 Credential=)[^,\s]+/gi, `$1${t('logger.redacted')}`);
}

function inferLogModule(operation?: string): LogModule | undefined {
  if (!operation) {
    return undefined;
  }
  if (operation.toLowerCase().startsWith('task')) {
    return 'Task';
  }
  if (
    [
      'listBuckets',
      'listObjects',
      'listFolders',
      'createFolder',
      'metadata',
      'generateUrl',
      'uploadObject',
      'uploadDirectory',
      'downloadObject',
      'deleteObjects',
      'copyObject',
      'copyPrefix',
      'moveObject',
      'movePrefix'
    ].includes(operation)
  ) {
    return 'S3';
  }
  return undefined;
}

function safeText(value: string | undefined): string {
  return value ?? '';
}
