import { S3Client, type ServiceInputTypes, type ServiceOutputTypes } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { BuildMiddleware } from '@smithy/types';
import { createHash } from 'node:crypto';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { t } from '@shared/i18n';
import type { ConnectionConfig } from '@shared/types';
import { AppError } from './error';

const REQUEST_TIMEOUT_MS = 120000;
const CONNECTION_TIMEOUT_MS = 10000;
const MAX_HTTP_SOCKETS = 128;
const EMPTY_BODY_CONTENT_MD5 = '1B2M2Y8AsgTpgAmY7PhCfg==';

interface HeaderRequest {
  headers?: Record<string, string>;
  body?: unknown;
}

export function createS3Client(config: ConnectionConfig): S3Client {
  const endpoint = config.endpoint.match(/^https?:\/\//)
    ? config.endpoint
    : `${config.ssl ? 'https' : 'http'}://${config.endpoint}`;

  const client = new S3Client({
    endpoint,
    region: config.region || 'us-east-1',
    forcePathStyle: config.forcePathStyle,
    retryMode: 'standard',
    maxAttempts: 3,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey ?? '',
      sessionToken: config.sessionToken || undefined
    },
    requestHandler: new NodeHttpHandler({
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      socketTimeout: REQUEST_TIMEOUT_MS,
      httpAgent: new HttpAgent({ keepAlive: true, maxSockets: MAX_HTTP_SOCKETS }),
      httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: MAX_HTTP_SOCKETS })
    })
  });
  installDeleteContentMd5Middleware(client);
  return client;
}

export function s3ClientKey(config: ConnectionConfig): string {
  return [
    config.id,
    config.endpoint,
    config.region,
    config.accessKeyId,
    config.secretAccessKey,
    config.sessionToken,
    config.forcePathStyle,
    config.ssl,
    config.checksumAlgorithm
  ].join('|');
}

function installDeleteContentMd5Middleware(client: S3Client): void {
  const deleteContentMd5Middleware: BuildMiddleware<ServiceInputTypes, ServiceOutputTypes> =
    (next, context) => async (args) => {
      if (
        context.commandName !== 'DeleteObjectCommand' &&
        context.commandName !== 'DeleteObjectsCommand'
      ) {
        return next(args);
      }

      const request = args.request as HeaderRequest;
      request.headers ??= {};
      if (!hasHeader(request.headers, 'content-md5')) {
        request.headers['content-md5'] =
          context.commandName === 'DeleteObjectCommand'
            ? EMPTY_BODY_CONTENT_MD5
            : contentMd5ForBody(request.body);
      }
      return next(args);
    };

  client.middlewareStack.add(deleteContentMd5Middleware, {
    step: 'build',
    name: 'deleteContentMd5Middleware',
    tags: ['CONTENT_MD5', 'S3_COMPATIBLE_DELETE'],
    override: true
  });
}

function hasHeader(headers: Record<string, string>, headerName: string): boolean {
  const expected = headerName.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}

function contentMd5ForBody(body: unknown): string {
  if (body === undefined || body === null) {
    return EMPTY_BODY_CONTENT_MD5;
  }
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return createHash('md5').update(body).digest('base64');
  }
  throw new AppError(
    t('error.deleteMd5Failed'),
    t('error.unsupportedDeleteBodyType', { type: typeof body })
  );
}
