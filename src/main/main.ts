import { app, BrowserWindow, shell } from 'electron';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC_CHANNELS } from '@shared/ipc';
import { resolveLanguagePreference, setI18nLanguage, t } from '@shared/i18n';
import { registerIpc } from './ipc/registerIpc';
import { Logger } from './services/logger';
import { S3Service } from './services/s3Service';
import { TaskManager } from './services/taskManager';
import { ConfigStore } from './store/configStore';

configureChromiumRuntime();

const logger = new Logger();
const configStore = new ConfigStore();
const s3Service = new S3Service(logger);
const taskManager = new TaskManager(s3Service, logger);
let shutdownPromise: Promise<void> | undefined;
let shutdownCompleted = false;

async function createWindow(): Promise<void> {
  const rendererUrl =
    process.env.ELECTRON_RENDERER_URL ??
    pathToFileURL(join(__dirname, '../renderer/index.html')).toString();
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'OSS Browser',
    icon: join(__dirname, '../../build/icon.ico'),
    frame: false,
    show: false,
    backgroundColor: '#f6f8fb',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppNavigation(url, rendererUrl)) {
      return;
    }

    event.preventDefault();
    openExternalUrl(url);
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error(t('main.preloadFailed', { path: preloadPath }), error.stack ?? error.message);
  });

  logger.setEmitter((log) => {
    if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.LOG_ADDED, log);
    }
  });
  taskManager.setEmitter((task) => {
    if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.TASK_UPDATED, task);
    }
  });

  mainWindow.on('close', () => {
    void shutdownResources();
  });
  mainWindow.on('closed', () => {
    taskManager.clearEmitter();
    logger.clearEmitter();
  });

  registerIpc({
    window: mainWindow,
    configStore,
    s3Service,
    taskManager,
    logger
  });

  const config = await configStore.clearActiveConnection();
  setI18nLanguage(resolveLanguagePreference(config.appearanceSettings.language, app.getLocale()));
  taskManager.setConcurrentTransfers(config.transferSettings.concurrentTransfers);

  if (rendererUrl.startsWith('http')) {
    await mainWindow.loadURL(rendererUrl);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.setAppUserModelId('com.ossbrowser.desktop');

app.whenReady().then(async () => {
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  void shutdownResources();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (shutdownCompleted) {
    return;
  }

  event.preventDefault();
  void shutdownResources().finally(() => {
    shutdownCompleted = true;
    app.quit();
  });
});

function openExternalUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      logger.warn(t('main.blockedUnsafeUrl', { url }));
      return;
    }

    void shell.openExternal(url);
  } catch {
    logger.warn(t('main.blockedInvalidUrl', { url }));
  }
}

function isAppNavigation(url: string, rendererUrl: string): boolean {
  return url.startsWith(rendererUrl);
}

async function shutdownResources(): Promise<void> {
  shutdownPromise ??= (async () => {
    await taskManager.shutdown();
    s3Service.shutdown();
  })().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(t('main.shutdownIncomplete'), detail);
  });
  await shutdownPromise;
}

function configureChromiumRuntime(): void {
  const appearanceSettings = readStartupAppearanceSettings();
  const cachePath = join(app.getPath('userData'), 'ChromiumCache');
  mkdirSync(cachePath, { recursive: true });
  app.commandLine.appendSwitch('disk-cache-dir', cachePath);
  app.commandLine.appendSwitch('media-cache-dir', cachePath);

  if (appearanceSettings.disableHardwareAcceleration) {
    app.disableHardwareAcceleration();
  }
  if (appearanceSettings.disableGpuShaderDiskCache) {
    app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  }

  const sessionDataPath = join(app.getPath('userData'), 'SessionData');
  mkdirSync(sessionDataPath, { recursive: true });
  app.setPath('sessionData', sessionDataPath);
}

interface StartupAppearanceSettings {
  disableHardwareAcceleration: boolean;
  disableGpuShaderDiskCache: boolean;
}

function readStartupAppearanceSettings(): StartupAppearanceSettings {
  const defaults: StartupAppearanceSettings = {
    disableHardwareAcceleration: false,
    disableGpuShaderDiskCache: false
  };

  try {
    const content = readFileSync(join(app.getPath('userData'), 'config.json'), 'utf8');
    const parsed = JSON.parse(content) as {
      appearanceSettings?: Partial<StartupAppearanceSettings>;
    };
    return {
      disableHardwareAcceleration:
        typeof parsed.appearanceSettings?.disableHardwareAcceleration === 'boolean'
          ? parsed.appearanceSettings.disableHardwareAcceleration
          : defaults.disableHardwareAcceleration,
      disableGpuShaderDiskCache:
        typeof parsed.appearanceSettings?.disableGpuShaderDiskCache === 'boolean'
          ? parsed.appearanceSettings.disableGpuShaderDiskCache
          : defaults.disableGpuShaderDiskCache
    };
  } catch {
    return defaults;
  }
}
