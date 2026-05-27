import {
  CloudDownloadOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileImageOutlined,
  FileOutlined,
  FileTextOutlined,
  FolderFilled,
  LinkOutlined,
  SwapOutlined
} from '@ant-design/icons';
import { Button, Dropdown, Empty, Space, Spin, Typography } from 'antd';
import { Table } from 'antd';
import type { TableProps } from 'antd';
import { memo, useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ObjectItem } from '@shared/types';
import {
  matchesObjectSearch,
  objectDisplayName,
  objectRowKey
} from '@renderer/utils/objectDisplay';
import { formatDate } from '@renderer/utils/formatDate';
import { formatSize } from '@renderer/utils/formatSize';
import { useI18n } from '@renderer/i18n';

interface Props {
  objects: ObjectItem[];
  loading: boolean;
  loadingMore: boolean;
  loadingAll: boolean;
  hasMoreObjects: boolean;
  selectedObjects: ObjectItem[];
  searchTerm: string;
  onLoadMore: () => void;
  onLoadAll: () => void;
  onCancelLoadAll: () => void;
  onSelect: (object: ObjectItem) => void;
  onMultiSelect: (objects: ObjectItem[]) => void;
  onOpenFolder: (object: ObjectItem) => void;
  onDownload: (object: ObjectItem) => void;
  onDelete: (object: ObjectItem) => void;
  onCopyTo: (object: ObjectItem) => void;
  onMoveTo: (object: ObjectItem) => void;
  onRename: (object: ObjectItem) => void;
  onCopyPath: (object: ObjectItem) => void;
  onCopyUrl: (object: ObjectItem) => void;
  onViewDetails: (object: ObjectItem) => void;
}

function ObjectTableComponent({
  objects,
  loading,
  loadingMore,
  loadingAll,
  hasMoreObjects,
  selectedObjects,
  searchTerm,
  onLoadMore,
  onLoadAll,
  onCancelLoadAll,
  onSelect,
  onMultiSelect,
  onOpenFolder,
  onDownload,
  onDelete,
  onCopyTo,
  onMoveTo,
  onRename,
  onCopyPath,
  onCopyUrl,
  onViewDetails
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const shellRef = useRef<HTMLDivElement>(null);
  const [tableBodyHeight, setTableBodyHeight] = useState(420);
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const hasFooter = hasMoreObjects || loadingMore || loadingAll;
  const isTableBusy = loading || loadingMore || loadingAll;
  const loadingMessage = loadingAll
    ? t('object.loadingAll')
    : loadingMore
      ? t('object.loadingMore')
      : t('object.loading');

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const updateHeight = (): void => {
      const footerHeight = hasFooter ? 42 : 0;
      const nextHeight = Math.max(
        240,
        Math.floor(shell.getBoundingClientRect().height - 40 - footerHeight)
      );
      setTableBodyHeight((current) => (current === nextHeight ? current : nextHeight));
    };

    updateHeight();
    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(shell);

    return () => resizeObserver.disconnect();
  }, [hasFooter]);

  const filtered = useMemo(() => {
    const normalizedSearch = deferredSearchTerm.trim().toLowerCase();
    if (!normalizedSearch) return objects;

    const matches: ObjectItem[] = [];
    for (const object of objects) {
      if (matchesObjectSearch(object, normalizedSearch)) {
        matches.push(object);
      }
    }
    return matches;
  }, [objects, deferredSearchTerm]);

  const columns: TableProps<ObjectItem>['columns'] = useMemo(
    () => [
      {
        title: t('object.name'),
        dataIndex: 'name',
        width: 360,
        ellipsis: true,
        render: (_value, record) => {
          const displayName = objectDisplayName(record);
          return (
            <Dropdown
              trigger={['contextMenu']}
              menu={{
                items: [
                  { key: 'details', icon: <EyeOutlined />, label: t('object.details') },
                  {
                    key: 'download',
                    icon: <CloudDownloadOutlined />,
                    label: t('common.download'),
                    disabled: record.isFolder
                  },
                  { key: 'copyTo', icon: <CopyOutlined />, label: t('common.copyTo') },
                  { key: 'moveTo', icon: <SwapOutlined />, label: t('common.moveTo') },
                  { key: 'rename', icon: <EditOutlined />, label: t('common.rename') },
                  { key: 'copyPath', icon: <CopyOutlined />, label: t('object.copyKey') },
                  {
                    key: 'copyUrl',
                    icon: <LinkOutlined />,
                    label: t('object.copyUrl'),
                    disabled: record.isFolder
                  },
                  { key: 'delete', icon: <DeleteOutlined />, label: t('common.delete'), danger: true }
                ],
                onClick: ({ key }) => {
                  onSelect(record);
                  if (key === 'details') onViewDetails(record);
                  if (key === 'download') onDownload(record);
                  if (key === 'copyTo') onCopyTo(record);
                  if (key === 'moveTo') onMoveTo(record);
                  if (key === 'rename') onRename(record);
                  if (key === 'copyPath') onCopyPath(record);
                  if (key === 'copyUrl') onCopyUrl(record);
                  if (key === 'delete') onDelete(record);
                }
              }}
            >
              <span className="object-name-cell">
                <Space className="object-name" size={10}>
                  {iconFor(record)}
                  <span className="ellipsis-text" title={displayName}>
                    {displayName}
                  </span>
                </Space>
              </span>
            </Dropdown>
          );
        }
      },
      {
        title: t('object.size'),
        width: 88,
        ellipsis: true,
        shouldCellUpdate: (record, previousRecord) =>
          record.size !== previousRecord.size || record.isFolder !== previousRecord.isFolder,
        render: (_value, record) => {
          const value = record.isFolder ? '-' : formatSize(record.size);
          return <span title={value}>{value}</span>;
        }
      },
      {
        title: t('common.type'),
        width: 180,
        ellipsis: true,
        dataIndex: 'type',
        shouldCellUpdate: (record, previousRecord) => record.type !== previousRecord.type,
        render: (value: string) => {
          const displayValue = value === 'Folder' ? t('common.folder') : value;
          return (
          <span className="ellipsis-text" title={displayValue}>
            {displayValue}
          </span>
        );
        }
      },
      {
        title: t('object.lastModified'),
        width: 148,
        ellipsis: true,
        shouldCellUpdate: (record, previousRecord) =>
          record.lastModified !== previousRecord.lastModified,
        render: (_value, record) => {
          const value = formatDate(record.lastModified);
          return <span title={value}>{value}</span>;
        }
      },
      {
        title: t('object.storageClass'),
        width: 112,
        ellipsis: true,
        shouldCellUpdate: (record, previousRecord) =>
          record.storageClass !== previousRecord.storageClass,
        render: (_value, record) => {
          const value = record.storageClass ?? '-';
          return <span title={value}>{value}</span>;
        }
      }
    ],
    [
      onCopyPath,
      onCopyTo,
      onCopyUrl,
      onDelete,
      onDownload,
      onMoveTo,
      onRename,
      onSelect,
      onViewDetails,
      t
    ]
  );

  const selectedRowKeys = useMemo(
    () => selectedObjects.map((item) => objectRowKey(item)),
    [selectedObjects]
  );
  const rowSelection: TableProps<ObjectItem>['rowSelection'] = useMemo(
    () => ({
      type: 'checkbox',
      columnWidth: 38,
      selectedRowKeys,
      onChange: (_keys, rows) => onMultiSelect(rows),
      onSelect: (record) => onSelect(record)
    }),
    [onMultiSelect, onSelect, selectedRowKeys]
  );

  return (
    <div
      className={`object-table-shell${isTableBusy ? ' is-busy' : ''}`}
      ref={shellRef}
      aria-busy={isTableBusy}
    >
      <Table
        className="object-table"
        size="small"
        rowKey={objectRowKey}
        loading={false}
        columns={columns}
        dataSource={filtered}
        pagination={false}
        tableLayout="fixed"
        virtual
        scroll={{ x: 930, y: tableBodyHeight }}
        rowSelection={rowSelection}
        locale={{
          emptyText: (
            <Empty
              className="object-table-empty"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={deferredSearchTerm ? t('object.noMatches') : t('object.empty')}
            />
          )
        }}
        onRow={(record) => ({
          onClick: () => onSelect(record),
          onDoubleClick: () => {
            if (record.isFolder) {
              onOpenFolder(record);
            }
          },
          onContextMenu: () => {
            onSelect(record);
          }
        })}
      />
      {isTableBusy ? (
        <div className="object-table-loading-mask" aria-live="polite">
          <Space direction="vertical" align="center" size={10}>
            <Spin size="large" />
            <Typography.Text type="secondary">{loadingMessage}</Typography.Text>
            {loadingAll ? (
              <Button
                className="object-table-cancel-load-button"
                type="primary"
                size="small"
                onClick={onCancelLoadAll}
              >
                {t('object.cancelLoadAll')}
              </Button>
            ) : null}
          </Space>
        </div>
      ) : null}
      {hasFooter ? (
        <div className="object-table-footer">
          <Typography.Text type="secondary">
            {t('object.loadedCount', {
              count: objects.length,
              suffix: loadingAll ? t('object.loadingAllSuffix') : ''
            })}
          </Typography.Text>
          {!loadingAll ? (
            <Space size={8}>
              <Dropdown.Button
                size="small"
                loading={loadingMore}
                disabled={!hasMoreObjects}
                onClick={onLoadMore}
                menu={{
                  items: [{ key: 'loadAll', label: t('object.loadAll'), disabled: loadingMore }],
                  onClick: ({ key }) => {
                    if (key === 'loadAll') {
                      onLoadAll();
                    }
                  }
                }}
              >
                {t('object.loadMore')}
              </Dropdown.Button>
            </Space>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const ObjectTable = memo(ObjectTableComponent);

function iconFor(record: ObjectItem): React.JSX.Element {
  if (record.isFolder) {
    return <FolderFilled className="file-icon folder" />;
  }
  const type = record.type ?? '';
  if (type.startsWith('image/')) {
    return <FileImageOutlined className="file-icon image" />;
  }
  if (type.startsWith('text/') || type.includes('json')) {
    return <FileTextOutlined className="file-icon text" />;
  }
  return <FileOutlined className="file-icon file" />;
}
