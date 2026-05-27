import { app, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_APP_CONFIG,
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_SECURITY_SETTINGS,
  DEFAULT_TRANSFER_SETTINGS
} from '@shared/configDefaults';
import { normalizeLanguagePreference, t } from '@shared/i18n';
import type { AppConfig, ConnectionConfig } from '@shared/types';

type StoredConnection = Omit<
  ConnectionConfig,
  'secretAccessKey' | 'sessionToken' | 'hasSecretAccessKey'
> & {
  secretAccessKeyEncrypted?: string;
  sessionTokenEncrypted?: string;
};

type StoredConfig = Omit<AppConfig, 'connections'> & {
  connections: StoredConnection[];
};

export class ConfigStore {
  private cache?: AppConfig;

  async get(): Promise<AppConfig> {
    return this.redact(await this.getRaw());
  }

  async getRaw(): Promise<AppConfig> {
    if (this.cache) {
      return structuredClone(this.cache);
    }

    const stored = await this.readStored();
    const config: AppConfig = {
      ...DEFAULT_APP_CONFIG,
      ...stored,
      connections: stored.connections.map(
        ({ secretAccessKeyEncrypted, sessionTokenEncrypted, ...connection }) => ({
          ...connection,
          secretAccessKey: this.decrypt(secretAccessKeyEncrypted),
          sessionToken: this.decrypt(sessionTokenEncrypted)
        })
      ),
      transferSettings: {
        ...DEFAULT_TRANSFER_SETTINGS,
        ...stored.transferSettings
      },
      securitySettings: {
        ...DEFAULT_SECURITY_SETTINGS,
        ...stored.securitySettings
      },
      appearanceSettings: {
        ...DEFAULT_APPEARANCE_SETTINGS,
        ...stored.appearanceSettings
      }
    };

    this.cache = config;
    return structuredClone(config);
  }

  async saveConnection(connection: ConnectionConfig): Promise<AppConfig> {
    const config = await this.getRaw();
    const now = new Date().toISOString();
    const existing = config.connections.find((item) => item.id === connection.id);
    const submittedSecret = this.normalizeSubmittedSecret(connection.secretAccessKey);
    const submittedSessionToken = this.normalizeSubmittedSecret(connection.sessionToken);
    const normalized: ConnectionConfig = {
      ...connection,
      secretAccessKey: submittedSecret ?? existing?.secretAccessKey,
      sessionToken: submittedSessionToken ?? existing?.sessionToken,
      id: connection.id || crypto.randomUUID(),
      createdAt: connection.createdAt || now,
      updatedAt: now
    };

    const index = config.connections.findIndex((item) => item.id === normalized.id);
    if (index >= 0) {
      config.connections[index] = normalized;
    } else {
      config.connections.push(normalized);
    }

    await this.save(config);
    return this.redact(config);
  }

  async setActiveConnection(connectionId: string): Promise<AppConfig> {
    const config = await this.getRaw();
    if (!config.connections.some((item) => item.id === connectionId)) {
      throw new Error(t('config.connectionMissing'));
    }
    config.activeConnectionId = connectionId;
    await this.save(config);
    return this.redact(config);
  }

  async deleteConnection(connectionId: string): Promise<AppConfig> {
    const config = await this.getRaw();
    const index = config.connections.findIndex((item) => item.id === connectionId);
    if (index < 0) {
      throw new Error(t('config.connectionMissing'));
    }

    config.connections.splice(index, 1);
    if (config.activeConnectionId === connectionId) {
      delete config.activeConnectionId;
    }

    await this.save(config);
    return this.redact(config);
  }

  async saveSettings(partial: Partial<AppConfig>): Promise<AppConfig> {
    const config = await this.getRaw();
    const next: AppConfig = {
      connections: config.connections,
      activeConnectionId: config.activeConnectionId,
      compactMode: partial.compactMode ?? config.compactMode,
      transferSettings: normalizeTransferSettings({
        ...config.transferSettings,
        ...partial.transferSettings
      }),
      securitySettings: {
        ...config.securitySettings,
        ...partial.securitySettings
      },
      appearanceSettings: {
        ...config.appearanceSettings,
        ...partial.appearanceSettings
      }
    };
    await this.save(next);
    return this.redact(next);
  }

  async clearActiveConnection(): Promise<AppConfig> {
    const config = await this.getRaw();
    delete config.activeConnectionId;
    await this.save(config);
    return this.redact(config);
  }

  async getActiveConnection(): Promise<ConnectionConfig> {
    const config = await this.getRaw();
    const active = config.connections.find((item) => item.id === config.activeConnectionId);

    if (!active) {
      throw new Error(t('config.selectConnectionFirst'));
    }

    if (!active.secretAccessKey) {
      throw new Error(t('config.secretMissing'));
    }

    return active;
  }

  async mergeWithStoredSecret(connection: ConnectionConfig): Promise<ConnectionConfig> {
    const config = await this.getRaw();
    const existing = config.connections.find((item) => item.id === connection.id);
    const submittedSecret = this.normalizeSubmittedSecret(connection.secretAccessKey);
    const submittedSessionToken = this.normalizeSubmittedSecret(connection.sessionToken);
    return {
      ...connection,
      secretAccessKey: submittedSecret ?? existing?.secretAccessKey,
      sessionToken: submittedSessionToken ?? existing?.sessionToken
    };
  }

  getConfigFilePath(): string {
    return this.filePath();
  }

  private async save(config: AppConfig): Promise<void> {
    this.cache = structuredClone(config);
    const stored: StoredConfig = {
      activeConnectionId: config.activeConnectionId,
      compactMode: config.compactMode,
      transferSettings: config.transferSettings,
      securitySettings: config.securitySettings,
      appearanceSettings: config.appearanceSettings,
      connections: config.connections.map((connection) =>
        this.toStoredConnection(connection, config.securitySettings.rememberCredentialsLocally)
      )
    };

    await mkdir(dirname(this.filePath()), { recursive: true });
    await writeFile(this.filePath(), JSON.stringify(stored, null, 2), 'utf8');
  }

  private async readStored(): Promise<StoredConfig> {
    try {
      const content = await readFile(this.filePath(), 'utf8');
      return normalizeStoredConfig(JSON.parse(content));
    } catch {
      const defaults = normalizeStoredConfig(undefined);
      await this.save({
        ...DEFAULT_APP_CONFIG,
        connections: []
      });
      return defaults;
    }
  }

  private filePath(): string {
    return join(app.getPath('userData'), 'config.json');
  }

  private redact(config: AppConfig): AppConfig {
    return {
      ...structuredClone(config),
      connections: config.connections.map((connection) => ({
        ...connection,
        secretAccessKey: undefined,
        sessionToken: undefined,
        hasSecretAccessKey: Boolean(connection.secretAccessKey)
      }))
    };
  }

  private normalizeSubmittedSecret(value?: string): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  private toStoredConnection(
    connection: ConnectionConfig,
    rememberCredentials: boolean
  ): StoredConnection {
    return {
      id: connection.id,
      profileName: connection.profileName,
      endpoint: connection.endpoint,
      region: connection.region,
      accessKeyId: connection.accessKeyId,
      forcePathStyle: connection.forcePathStyle,
      ssl: connection.ssl,
      defaultBucket: connection.defaultBucket,
      checksumAlgorithm: connection.checksumAlgorithm,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      secretAccessKeyEncrypted:
        rememberCredentials && connection.secretAccessKey
          ? this.encrypt(connection.secretAccessKey)
          : undefined,
      sessionTokenEncrypted:
        rememberCredentials && connection.sessionToken
          ? this.encrypt(connection.sessionToken)
          : undefined
    };
  }

  private encrypt(value: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return `safe:${safeStorage.encryptString(value).toString('base64')}`;
    }

    return `base64:${Buffer.from(value, 'utf8').toString('base64')}`;
  }

  private decrypt(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }

    try {
      if (value.startsWith('safe:') && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'));
      }

      if (value.startsWith('base64:')) {
        return Buffer.from(value.slice(7), 'base64').toString('utf8');
      }
    } catch {
      return undefined;
    }

    return undefined;
  }
}

function normalizeStoredConfig(value: unknown): StoredConfig {
  const record = isRecord(value) ? value : {};
  const activeConnectionId =
    typeof record.activeConnectionId === 'string' && record.activeConnectionId.trim()
      ? record.activeConnectionId
      : undefined;
  const connections = normalizeStoredConnections(record.connections);
  const legacyDefaultBucket =
    typeof record.defaultBucket === 'string' && record.defaultBucket.trim()
      ? record.defaultBucket.trim()
      : undefined;

  if (activeConnectionId && legacyDefaultBucket) {
    const active = connections.find((connection) => connection.id === activeConnectionId);
    if (active && !active.defaultBucket) {
      active.defaultBucket = legacyDefaultBucket;
    }
  }

  return {
    connections,
    activeConnectionId,
    compactMode:
      typeof record.compactMode === 'boolean' ? record.compactMode : DEFAULT_APP_CONFIG.compactMode,
    transferSettings: normalizeTransferSettings(record.transferSettings),
    securitySettings: normalizeSecuritySettings(record.securitySettings),
    appearanceSettings: normalizeAppearanceSettings(record.appearanceSettings)
  };
}

function normalizeStoredConnections(value: unknown): StoredConnection[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((connection) => {
    const storedConnection = { ...connection };
    delete storedConnection.secretAccessKey;
    delete storedConnection.sessionToken;
    delete storedConnection.hasSecretAccessKey;
    return storedConnection as StoredConnection;
  });
}

function normalizeTransferSettings(value: unknown): AppConfig['transferSettings'] {
  const record = isRecord(value) ? value : {};
  const overwritePolicy = record.overwritePolicy;
  return {
    defaultDownloadFolder:
      typeof record.defaultDownloadFolder === 'string'
        ? record.defaultDownloadFolder
        : DEFAULT_TRANSFER_SETTINGS.defaultDownloadFolder,
    concurrentTransfers: clampInteger(
      record.concurrentTransfers,
      1,
      16,
      DEFAULT_TRANSFER_SETTINGS.concurrentTransfers
    ),
    multipartConcurrency: clampInteger(
      record.multipartConcurrency,
      1,
      16,
      DEFAULT_TRANSFER_SETTINGS.multipartConcurrency
    ),
    chunkSizeMb: clampInteger(record.chunkSizeMb, 5, 5120, DEFAULT_TRANSFER_SETTINGS.chunkSizeMb),
    retryCount: clampInteger(record.retryCount, 0, 10, DEFAULT_TRANSFER_SETTINGS.retryCount),
    overwritePolicy:
      overwritePolicy === 'ask' || overwritePolicy === 'overwrite' || overwritePolicy === 'skip'
        ? overwritePolicy
        : DEFAULT_TRANSFER_SETTINGS.overwritePolicy
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeSecuritySettings(value: unknown): AppConfig['securitySettings'] {
  const record = isRecord(value) ? value : {};
  return {
    rememberCredentialsLocally:
      typeof record.rememberCredentialsLocally === 'boolean'
        ? record.rememberCredentialsLocally
        : DEFAULT_SECURITY_SETTINGS.rememberCredentialsLocally,
    requireConfirmationBeforeDelete:
      typeof record.requireConfirmationBeforeDelete === 'boolean'
        ? record.requireConfirmationBeforeDelete
        : DEFAULT_SECURITY_SETTINGS.requireConfirmationBeforeDelete
  };
}

function normalizeAppearanceSettings(value: unknown): AppConfig['appearanceSettings'] {
  const record = isRecord(value) ? value : {};
  return {
    language: normalizeLanguagePreference(record.language),
    disableHardwareAcceleration:
      typeof record.disableHardwareAcceleration === 'boolean'
        ? record.disableHardwareAcceleration
        : DEFAULT_APPEARANCE_SETTINGS.disableHardwareAcceleration,
    disableGpuShaderDiskCache:
      typeof record.disableGpuShaderDiskCache === 'boolean'
        ? record.disableGpuShaderDiskCache
        : DEFAULT_APPEARANCE_SETTINGS.disableGpuShaderDiskCache
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
