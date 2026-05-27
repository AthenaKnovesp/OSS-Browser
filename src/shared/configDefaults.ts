import type { AppConfig, AppearanceSettings, SecuritySettings, TransferSettings } from './types';

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  defaultDownloadFolder: '',
  concurrentTransfers: 3,
  multipartConcurrency: 4,
  chunkSizeMb: 8,
  retryCount: 2,
  overwritePolicy: 'ask'
};

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  rememberCredentialsLocally: true,
  requireConfirmationBeforeDelete: true
};

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  language: 'system',
  disableHardwareAcceleration: false,
  disableGpuShaderDiskCache: false
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  connections: [],
  compactMode: false,
  transferSettings: DEFAULT_TRANSFER_SETTINGS,
  securitySettings: DEFAULT_SECURITY_SETTINGS,
  appearanceSettings: DEFAULT_APPEARANCE_SETTINGS
};
