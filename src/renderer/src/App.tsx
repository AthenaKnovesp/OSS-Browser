import { ConfigProvider, App as AntApp, message, theme } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { MainLayout } from './layouts/MainLayout';
import { useAppStore } from './stores/appStore';
import { useLogStore } from './stores/logStore';
import { useObjectStore } from './stores/objectStore';
import { useTaskStore } from './stores/taskStore';
import type { LogEntry } from '@shared/types';
import {
  resolveLanguagePreference,
  setI18nLanguage,
  translate
} from '@shared/i18n';
import './styles.css';

export default function RootApp(): React.JSX.Element {
  if (!window.ossApi) {
    return <PreloadError />;
  }

  return <BootstrappedApp />;
}

function PreloadError(): React.JSX.Element {
  const language = resolveLanguagePreference('system', navigator.language);
  return (
    <div className="preload-error">
      <h1>OSS Browser</h1>
      <p>{translate(language, 'app.preloadMissing')}</p>
      <p>{translate(language, 'app.preloadHelp')}</p>
    </div>
  );
}

function BootstrappedApp(): React.JSX.Element {
  const { config, setConfig } = useAppStore(
    useShallow((state) => ({
      config: state.config,
      setConfig: state.setConfig
    }))
  );
  const { loadLogs, addLog } = useLogStore(
    useShallow((state) => ({
      loadLogs: state.loadLogs,
      addLog: state.addLog
    }))
  );
  const { loadTasks, upsertTask } = useTaskStore(
    useShallow((state) => ({
      loadTasks: state.loadTasks,
      upsertTask: state.upsertTask
    }))
  );
  const [bootReady, setBootReady] = useState(false);
  const language = resolveLanguagePreference(config?.appearanceSettings.language, navigator.language);
  const antdLocale = language === 'zh-CN' ? zhCN : enUS;

  useEffect(() => {
    let canceled = false;
    void Promise.all([
      window.ossApi.getConfig().then(setConfig),
      loadLogs(),
      loadTasks()
    ])
      .catch((error) => message.error(error.message))
      .finally(() => {
        if (!canceled) {
          setBootReady(true);
        }
    });
    const offLog = window.ossApi.onLogAdded(addLog);
    const offTask = window.ossApi.onTaskUpdated((task) => {
      upsertTask(task);
      if (
        (task.status === 'success' || task.status === 'partial_success') &&
        ['upload', 'delete', 'copy', 'move', 'rename'].includes(task.type)
      ) {
        const { currentBucket, currentConnectionId, currentPrefix, loadObjects } =
          useObjectStore.getState();
        if (
          currentBucket &&
          task.connectionId === currentConnectionId &&
          (task.source.startsWith(`${currentBucket}/`) || task.target.startsWith(`${currentBucket}/`))
        ) {
          void loadObjects(currentBucket, currentPrefix, currentConnectionId).catch((error) =>
            message.error(error.message)
          );
        }
      }
    });
    return () => {
      canceled = true;
      offLog();
      offTask();
    };
  }, [addLog, loadLogs, loadTasks, setConfig, upsertTask]);

  useEffect(() => {
    setI18nLanguage(language);
    dayjs.locale(language === 'zh-CN' ? 'zh-cn' : 'en');
  }, [language]);

  useEffect(() => {
    const addRendererError = (messageText: string, detail?: string): void => {
      addLog({
        id: `renderer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        level: 'error',
        message: messageText,
        detail,
        module: 'Renderer'
      });
    };
    const onError = (event: ErrorEvent): void => {
      const location = event.filename
        ? `${event.filename}:${event.lineno}:${event.colno}`
        : undefined;
      const detail = [stringifyErrorDetail(event.error), location].filter(Boolean).join('\n');
      addRendererError(event.message || translate(language, 'app.rendererError'), detail || undefined);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
      const reason = event.reason;
      const messageText =
        reason instanceof Error ? reason.message : translate(language, 'app.unhandledPromise');
      addRendererError(messageText, stringifyErrorDetail(reason));
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, [addLog, language]);

  return (
    <ConfigProvider
      locale={antdLocale}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#3f7fd8',
          colorBgBase: '#f6f8fb',
          colorBgContainer: '#ffffff',
          colorBorder: '#dde5ee',
          colorText: '#1f2937',
          colorTextSecondary: '#607086',
          colorBgElevated: '#ffffff',
          colorFillSecondary: '#f1f5f9',
          fontFamily:
            '"Segoe UI", "Microsoft YaHei UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
          borderRadius: 7,
          fontSize: config?.compactMode ? 12 : 14,
          fontSizeSM: config?.compactMode ? 11 : 13,
          lineHeight: 1.45
        },
        components: {
          Button: {
            defaultBg: '#ffffff',
            defaultBorderColor: '#d5dde8',
            defaultColor: '#1f2937',
            primaryShadow: 'none'
          },
          Input: {
            activeBg: '#ffffff',
            colorBgContainer: '#ffffff',
            hoverBorderColor: '#7bb7f0'
          },
          Modal: {
            contentBg: '#ffffff',
            headerBg: '#ffffff'
          },
          Table: {
            headerBg: '#f8fafc',
            headerColor: '#475569',
            rowHoverBg: '#f1f6fd',
            borderColor: '#dde5ee'
          },
          Layout: {
            bodyBg: '#f6f8fb',
            headerBg: '#ffffff',
            footerBg: '#ffffff',
            siderBg: '#ffffff'
          }
        }
      }}
    >
      <AntApp>
        {bootReady ? <MainLayout /> : <div className="app-boot-screen" />}
      </AntApp>
    </ConfigProvider>
  );
}

function stringifyErrorDetail(error: unknown): LogEntry['detail'] {
  if (!error) return undefined;
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'string') return error;

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

