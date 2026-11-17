import type { AppearanceSettings, SecuritySettings, TransferSettings } from './types';

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
