import { ArrowDownOutlined, SearchOutlined } from '@ant-design/icons';
import { App, Input, Modal, Select, Space, Typography } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { BreadcrumbPath } from '@renderer/components/BreadcrumbPath';
import { ObjectDetails } from '@renderer/components/ObjectDetails';
import { ObjectTable } from '@renderer/components/ObjectTable';
import { ToolbarActions } from '@renderer/components/ToolbarActions';
import { useAppStore } from '@renderer/stores/appStore';
import { isCurrentConnection, useConnectionStore } from '@renderer/stores/connectionStore';
import { useObjectStore } from '@renderer/stores/objectStore';
import {
  buildTargetKey,
  ensureTrailingSlash,
  joinPrefix,
  normalizePrefixInput,
  objectLeafName,
  parentPrefix
} from '@renderer/utils/objectKey';
import { formatSize } from '@renderer/utils/formatSize';
import type { ObjectItem } from '@shared/types';
import { useI18n } from '@renderer/i18n';

export function ExplorerPage(): React.JSX.Element {
  const { t } = useI18n();
  const { message, modal } = App.useApp();
  const { searchTerm, config, setSearchTerm } = useAppStore(
    useShallow((state) => ({
      searchTerm: state.searchTerm,
      config: state.config,
      setSearchTerm: state.setSearchTerm
    }))
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const buckets = useConnectionStore(
    useShallow((state) => ({
      buckets: state.buckets
    }))
  ).buckets;
  const {
    currentConnectionId,
    currentBucket,
    currentPrefix,
    objects,
    totalSize,
    selectedObject,
    selectedObjects,
    loading,
    loadingMore,
    hasMoreObjects,
    setSelectedObject,
    setSelectedObjects,
    setPrefix,
    loadObjects,
    loadMoreObjects
  } = useObjectStore(
    useShallow((state) => ({
      currentConnectionId: state.currentConnectionId,
      currentBucket: state.currentBucket,
      currentPrefix: state.currentPrefix,
      objects: state.objects,
      totalSize: state.totalSize,
      selectedObject: state.selectedObject,
      selectedObjects: state.selectedObjects,
      loading: state.loading,
      loadingMore: state.loadingMore,
      hasMoreObjects: state.hasMoreObjects,
      setSelectedObject: state.setSelectedObject,
      setSelectedObjects: state.setSelectedObjects,
      setPrefix: state.setPrefix,
      loadObjects: state.loadObjects,
      loadMoreObjects: state.loadMoreObjects
    }))
  );
  const hasActiveConnection = useMemo(
    () =>
      Boolean(
        config?.activeConnectionId &&
        config.connections.some((connection) => connection.id === config.activeConnectionId)
      ),
    [config]
  );
  const activeConnection = useMemo(
    () => config?.connections.find((connection) => connection.id === config.activeConnectionId),
    [config]
  );
  const assertConnectionCurrent = useCallback((): void => {
    if (!isCurrentConnection(activeConnection)) throw new Error(t('connection.changed'));
  }, [activeConnection, t]);

  const navigate = useCallback(
    (prefix: string): void => {
      setPrefix(prefix);
      void loadObjects(currentBucket, prefix, currentConnectionId).catch((error) =>
        message.error(error.message)
      );
    },
    [currentBucket, currentConnectionId, loadObjects, message, setPrefix]
  );

  const upload = useCallback(async (): Promise<void> => {
    if (!currentBucket || !currentConnectionId) {
      message.warning(t('explorer.selectBucketFirst'));
      return;
    }
    const filePaths = await window.ossApi.selectFiles();
    if (filePaths.length === 0) return;
    try {
      assertConnectionCurrent();
      const tasks = await window.ossApi.uploadObjects({
        connectionId: currentConnectionId,
        bucket: currentBucket,
        prefix: currentPrefix,
        filePaths
      });
      if (tasks.length > 0) {
        message.success(t('explorer.uploadTasksQueued', { count: tasks.length }));
      } else {
        message.warning(t('explorer.duplicateUploadTask'));
      }
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    }
  }, [assertConnectionCurrent, currentBucket, currentConnectionId, currentPrefix, message, t]);

  const uploadFolder = useCallback(async (): Promise<void> => {
    if (!currentBucket || !currentConnectionId) {
      message.warning(t('explorer.selectBucketFirst'));
      return;
    }
    const directoryPath = await window.ossApi.selectUploadFolder();
    if (!directoryPath) return;
    try {
      assertConnectionCurrent();
      const tasks = await window.ossApi.uploadObjects({
        connectionId: currentConnectionId,
        bucket: currentBucket,
        prefix: currentPrefix,
        filePaths: [],
        directoryPaths: [directoryPath],
        preserveEmptyFolders: true
      });
      if (tasks.length > 0) {
        message.success(t('explorer.folderUploadQueued'));
      } else {
        message.warning(t('explorer.duplicateFolderUploadTask'));
      }
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    }
  }, [assertConnectionCurrent, currentBucket, currentConnectionId, currentPrefix, message, t]);

  const createFolder = useCallback((): void => {
    if (!currentBucket || !currentConnectionId) {
      message.warning(t('explorer.selectBucketFirst'));
      return;
    }
    let folderName = '';
    modal.confirm({
      title: t('explorer.newFolder'),
      centered: true,
      content: (
        <Input
          autoFocus
          placeholder="folder-name"
          onChange={(event) => {
            folderName = event.target.value;
          }}
        />
      ),
      onOk: async () => {
        assertConnectionCurrent();
        if (!folderName.trim()) return;
        try {
          await window.ossApi.createFolder(
            currentConnectionId,
            currentBucket,
            joinPrefix(currentPrefix, folderName.trim())
          );
          await loadObjects(currentBucket, currentPrefix, currentConnectionId);
        } catch (error) {
          if (error instanceof Error) message.error(error.message);
        }
      }
    });
  }, [
    assertConnectionCurrent,
    currentBucket,
    currentConnectionId,
    currentPrefix,
    loadObjects,
    message,
    modal,
    t
  ]);

  const downloadObject = useCallback(async (): Promise<void> => {
    if (!currentConnectionId) return;
    const targets = selectedObjects.filter((object) => !object.isFolder);
    if (targets.length === 0) return;
    try {
      assertConnectionCurrent();
      await Promise.all(
        targets.map((object) =>
          window.ossApi.downloadObject({
            connectionId: currentConnectionId,
            bucket: object.bucket,
            key: object.key,
            size: object.size
          })
        )
      );
      message.success(t('explorer.downloadTasksQueued', { count: targets.length }));
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    }
  }, [assertConnectionCurrent, currentConnectionId, message, selectedObjects, t]);

  const deleteObjects = useCallback(
    (targets = selectedObjects): void => {
      const deleteTargets = uniqueObjectTargets(targets);
      if (!currentConnectionId || deleteTargets.length === 0) return;

      const run = async (): Promise<void> => {
        try {
          assertConnectionCurrent();
          const groups = groupObjectsByBucket(deleteTargets);
          await Promise.all(
            [...groups.entries()].map(([bucket, objectsInBucket]) =>
              window.ossApi.deleteObject({
                connectionId: currentConnectionId,
                bucket,
                keys: objectsInBucket.map((object) => object.key)
              })
            )
          );
          message.success(t('explorer.deleteTasksQueued', { count: deleteTargets.length }));
        } catch (error) {
          if (error instanceof Error) message.error(error.message);
        }
      };

      if (config?.securitySettings.requireConfirmationBeforeDelete !== false) {
        modal.confirm({
          title:
            deleteTargets.length === 1
              ? t('explorer.confirmDeleteObject')
              : t('explorer.confirmDeleteObjects', { count: deleteTargets.length }),
          centered: true,
          width: 560,
          content: <DeleteConfirmContent targets={deleteTargets} />,
          okText: t('common.delete'),
          okButtonProps: { danger: true },
          onOk: run
        });
      } else {
        void run();
      }
    },
    [
      assertConnectionCurrent,
      config?.securitySettings.requireConfirmationBeforeDelete,
      currentConnectionId,
      message,
      modal,
      selectedObjects,
      t
    ]
  );

  const queueCopyOrMove = useCallback(
    (action: 'copy' | 'move', targets = selectedObjects): void => {
      if (!currentBucket || !currentConnectionId || targets.length === 0) return;

      let selectedTarget: TransferTarget = {
        bucket: currentBucket,
        prefix: normalizePrefixInput(currentPrefix)
      };
      const isMove = action === 'move';

      modal.confirm({
        title: isMove ? t('explorer.moveTo') : t('explorer.copyTo'),
        centered: true,
        width: 640,
        okText: isMove ? t('common.move') : t('common.copy'),
        okButtonProps: { danger: isMove },
        content: (
          <TransferTargetSelector
            action={action}
            bucketNames={buckets.map((bucket) => bucket.name)}
            currentBucket={currentBucket}
            currentPrefix={currentPrefix}
            targets={targets}
            onChange={(target) => {
              selectedTarget = target;
            }}
          />
        ),
        onOk: async () => {
          assertConnectionCurrent();
          const bucket = selectedTarget.bucket.trim();
          const prefix = normalizePrefixInput(selectedTarget.prefix);
          if (!bucket) {
            throw new Error(t('explorer.bucketRequired'));
          }

          const operations = targets.map((object) => {
            assertTransferTargetDiffersFromSource(object, { bucket, prefix }, t);
            const targetKey = buildTargetKey(prefix, objectLeafName(object), object.isFolder);
            if (isMove) {
              assertMoveTargetAllowed(object, bucket, targetKey, t);
            }
            return { object, targetKey };
          });

          await Promise.all(
            operations.map(({ object, targetKey }) => {
              if (isMove) {
                return window.ossApi.moveObject({
                  connectionId: currentConnectionId,
                  sourceBucket: object.bucket,
                  sourceKey: object.key,
                  targetBucket: bucket,
                  targetKey,
                  targetExistsPolicy: 'autoRename'
                });
              }

              return window.ossApi.copyObject({
                connectionId: currentConnectionId,
                sourceBucket: object.bucket,
                sourceKey: object.key,
                targetBucket: bucket,
                targetKey,
                targetExistsPolicy: 'autoRename'
              });
            })
          );
          message.success(
            t('explorer.transferTasksQueued', {
              count: targets.length,
              action: isMove ? t('explorer.moveAction') : t('explorer.copyAction')
            })
          );
        }
      });
    },
    [
      assertConnectionCurrent,
      buckets,
      currentBucket,
      currentConnectionId,
      currentPrefix,
      message,
      modal,
      selectedObjects,
      t
    ]
  );

  const renameObject = useCallback(
    (object = selectedObject): void => {
      if (!object || !currentConnectionId) return;

      let nextName = objectLeafName(object);
      modal.confirm({
        title: t('common.rename'),
        centered: true,
        width: 480,
        okText: t('common.rename'),
        content: (
          <RenameConfirmContent
            object={object}
            initialName={nextName}
            onNameChange={(value) => {
              nextName = value;
            }}
          />
        ),
        onOk: async () => {
          assertConnectionCurrent();
          const safeName = nextName.trim();
          if (!safeName || safeName.includes('/') || safeName.includes('\\')) {
            throw new Error(t('explorer.emptyName'));
          }

          const newKey = buildTargetKey(parentPrefix(object.key), safeName, object.isFolder);
          if (newKey === object.key) {
            return;
          }

          await window.ossApi.renameObject({
            connectionId: currentConnectionId,
            bucket: object.bucket,
            oldKey: object.key,
            newKey
          });
          message.success(t('explorer.renameQueued'));
        }
      });
    },
    [assertConnectionCurrent, currentConnectionId, message, modal, selectedObject, t]
  );

  const copyPath = useCallback(
    async (object = selectedObject): Promise<void> => {
      if (!object) return;
      await navigator.clipboard.writeText(object.key);
      message.success(t('explorer.keyCopied'));
    },
    [message, selectedObject, t]
  );

  const copyUrl = useCallback(
    async (object = selectedObject): Promise<void> => {
      if (!object || object.isFolder || !currentConnectionId) return;
      try {
        assertConnectionCurrent();
        const url = await window.ossApi.generateObjectUrl(
          currentConnectionId,
          object.bucket,
          object.key
        );
        await navigator.clipboard.writeText(url);
        message.success(t('explorer.urlCopied'));
      } catch (error) {
        if (error instanceof Error) message.error(error.message);
      }
    },
    [assertConnectionCurrent, currentConnectionId, message, selectedObject, t]
  );

  const handleObjectSelect = useCallback(
    (object: typeof selectedObject): void => {
      if (!object) return;
      setSelectedObject(object);
    },
    [setSelectedObject]
  );
  const handleMultiSelect = useCallback(
    (items: typeof selectedObjects): void => {
      setSelectedObjects(items);
    },
    [setSelectedObjects]
  );
  const handleViewDetails = useCallback(
    (object: NonNullable<typeof selectedObject>): void => {
      setSelectedObject(object);
      setDetailsOpen(true);
    },
    [setSelectedObject]
  );
  const queueUpload = useCallback((): void => {
    void upload();
  }, [upload]);
  const queueFolderUpload = useCallback((): void => {
    void uploadFolder();
  }, [uploadFolder]);
  const queueSelectedCopies = useCallback((): void => {
    queueCopyOrMove('copy');
  }, [queueCopyOrMove]);
  const queueSelectedMoves = useCallback((): void => {
    queueCopyOrMove('move');
  }, [queueCopyOrMove]);
  const queueSelectedRename = useCallback((): void => {
    renameObject();
  }, [renameObject]);
  const queueSelectedDeletes = useCallback((): void => {
    deleteObjects();
  }, [deleteObjects]);
  const queueSelectedDownloads = useCallback((): void => {
    void downloadObject();
  }, [downloadObject]);
  const refreshCurrentObjects = useCallback((): void => {
    void loadObjects(currentBucket, currentPrefix, currentConnectionId).catch((error) =>
      message.error(error.message)
    );
  }, [currentBucket, currentConnectionId, currentPrefix, loadObjects, message]);
  const handleLoadMoreObjects = useCallback((): void => {
    void loadMoreObjects().catch((error) => message.error(error.message));
  }, [loadMoreObjects, message]);
  const handleOpenFolder = useCallback(
    (object: NonNullable<typeof selectedObject>): void => {
      navigate(object.key);
    },
    [navigate]
  );
  const handleDownloadSingle = useCallback(
    (object: NonNullable<typeof selectedObject>): void => {
      if (!currentConnectionId) return;
      if (!isCurrentConnection(activeConnection)) {
        message.warning(t('connection.changed'));
        return;
      }
      handleObjectSelect(object);
      void window.ossApi
        .downloadObject({
          connectionId: currentConnectionId,
          bucket: object.bucket,
          key: object.key,
          size: object.size
        })
        .then(() => message.success(t('explorer.downloadTaskQueued')))
        .catch((error) => message.error(error.message));
    },
    [activeConnection, currentConnectionId, handleObjectSelect, message, t]
  );
  const handleCopyPath = useCallback(
    (object: NonNullable<typeof selectedObject>): void => {
      void copyPath(object);
    },
    [copyPath]
  );
  const handleCopyUrl = useCallback(
    (object: NonNullable<typeof selectedObject>): void => {
      void copyUrl(object);
    },
    [copyUrl]
  );
  const handleCopyTo = useCallback(
    (object: NonNullable<typeof selectedObject>): void => {
      setSelectedObject(object);
      queueCopyOrMove('copy', [object]);
    },
    [queueCopyOrMove, setSelectedObject]
  );
  const handleMoveTo = useCallback(
    (object: NonNullable<typeof selectedObject>): void => {
      setSelectedObject(object);
      queueCopyOrMove('move', [object]);
    },
    [queueCopyOrMove, setSelectedObject]
  );
  const handleRename = useCallback(
    (object: NonNullable<typeof selectedObject>): void => {
      setSelectedObject(object);
      renameObject(object);
    },
    [renameObject, setSelectedObject]
  );
  const handleDeleteSingle = useCallback(
    (object: NonNullable<typeof selectedObject>): void => {
      setSelectedObject(object);
      deleteObjects([object]);
    },
    [deleteObjects, setSelectedObject]
  );
  const hasSelectedBucket =
    hasActiveConnection && currentConnectionId === activeConnection?.id && Boolean(currentBucket);
  const hasObjectSelection = selectedObjects.length > 0;
  const hasDownloadableSelection = useMemo(
    () => selectedObjects.some((object) => !object.isFolder),
    [selectedObjects]
  );

  return (
    <div className="page explorer-page">
      <div className="page-header object-page-header">
        <BreadcrumbPath prefix={currentPrefix} onNavigate={navigate} />
        <div className="object-toolbar-row">
          <ToolbarActions
            disabled={!hasSelectedBucket}
            hasSelection={hasObjectSelection}
            hasDownloadableSelection={hasDownloadableSelection}
            selectedCount={selectedObjects.length}
            onUpload={queueUpload}
            onUploadFolder={queueFolderUpload}
            onNewFolder={createFolder}
            onDownload={queueSelectedDownloads}
            onCopy={queueSelectedCopies}
            onMove={queueSelectedMoves}
            onRename={queueSelectedRename}
            onDelete={queueSelectedDeletes}
            onRefresh={refreshCurrentObjects}
          />
          <div className="object-toolbar-summary">
            <Input
              className="object-toolbar-search"
              allowClear
              prefix={<SearchOutlined />}
              placeholder={t('explorer.searchObjects')}
              value={searchTerm}
              onChange={(event) => {
                setSelectedObjects([]);
                setSearchTerm(event.target.value);
              }}
            />
            <Space size={6}>
              <Typography.Text type="secondary">
                {t('explorer.itemCount', { count: objects.length })}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t('explorer.totalSize', { size: formatSize(totalSize) })}
              </Typography.Text>
            </Space>
          </div>
        </div>
      </div>
      <ObjectTable
        objects={objects}
        loading={loading}
        loadingMore={loadingMore}
        hasMoreObjects={hasMoreObjects}
        selectedObjects={selectedObjects}
        searchTerm={searchTerm}
        onLoadMore={handleLoadMoreObjects}
        onSelect={handleObjectSelect}
        onMultiSelect={handleMultiSelect}
        onOpenFolder={handleOpenFolder}
        onDownload={handleDownloadSingle}
        onDelete={handleDeleteSingle}
        onCopyTo={handleCopyTo}
        onMoveTo={handleMoveTo}
        onRename={handleRename}
        onCopyPath={handleCopyPath}
        onCopyUrl={handleCopyUrl}
        onViewDetails={handleViewDetails}
      />
      <Modal
        className="object-details-modal"
        title={t('common.details')}
        open={detailsOpen && Boolean(selectedObject)}
        footer={null}
        width={720}
        centered
        closable
        keyboard
        mask={{ closable: true }}
        destroyOnHidden
        onCancel={() => setDetailsOpen(false)}
      >
        <ObjectDetails
          object={selectedObject}
          bucketName={currentBucket}
          connectionName={activeConnection?.profileName}
          endpoint={activeConnection?.endpoint}
          region={activeConnection?.region}
          showActions={false}
        />
      </Modal>
    </div>
  );
}
interface TransferTarget {
  bucket: string;
  prefix: string;
}

interface TransferTargetSelectorProps {
  action: 'copy' | 'move';
  bucketNames: string[];
  currentBucket: string;
  currentPrefix: string;
  targets: ObjectItem[];
  onChange: (target: TransferTarget) => void;
}

function TransferTargetSelector({
  action,
  bucketNames,
  currentBucket,
  currentPrefix,
  targets,
  onChange
}: TransferTargetSelectorProps): React.JSX.Element {
  const { t } = useI18n();
  const initialTarget = useMemo<TransferTarget>(
    () => ({ bucket: currentBucket, prefix: normalizePrefixInput(currentPrefix) }),
    [currentBucket, currentPrefix]
  );
  const [selectedTarget, setSelectedTarget] = useState<TransferTarget>(initialTarget);
  const sourceFolders = useMemo(() => transferSourceFolders(targets), [targets]);
  const bucketOptions = useMemo(
    () =>
      [...new Set([currentBucket, ...bucketNames].map((name) => name.trim()).filter(Boolean))].map(
        (name) => ({ value: name, label: name })
      ),
    [bucketNames, currentBucket]
  );
  const updateTarget = (next: TransferTarget): void => {
    setSelectedTarget(next);
    onChange(next);
  };

  return (
    <Space className="transfer-target-form" orientation="vertical" size={10}>
      <Typography.Text className="transfer-target-summary" type="secondary" ellipsis>
        {targets.length === 1
          ? targets[0].key
          : t('explorer.transferSummarySelected', {
              count: targets.length,
              action:
                action === 'move'
                  ? t('explorer.transferSummaryMoved')
                  : t('explorer.transferSummaryCopied')
            })}
      </Typography.Text>
      <Typography.Text type="secondary">{t('explorer.autoRenameHint')}</Typography.Text>
      <div className="transfer-target-path-flow">
        <TransferTargetPathInfo
          label={t('explorer.sourceFolder')}
          paths={sourceFolders}
          tone="source"
        />
        <span className="transfer-target-path-arrow" aria-hidden="true">
          <ArrowDownOutlined />
        </span>
        <TransferTargetPathInfo
          label={t('explorer.targetFolder')}
          paths={[formatTransferTarget(selectedTarget)]}
          tone="target"
        />
      </div>
      <Space className="transfer-target-controls" orientation="vertical" size={8}>
        <Typography.Text>{t('explorer.targetBucket')}</Typography.Text>
        <Select
          value={selectedTarget.bucket}
          options={bucketOptions}
          aria-label={t('explorer.targetBucket')}
          onChange={(bucket) => updateTarget({ ...selectedTarget, bucket })}
        />
        <Typography.Text>{t('explorer.targetPrefix')}</Typography.Text>
        <Input
          value={selectedTarget.prefix}
          placeholder={t('explorer.targetPrefixPlaceholder')}
          aria-label={t('explorer.targetPrefix')}
          onChange={(event) => updateTarget({ ...selectedTarget, prefix: event.target.value })}
        />
      </Space>
    </Space>
  );
}

function TransferTargetPathInfo({
  label,
  paths,
  tone
}: {
  label: string;
  paths: string[];
  tone: 'source' | 'target';
}): React.JSX.Element {
  const labelText = paths.length > 1 ? `${label} (${paths.length})` : label;

  return (
    <div className={`transfer-target-path-panel ${tone}`}>
      <Typography.Text className="transfer-target-path-label" type="secondary">
        {labelText}
      </Typography.Text>
      <div className="transfer-target-path-values">
        {paths.map((path) => (
          <Typography.Text className="transfer-target-path-value" key={path} title={path}>
            {path}
          </Typography.Text>
        ))}
      </div>
    </div>
  );
}

function assertMoveTargetAllowed(
  object: ObjectItem,
  targetBucket: string,
  targetKey: string,
  translateText: ReturnType<typeof useI18n>['t']
): void {
  if (object.bucket !== targetBucket) {
    return;
  }

  const sourceKey = object.key;
  if (targetKey === sourceKey) {
    throw new Error(translateText('explorer.sameTarget'));
  }

  if (object.isFolder && targetKey.startsWith(ensureTrailingSlash(sourceKey))) {
    throw new Error(translateText('explorer.moveIntoSelf'));
  }
}

function assertTransferTargetDiffersFromSource(
  object: ObjectItem,
  target: TransferTarget,
  translateText: ReturnType<typeof useI18n>['t']
): void {
  const source = objectSourceFolderTarget(object);
  if (sameTransferTarget(source, target)) {
    throw new Error(
      translateText('explorer.sameSourceTarget', { target: formatTransferTarget(source) })
    );
  }
}

function formatTransferTarget(target: TransferTarget): string {
  return `${target.bucket}/${normalizePrefixInput(target.prefix)}`;
}

function sameTransferTarget(left: TransferTarget, right: TransferTarget): boolean {
  return (
    left.bucket.trim() === right.bucket.trim() &&
    normalizePrefixInput(left.prefix) === normalizePrefixInput(right.prefix)
  );
}

function objectSourceFolderTarget(object: ObjectItem): TransferTarget {
  return {
    bucket: object.bucket,
    prefix: object.prefix ? object.prefix : parentPrefix(object.key)
  };
}

function transferSourceFolders(targets: ObjectItem[]): string[] {
  return [
    ...new Set(targets.map((object) => formatTransferTarget(objectSourceFolderTarget(object))))
  ].sort((a, b) => a.localeCompare(b));
}

function DeleteConfirmContent({ targets }: { targets: ObjectItem[] }): React.JSX.Element {
  const { t } = useI18n();
  const visibleTargets = targets.slice(0, 6);
  const folderTargets = targets.filter((object) => object.isFolder);
  return (
    <Space className="delete-confirm-content" orientation="vertical" size={6}>
      <Typography.Text type="secondary">{t('explorer.deleteRefreshHint')}</Typography.Text>
      {folderTargets.length > 0 ? (
        <Typography.Text type="danger">{t('explorer.deleteFolderWarning')}</Typography.Text>
      ) : null}
      {visibleTargets.map((object) => (
        <Typography.Text className="delete-confirm-key" key={`${object.bucket}/${object.key}`}>
          {object.bucket}/{object.key}
        </Typography.Text>
      ))}
      {targets.length > visibleTargets.length ? (
        <Typography.Text type="secondary">
          {t('explorer.moreObjectsHidden', { count: targets.length - visibleTargets.length })}
        </Typography.Text>
      ) : null}
    </Space>
  );
}

function RenameConfirmContent({
  object,
  initialName,
  onNameChange
}: {
  object: ObjectItem;
  initialName: string;
  onNameChange: (value: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState(initialName);
  const sourceName = objectLeafName(object);

  return (
    <Space className="rename-confirm-content" orientation="vertical" size={8}>
      <Typography.Text className="rename-source-name" title={sourceName}>
        {sourceName}
      </Typography.Text>
      <Input
        autoFocus
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          onNameChange(event.target.value);
        }}
      />
    </Space>
  );
}

function uniqueObjectTargets(objects: ObjectItem[]): ObjectItem[] {
  const targets = new Map<string, ObjectItem>();
  for (const object of objects) {
    if (!object.bucket || !object.key) {
      continue;
    }
    targets.set(`${object.bucket}\n${object.key}`, object);
  }
  return [...targets.values()];
}

function groupObjectsByBucket(objects: ObjectItem[]): Map<string, ObjectItem[]> {
  const groups = new Map<string, ObjectItem[]>();
  for (const object of objects) {
    const group = groups.get(object.bucket) ?? [];
    group.push(object);
    groups.set(object.bucket, group);
  }
  return groups;
}
