import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  MoreOutlined,
  ReloadOutlined,
  SwapOutlined
} from '@ant-design/icons';
import { Button, Dropdown, Space } from 'antd';
import { useI18n } from '@renderer/i18n';

interface Props {
  disabled?: boolean;
  hasSelection: boolean;
  hasDownloadableSelection: boolean;
  selectedCount: number;
  onUpload: () => void;
  onUploadFolder: () => void;
  onNewFolder: () => void;
  onDownload: () => void;
  onCopy: () => void;
  onMove: () => void;
  onRename: () => void;
  onDelete: () => void;
  onRefresh: () => void;
}

export function ToolbarActions({
  disabled = false,
  hasSelection,
  hasDownloadableSelection,
  selectedCount,
  onUpload,
  onUploadFolder,
  onNewFolder,
  onDownload,
  onCopy,
  onMove,
  onRename,
  onDelete,
  onRefresh
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const hasSingleSelection = selectedCount === 1;
  const selectedSuffix = selectedCount > 1 ? ` (${selectedCount})` : '';

  return (
    <Space className="toolbar-actions" size={6}>
      <Dropdown.Button
        className="toolbar-upload-button"
        type="primary"
        icon={<CloudUploadOutlined />}
        disabled={disabled}
        menu={{
          items: [{ key: 'folder', icon: <FolderOpenOutlined />, label: t('toolbar.uploadFolder') }],
          onClick: ({ key }) => {
            if (key === 'folder') {
              onUploadFolder();
            }
          }
        }}
        onClick={onUpload}
      >
        {t('toolbar.uploadFile')}
      </Dropdown.Button>
      <Button icon={<FolderAddOutlined />} disabled={disabled} onClick={onNewFolder}>
        {t('toolbar.newFolder')}
      </Button>
      <Button
        icon={<CloudDownloadOutlined />}
        disabled={disabled || !hasDownloadableSelection}
        onClick={onDownload}
      >
        {t('toolbar.downloadSelected', { suffix: selectedSuffix })}
      </Button>
      <Button icon={<ReloadOutlined />} disabled={disabled} onClick={onRefresh}>
        {t('common.refresh')}
      </Button>
      <Dropdown
        disabled={disabled}
        menu={{
          items: [
            { key: 'copy', icon: <CopyOutlined />, label: t('toolbar.copyTo'), disabled: !hasSelection },
            { key: 'move', icon: <SwapOutlined />, label: t('toolbar.moveTo'), disabled: !hasSelection },
            {
              key: 'rename',
              icon: <EditOutlined />,
              label: t('toolbar.rename'),
              disabled: !hasSingleSelection
            },
            {
              key: 'delete',
              icon: <DeleteOutlined />,
              label: t('toolbar.deleteSelected', { suffix: selectedSuffix }),
              disabled: !hasSelection,
              danger: true
            }
          ],
          onClick: ({ key }) => {
            if (key === 'copy') {
              onCopy();
            }
            if (key === 'move') {
              onMove();
            }
            if (key === 'rename') {
              onRename();
            }
            if (key === 'delete') {
              onDelete();
            }
          }
        }}
      >
        <Button icon={<MoreOutlined />} disabled={disabled}>
          {t('common.more')}
        </Button>
      </Dropdown>
    </Space>
  );
}
