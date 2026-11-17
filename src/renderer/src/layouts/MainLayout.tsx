import { App, Layout, Modal } from 'antd';
import { lazy, memo, Suspense, useCallback, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { BucketTree } from '@renderer/components/BucketTree';
import { TitleBar } from './TitleBar';
import { ConnectionForm } from '@renderer/components/ConnectionForm';
import { TaskTable } from '@renderer/components/TaskTable';
import { useI18n } from '@renderer/i18n';
import { useAppStore } from '@renderer/stores/appStore';
import { useConnectionStore } from '@renderer/stores/connectionStore';
import { useTaskStore } from '@renderer/stores/taskStore';

const ExplorerPage = lazy(() =>
  import('@renderer/pages/ExplorerPage').then((module) => ({ default: module.ExplorerPage }))
);

const MIN_BOTTOM_PANEL_HEIGHT = 168;
const DEFAULT_BOTTOM_PANEL_HEIGHT = 220;
const MIN_WORKBENCH_HEIGHT = 260;

export function MainLayout(): React.JSX.Element {
  const { message } = App.useApp();
  const { t } = useI18n();
  const {
    config,
    editingConnectionId,
    settingsMode,
    settingsOpen,
    setConfig,
    setEditingConnectionId,
    setSettingsOpen
  } = useAppStore(
    useShallow((state) => ({
      config: state.config,
      editingConnectionId: state.editingConnectionId,
      settingsMode: state.settingsMode,
      settingsOpen: state.settingsOpen,
      setConfig: state.setConfig,
      setEditingConnectionId: state.setEditingConnectionId,
      setSettingsOpen: state.setSettingsOpen
    }))
  );
  const workspaceRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(DEFAULT_BOTTOM_PANEL_HEIGHT);

  const bottomPanelMaxHeight = useCallback((): number => {
    const workspaceHeight =
      workspaceRef.current?.getBoundingClientRect().height ?? window.innerHeight - 52;
    return Math.max(
      MIN_BOTTOM_PANEL_HEIGHT,
      Math.floor(Math.min(workspaceHeight * 0.48, workspaceHeight - MIN_WORKBENCH_HEIGHT - 12))
    );
  }, []);

  const handleSettingsSaved = useCallback(
    (nextConfig: NonNullable<typeof config>): void => {
      setConfig(nextConfig);
      setSettingsOpen(false);
      setEditingConnectionId(undefined);
      if (settingsMode === 'connection' && editingConnectionId === nextConfig.activeConnectionId) {
        void useConnectionStore
          .getState()
          .loadBuckets(nextConfig.activeConnectionId)
          .catch((error) => message.error(error.message));
      }
    },
    [editingConnectionId, settingsMode, setConfig, setEditingConnectionId, setSettingsOpen, message]
  );

  const handleSettingsCancel = useCallback((): void => {
    setSettingsOpen(false);
    setEditingConnectionId(undefined);
  }, [setEditingConnectionId, setSettingsOpen]);

  const connection = config?.connections.find((item) => item.id === config.activeConnectionId);
  const explorerKey = `${connection?.id ?? 'no-connection'}:${connection?.updatedAt ?? ''}`;

  const beginBottomPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return;
      event.preventDefault();

      const startY = event.clientY;
      const startHeight = bottomPanelHeight;
      const maxHeight = bottomPanelMaxHeight();
      let nextHeight = startHeight;
      let frameId: number | undefined;
      const applyFooterHeight = (height: number): void => {
        if (!footerRef.current) return;
        footerRef.current.style.flexBasis = `${height}px`;
        footerRef.current.style.height = `${height}px`;
      };
      const onPointerMove = (moveEvent: PointerEvent): void => {
        nextHeight = Math.round(
          Math.min(
            Math.max(startHeight + startY - moveEvent.clientY, MIN_BOTTOM_PANEL_HEIGHT),
            maxHeight
          )
        );
        if (frameId !== undefined) {
          return;
        }
        frameId = window.requestAnimationFrame(() => {
          frameId = undefined;
          applyFooterHeight(nextHeight);
        });
      };
      const onPointerUp = (): void => {
        if (frameId !== undefined) {
          window.cancelAnimationFrame(frameId);
          frameId = undefined;
        }
        applyFooterHeight(nextHeight);
        setBottomPanelHeight(nextHeight);
        document.body.classList.remove('resizing-panels');
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      };

      document.body.classList.add('resizing-panels');
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp, { once: true });
      window.addEventListener('pointercancel', onPointerUp, { once: true });
    },
    [bottomPanelHeight, bottomPanelMaxHeight]
  );

  const resizeBottomPanelWithKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      let nextHeight: number | undefined;
      if (event.key === 'ArrowUp') nextHeight = bottomPanelHeight + 20;
      if (event.key === 'ArrowDown') nextHeight = bottomPanelHeight - 20;
      if (event.key === 'Home') nextHeight = MIN_BOTTOM_PANEL_HEIGHT;
      if (event.key === 'End') nextHeight = bottomPanelMaxHeight();
      if (nextHeight === undefined) return;
      event.preventDefault();
      setBottomPanelHeight(
        Math.min(Math.max(nextHeight, MIN_BOTTOM_PANEL_HEIGHT), bottomPanelMaxHeight())
      );
    },
    [bottomPanelHeight, bottomPanelMaxHeight]
  );

  return (
    <Layout className="app-shell">
      <Layout.Header className="app-header">
        <TitleBar />
      </Layout.Header>
      <Layout className="app-body">
        <Layout.Sider className="resource-sider" width={300}>
          <aside className="sidebar">
            <BucketTree />
          </aside>
        </Layout.Sider>
        <Layout className="main-workspace" ref={workspaceRef}>
          <Layout.Content className="workbench">
            <Suspense fallback={<div className="page-loading" />}>
              <ExplorerPage key={explorerKey} />
            </Suspense>
          </Layout.Content>
          <div
            className="workspace-resizer"
            role="separator"
            tabIndex={0}
            aria-orientation="horizontal"
            aria-label={t('layout.resizeBottomPanel')}
            aria-valuemin={MIN_BOTTOM_PANEL_HEIGHT}
            aria-valuemax={Math.max(
              MIN_BOTTOM_PANEL_HEIGHT,
              Math.floor((window.innerHeight - 52) * 0.48)
            )}
            aria-valuenow={bottomPanelHeight}
            onKeyDown={resizeBottomPanelWithKeyboard}
            onPointerDown={beginBottomPanelResize}
          >
            <span />
          </div>
          <Layout.Footer
            ref={footerRef}
            className="app-footer"
            style={{ flexBasis: bottomPanelHeight, height: bottomPanelHeight }}
          >
            <BottomTaskPanel />
          </Layout.Footer>
        </Layout>
      </Layout>
      <Modal
        className="settings-modal"
        rootClassName="settings-modal-root"
        title={
          settingsMode === 'connection'
            ? editingConnectionId === null
              ? t('settings.newConnection')
              : t('settings.editConnection')
            : t('common.settings')
        }
        open={settingsOpen}
        footer={null}
        width={980}
        centered
        closable
        keyboard
        mask={{ closable: true }}
        destroyOnHidden
        onCancel={handleSettingsCancel}
      >
        <ConnectionForm
          key={`${settingsMode}:${editingConnectionId ?? 'default'}`}
          config={config}
          connectionId={editingConnectionId}
          mode={settingsMode}
          onSaved={handleSettingsSaved}
        />
      </Modal>
    </Layout>
  );
}

const BottomTaskPanel = memo(function BottomTaskPanel(): React.JSX.Element {
  const tasks = useTaskStore((state) => state.tasks);
  const cancelTask = useCallback((task: (typeof tasks)[number]): void => {
    void window.ossApi.cancelTask(task.id);
  }, []);
  const retryTask = useCallback((task: (typeof tasks)[number]): void => {
    void window.ossApi.retryTask(task.id);
  }, []);

  return <TaskTable tasks={tasks} onCancel={cancelTask} onRetry={retryTask} />;
});
