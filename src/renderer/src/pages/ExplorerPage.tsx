import {
  ArrowDownOutlined,
  DatabaseOutlined,
  FolderOutlined,
  LoadingOutlined,
  SearchOutlined
} from '@ant-design/icons';
import { App, Input, Modal, Space, Tree, Typography, message } from 'antd';
import type { TreeDataNode, TreeProps } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { BreadcrumbPath } from '@renderer/components/BreadcrumbPath';
import { ObjectDetails } from '@renderer/components/ObjectDetails';
import { ObjectTable } from '@renderer/components/ObjectTable';
import { ToolbarActions } from '@renderer/components/ToolbarActions';
import { useAppStore } from '@renderer/stores/appStore';
import { useConnectionStore } from '@renderer/stores/connectionStore';
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
  const { modal } = App.useApp();
  const { searchTerm, config, setSearchTerm } = useAppStore(
    useShallow((state) => ({
      searchTerm: state.searchTerm,
      config: state.config,
      setSearchTerm: state.setSearchTerm
    }))
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { buckets, loadBuckets } = useConnectionStore(
    useShallow((state) => ({
      buckets: state.buckets,
      loadBuckets: state.loadBuckets
    }))
  );
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
    loadingAll,
    hasMoreObjects,
    setSelectedObject,
    setSelectedObjects,
    setPrefix,
    loadObjects,
    loadMoreObjects,
    loadAllObjects,
    cancelLoadAllObjects
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
      loadingAll: state.loadingAll,
      hasMoreObjects: state.hasMoreObjects,
      setSelectedObject: state.setSelectedObject,
      setSelectedObjects: state.setSelectedObjects,
      setPrefix: state.setPrefix,
      loadObjects: state.loadObjects,
      loadMoreObjects: state.loadMoreObjects,
      loadAllObjects: state.loadAllObjects,
      cancelLoadAllObjects: state.cancelLoadAllObjects
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

  useEffect(() => {
    if (hasActiveConnection && activeConnection?.id) {
      void loadBuckets(activeConnection.id).catch((error) => message.error(error.message));
    }
  }, [activeConnection?.id, hasActiveConnection, loadBuckets]);

  const navigate = useCallback(
    (prefix: string): void => {
      setPrefix(prefix);
      void loadObjects(currentBucket, prefix, currentConnectionId).catch((error) =>
        message.error(error.message)
      );
    },
    [currentBucket, currentConnectionId, loadObjects, setPrefix]
  );

  const upload = useCallback(async (): Promise<void> => {
    if (!currentBucket) {
      message.warning(t('explorer.selectBucketFirst'));
      return;
    }
    const filePaths = await window.ossApi.selectFiles();
    if (filePaths.length === 0) return;
    try {
      const tasks = await window.ossApi.uploadObjects({
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
  }, [currentBucket, currentPrefix, t]);

  const uploadFolder = useCallback(async (): Promise<void> => {
    if (!currentBucket) {
      message.warning(t('explorer.selectBucketFirst'));
      return;
    }
    const directoryPath = await window.ossApi.selectUploadFolder();
    if (!directoryPath) return;
    try {
      const tasks = await window.ossApi.uploadObjects({
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
  }, [currentBucket, currentPrefix, t]);

  const createFolder = useCallback((): void => {
    if (!currentBucket) {
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
        if (!folderName.trim()) return;
        try {
          await window.ossApi.createFolder(
            currentBucket,
            joinPrefix(currentPrefix, folderName.trim())
          );
          await loadObjects(currentBucket, currentPrefix, currentConnectionId);
        } catch (error) {
          if (error instanceof Error) message.error(error.message);
        }
      }
    });
  }, [currentBucket, currentConnectionId, currentPrefix, loadObjects, modal, t]);

  const downloadObject = useCallback(async (): Promise<void> => {
    const targets = selectedObjects.filter((object) => !object.isFolder);
    if (targets.length === 0) return;
    try {
      await Promise.all(
        targets.map((object) =>
          window.ossApi.downloadObject({
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
  }, [selectedObjects, t]);

  const deleteObjects = useCallback(
    (targets = selectedObjects): void => {
      const deleteTargets = uniqueObjectTargets(targets);
      if (deleteTargets.length === 0) return;

      const run = async (): Promise<void> => {
        try {
          const groups = groupObjectsByBucket(deleteTargets);
          await Promise.all(
            [...groups.entries()].map(([bucket, objectsInBucket]) =>
              window.ossApi.deleteObject({
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
    [config?.securitySettings.requireConfirmationBeforeDelete, modal, selectedObjects, t]
  );

  const queueCopyOrMove = useCallback(
    (action: 'copy' | 'move', targets = selectedObjects): void => {
      if (!currentBucket || targets.length === 0) return;

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
          <TransferTargetTreeSelector
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
                  sourceBucket: object.bucket,
                  sourceKey: object.key,
                  targetBucket: bucket,
                  targetKey,
                  targetExistsPolicy: 'autoRename'
                });
              }

              return window.ossApi.copyObject({
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
    [buckets, currentBucket, currentPrefix, modal, selectedObjects, t]
  );

  const renameObject = useCallback(
    (object = selectedObject): void => {
      if (!object) return;

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
          const safeName = nextName.trim();
          if (!safeName || safeName.includes('/') || safeName.includes('\\')) {
            throw new Error(t('explorer.emptyName'));
          }

          const newKey = buildTargetKey(parentPrefix(object.key), safeName, object.isFolder);
          if (newKey === object.key) {
            return;
          }

          await window.ossApi.renameObject({
            bucket: object.bucket,
            oldKey: object.key,
            newKey
          });
          message.success(t('explorer.renameQueued'));
        }
      });
    },
    [modal, selectedObject, t]
  );

  const copyPath = useCallback(
    async (object = selectedObject): Promise<void> => {
      if (!object) return;
      await navigator.clipboard.writeText(object.key);
      message.success(t('explorer.keyCopied'));
    },
    [selectedObject, t]
  );

  const copyUrl = useCallback(
    async (object = selectedObject): Promise<void> => {
      if (!object || object.isFolder) return;
      try {
        const url = await window.ossApi.generateObjectUrl(object.bucket, object.key);
        await navigator.clipboard.writeText(url);
        message.success(t('explorer.urlCopied'));
      } catch (error) {
        if (error instanceof Error) message.error(error.message);
      }
    },
    [selectedObject, t]
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
  }, [currentBucket, currentConnectionId, currentPrefix, loadObjects]);
  const handleLoadMoreObjects = useCallback((): void => {
    void loadMoreObjects().catch((error) => message.error(error.message));
  }, [loadMoreObjects]);
  const handleLoadAllObjects = useCallback((): void => {
    void loadAllObjects().catch((error) => message.error(error.message));
  }, [loadAllObjects]);
  const handleOpenFolder = useCallback(
    (object: NonNullable<typeof selectedObject>): void => {
      navigate(object.key);
    },
    [navigate]
  );
  const handleDownloadSingle = useCallback(
    (object: NonNullable<typeof selectedObject>): void => {
      handleObjectSelect(object);
      void window.ossApi
        .downloadObject({ bucket: object.bucket, key: object.key, size: object.size })
        .then(() => message.success(t('explorer.downloadTaskQueued')))
        .catch((error) => message.error(error.message));
    },
    [handleObjectSelect, t]
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
              onChange={(event) => setSearchTerm(event.target.value)}
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
        loadingAll={loadingAll}
        hasMoreObjects={hasMoreObjects}
        selectedObjects={selectedObjects}
        searchTerm={searchTerm}
        onLoadMore={handleLoadMoreObjects}
        onLoadAll={handleLoadAllObjects}
        onCancelLoadAll={cancelLoadAllObjects}
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
        maskClosable
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

interface FolderTreeLoadPage {
  nodes: TreeDataNode[];
  nextContinuationToken?: string;
  isComplete: boolean;
}

interface FolderTreeUpdateOptions {
  isComplete: boolean;
}

const FOLDER_TREE_SCAN_PLACEHOLDER_KEY_PREFIX = 'folder-tree-scan:';
const MAX_CONCURRENT_FOLDER_TREE_PAGE_LOADS = 6;
let activeFolderTreePageLoads = 0;
const pendingFolderTreePageLoads: Array<() => void> = [];

interface TransferTargetTreeSelectorProps {
  action: 'copy' | 'move';
  bucketNames: string[];
  currentBucket: string;
  currentPrefix: string;
  targets: ObjectItem[];
  onChange: (target: TransferTarget) => void;
}

function TransferTargetTreeSelector({
  action,
  bucketNames,
  currentBucket,
  currentPrefix,
  targets,
  onChange
}: TransferTargetTreeSelectorProps): React.JSX.Element {
  const { t } = useI18n();
  const initialTarget = useMemo<TransferTarget>(
    () => ({ bucket: currentBucket, prefix: normalizePrefixInput(currentPrefix) }),
    [currentBucket, currentPrefix]
  );
  const rootBucketNames = useMemo(
    () => uniqueNames([currentBucket, ...bucketNames]),
    [bucketNames, currentBucket]
  );
  const initialExpandedKeys = useMemo(
    () => initialTransferTargetExpandedKeys(initialTarget),
    [initialTarget]
  );
  const initialSelectedKey = useMemo(() => encodeTransferTargetKey(initialTarget), [initialTarget]);
  const [treeData, setTreeData] = useState<TreeDataNode[]>(() =>
    buildTransferTargetTreeData(rootBucketNames, initialTarget)
  );
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>(initialExpandedKeys);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([initialSelectedKey]);
  const [selectedTarget, setSelectedTarget] = useState<TransferTarget>(initialTarget);
  const sourceFolders = useMemo(() => transferSourceFolders(targets), [targets]);
  const loadedKeySet = useRef(new Set<string>());
  const loadPromiseMap = useRef(new Map<string, Promise<void>>());
  const scanPromiseMap = useRef(new Map<string, Promise<void>>());
  const continuationTokenMap = useRef(new Map<string, string>());
  const expandedKeySet = useRef(new Set(initialExpandedKeys.map(String)));

  const loadNodeChildren = useCallback((nodeKey: string): Promise<void> => {
    if (loadedKeySet.current.has(nodeKey)) {
      return Promise.resolve();
    }

    const pendingPromise = loadPromiseMap.current.get(nodeKey);
    if (pendingPromise) {
      return pendingPromise;
    }

    const loadPromise = (async () => {
      if (scanPromiseMap.current.has(nodeKey)) {
        return;
      }

      try {
        const target = decodeTransferTargetKey(nodeKey);
        const page = await loadFolderTreeNodePage(
          target.bucket,
          target.prefix,
          continuationTokenMap.current.get(nodeKey)
        );
        setTreeData((currentTreeData) =>
          updateTransferTargetTreeData(currentTreeData, nodeKey, page.nodes, {
            isComplete: page.isComplete
          })
        );
        if (page.isComplete) {
          continuationTokenMap.current.delete(nodeKey);
          loadedKeySet.current.add(nodeKey);
        } else if (page.nextContinuationToken) {
          continuationTokenMap.current.set(nodeKey, page.nextContinuationToken);
          const scanPromise = scanRemainingFolderTreePages(
            nodeKey,
            target.bucket,
            target.prefix,
            page.nextContinuationToken,
            continuationTokenMap,
            loadedKeySet,
            expandedKeySet,
            setTreeData
          ).catch((error: unknown) => {
            if (error instanceof Error) {
              message.error(error.message);
            }
          });
          scanPromiseMap.current.set(nodeKey, scanPromise);
          void scanPromise.finally(() => {
            scanPromiseMap.current.delete(nodeKey);
          });
        }
      } catch (error) {
        if (error instanceof Error) {
          message.error(error.message);
        }
      } finally {
        loadPromiseMap.current.delete(nodeKey);
      }
    })();

    loadPromiseMap.current.set(nodeKey, loadPromise);
    return loadPromise;
  }, []);

  useEffect(() => {
    onChange(initialTarget);
    const timer = window.setTimeout(() => {
      for (const key of initialExpandedKeys) {
        void loadNodeChildren(String(key));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialExpandedKeys, initialTarget, loadNodeChildren, onChange]);

  const handleSelect: TreeProps['onSelect'] = (keys) => {
    const key = keys[0]?.toString();
    if (!key) {
      return;
    }
    const target = decodeTransferTargetKey(key);
    setSelectedKeys([key]);
    setSelectedTarget(target);
    onChange(target);
  };

  const handleExpand: TreeProps['onExpand'] = (keys) => {
    expandedKeySet.current = new Set(keys.map(String));
    setExpandedKeys(keys);
    for (const key of keys) {
      void loadNodeChildren(String(key));
    }
  };

  const handleLoadData: NonNullable<TreeProps['loadData']> = (node) =>
    loadNodeChildren(String(node.key));

  return (
    <Space className="transfer-target-form" direction="vertical" size={10}>
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
      <Typography.Text type="secondary">
        {t('explorer.autoRenameHint')}
      </Typography.Text>
      <div className="transfer-target-path-flow">
        <TransferTargetPathInfo label={t('explorer.sourceFolder')} paths={sourceFolders} tone="source" />
        <span className="transfer-target-path-arrow" aria-hidden="true">
          <ArrowDownOutlined />
        </span>
        <TransferTargetPathInfo
          label={t('explorer.targetFolder')}
          paths={[formatTransferTarget(selectedTarget)]}
          tone="target"
        />
      </div>
      <div className="transfer-target-tree">
        <Tree
          blockNode
          showLine
          height={340}
          treeData={treeData}
          selectedKeys={selectedKeys}
          expandedKeys={expandedKeys}
          loadData={handleLoadData}
          onSelect={handleSelect}
          onExpand={handleExpand}
        />
      </div>
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

function buildTransferTargetTreeData(
  bucketNames: string[],
  selectedTarget: TransferTarget
): TreeDataNode[] {
  return bucketNames.map((bucket) => ({
    key: encodeTransferTargetKey({ bucket, prefix: '' }),
    title: (
      <span className="transfer-target-node">
        <DatabaseOutlined />
        <span>{bucket}</span>
      </span>
    ),
    children:
      bucket === selectedTarget.bucket
        ? buildInitialFolderPathNodes(bucket, selectedTarget.prefix)
        : undefined,
    isLeaf: false
  }));
}

function buildInitialFolderPathNodes(bucket: string, prefix: string): TreeDataNode[] | undefined {
  const segments = normalizePrefixInput(prefix).split('/').filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  let children: TreeDataNode[] | undefined;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const folderPrefix = `${segments.slice(0, index + 1).join('/')}/`;
    children = [
      {
        key: encodeTransferTargetKey({ bucket, prefix: folderPrefix }),
        title: (
          <span className="transfer-target-node">
            <FolderOutlined />
            <span>{segments[index]}</span>
          </span>
        ),
        children,
        isLeaf: false
      }
    ];
  }
  return children;
}

async function scanRemainingFolderTreePages(
  nodeKey: string,
  bucket: string,
  prefix: string,
  continuationToken: string,
  continuationTokenMap: React.RefObject<Map<string, string>>,
  loadedKeySet: React.RefObject<Set<string>>,
  expandedKeySet: React.RefObject<Set<string>>,
  setTreeData: React.Dispatch<React.SetStateAction<TreeDataNode[]>>
): Promise<void> {
  let nextContinuationToken: string | undefined = continuationToken;

  while (nextContinuationToken && expandedKeySet.current.has(nodeKey)) {
    const page = await loadFolderTreeNodePage(bucket, prefix, nextContinuationToken);
    setTreeData((currentTreeData) =>
      updateTransferTargetTreeData(currentTreeData, nodeKey, page.nodes, {
        isComplete: page.isComplete
      })
    );

    if (page.isComplete) {
      continuationTokenMap.current.delete(nodeKey);
      loadedKeySet.current.add(nodeKey);
      return;
    }

    if (!page.nextContinuationToken) {
      return;
    }

    continuationTokenMap.current.set(nodeKey, page.nextContinuationToken);
    nextContinuationToken = page.nextContinuationToken;
  }
}

async function loadFolderTreeNodePage(
  bucket: string,
  prefix: string,
  continuationToken?: string
): Promise<FolderTreeLoadPage> {
  const folders = new Map<string, string>();

  const result = await withFolderTreePageLoadSlot(() =>
    window.ossApi.listFolders(bucket, prefix, continuationToken)
  );
  for (const object of result.objects) {
    if (object.key === prefix) {
      continue;
    }
    const folderPrefix = ensureTrailingSlash(normalizePrefixInput(object.key));
    folders.set(folderPrefix, object.name || folderLeafName(folderPrefix));
  }

  return {
    nodes: folderEntriesToTreeNodes(bucket, folders),
    nextContinuationToken: result.isTruncated ? result.nextContinuationToken : undefined,
    isComplete: !result.isTruncated
  };
}

async function withFolderTreePageLoadSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeFolderTreePageLoads >= MAX_CONCURRENT_FOLDER_TREE_PAGE_LOADS) {
    await new Promise<void>((resolve) => {
      pendingFolderTreePageLoads.push(resolve);
    });
  }

  activeFolderTreePageLoads += 1;
  try {
    return await task();
  } finally {
    activeFolderTreePageLoads -= 1;
    pendingFolderTreePageLoads.shift()?.();
  }
}

function folderEntriesToTreeNodes(bucket: string, folders: Map<string, string>): TreeDataNode[] {
  return [...folders.entries()]
    .sort((a, b) => safeText(a[1]).localeCompare(safeText(b[1])))
    .map(([folderPrefix, label]) => createFolderTreeNode(bucket, folderPrefix, label));
}

function createFolderTreeNode(bucket: string, prefix: string, label: string): TreeDataNode {
  return {
    key: encodeTransferTargetKey({ bucket, prefix }),
    title: (
      <span className="transfer-target-node">
        <FolderOutlined />
        <span>{label}</span>
      </span>
    ),
    isLeaf: false
  };
}

function updateTransferTargetTreeData(
  treeData: TreeDataNode[],
  targetKey: string,
  children: TreeDataNode[],
  options: FolderTreeUpdateOptions
): TreeDataNode[] {
  return treeData.map((node) => {
    if (String(node.key) === targetKey) {
      const mergedChildren = mergeTreeChildren(node.children, children);
      const nextChildren = options.isComplete
        ? mergedChildren
        : [...mergedChildren, createFolderTreeScanPlaceholderNode(targetKey)];
      const hasFolderChildren = nextChildren.some(
        (child) => !isFolderTreeScanPlaceholderKey(String(child.key))
      );
      return {
        ...node,
        children: nextChildren,
        isLeaf: options.isComplete && !hasFolderChildren
      };
    }

    if (!node.children) {
      return node;
    }

    return {
      ...node,
      children: updateTransferTargetTreeData(node.children, targetKey, children, options)
    };
  });
}

function mergeTreeChildren(
  existingChildren: TreeDataNode[] | undefined,
  loadedChildren: TreeDataNode[]
): TreeDataNode[] {
  const existingByKey = new Map<string, TreeDataNode>();
  const mergedByKey = new Map<string, TreeDataNode>();

  for (const existingChild of existingChildren ?? []) {
    const key = String(existingChild.key);
    if (isFolderTreeScanPlaceholderKey(key)) {
      continue;
    }
    existingByKey.set(key, existingChild);
    mergedByKey.set(key, existingChild);
  }

  for (const loadedChild of loadedChildren) {
    const key = String(loadedChild.key);
    const existingChild = existingByKey.get(key);
    mergedByKey.set(
      key,
      existingChild
        ? {
            ...loadedChild,
            children: existingChild.children,
            isLeaf: existingChild.isLeaf
          }
        : loadedChild
    );
  }

  return [...mergedByKey.values()].sort((a, b) =>
    safeText(treeNodeLabel(a)).localeCompare(safeText(treeNodeLabel(b)))
  );
}

function createFolderTreeScanPlaceholderNode(parentKey: string): TreeDataNode {
  return {
    key: folderTreeScanPlaceholderKey(parentKey),
    title: (
      <span className="transfer-target-node">
        <LoadingOutlined spin />
        <FolderTreeScanPlaceholderLabel />
      </span>
    ),
    disabled: true,
    selectable: false,
    isLeaf: true
  };
}

function folderTreeScanPlaceholderKey(parentKey: string): string {
  return `${FOLDER_TREE_SCAN_PLACEHOLDER_KEY_PREFIX}${parentKey}`;
}

function isFolderTreeScanPlaceholderKey(key: string): boolean {
  return key.startsWith(FOLDER_TREE_SCAN_PLACEHOLDER_KEY_PREFIX);
}

function initialTransferTargetExpandedKeys(target: TransferTarget): React.Key[] {
  const keys: React.Key[] = [encodeTransferTargetKey({ bucket: target.bucket, prefix: '' })];
  const segments = normalizePrefixInput(target.prefix).split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    keys.push(
      encodeTransferTargetKey({
        bucket: target.bucket,
        prefix: `${segments.slice(0, index + 1).join('/')}/`
      })
    );
  }
  return keys;
}

function encodeTransferTargetKey(target: TransferTarget): string {
  return JSON.stringify([target.bucket, normalizePrefixInput(target.prefix)]);
}

function decodeTransferTargetKey(key: string): TransferTarget {
  const parsed = JSON.parse(key) as [string, string];
  return { bucket: parsed[0], prefix: normalizePrefixInput(parsed[1]) };
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
  ].sort((a, b) => safeText(a).localeCompare(safeText(b)));
}

function folderLeafName(prefix: string): string {
  const segments = normalizePrefixInput(prefix).split('/').filter(Boolean);
  return segments[segments.length - 1] ?? prefix;
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function treeNodeLabel(node: TreeDataNode): string {
  const title = node.title;
  if (typeof title === 'string') {
    return title;
  }
  return String(node.key);
}

function DeleteConfirmContent({ targets }: { targets: ObjectItem[] }): React.JSX.Element {
  const { t } = useI18n();
  const visibleTargets = targets.slice(0, 6);
  const folderTargets = targets.filter((object) => object.isFolder);
  return (
    <Space className="delete-confirm-content" direction="vertical" size={6}>
      <Typography.Text type="secondary">
        {t('explorer.deleteRefreshHint')}
      </Typography.Text>
      {folderTargets.length > 0 ? (
        <Typography.Text type="danger">
          {t('explorer.deleteFolderWarning')}
        </Typography.Text>
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

function FolderTreeScanPlaceholderLabel(): React.JSX.Element {
  const { t } = useI18n();
  return <span>{t('explorer.loadingMoreFolders')}</span>;
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
    <Space className="rename-confirm-content" direction="vertical" size={8}>
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

function safeText(value: string | undefined): string {
  return value ?? '';
}
