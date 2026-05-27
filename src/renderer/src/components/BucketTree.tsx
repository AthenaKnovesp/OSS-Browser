import {
  CloudServerOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined
} from '@ant-design/icons';
import {
  Button,
  Dropdown,
  Empty,
  Modal,
  Space,
  Spin,
  Tree,
  Typography,
  message
} from 'antd';
import type { TreeDataNode } from 'antd';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@renderer/stores/appStore';
import { useConnectionStore } from '@renderer/stores/connectionStore';
import { useObjectStore } from '@renderer/stores/objectStore';
import { useI18n } from '@renderer/i18n';

type SidebarTreeKey = `connection:${string}` | `bucket:${string}`;

export function BucketTree(): React.JSX.Element {
  const { t } = useI18n();
  const {
    buckets,
    clearBuckets,
    connectionStatuses,
    loading,
    loadBuckets,
    removeConnectionStatus,
    setConnectionStatus
  } = useConnectionStore(
    useShallow((state) => ({
      buckets: state.buckets,
      clearBuckets: state.clearBuckets,
      connectionStatuses: state.connectionStatuses,
      loading: state.loading,
      loadBuckets: state.loadBuckets,
      removeConnectionStatus: state.removeConnectionStatus,
      setConnectionStatus: state.setConnectionStatus
    }))
  );
  const {
    config,
    setActiveActivity,
    setConfig,
    setEditingConnectionId,
    setSettingsMode,
    setSettingsOpen
  } = useAppStore(
    useShallow((state) => ({
      config: state.config,
      setActiveActivity: state.setActiveActivity,
      setConfig: state.setConfig,
      setEditingConnectionId: state.setEditingConnectionId,
      setSettingsMode: state.setSettingsMode,
      setSettingsOpen: state.setSettingsOpen
    }))
  );
  const { currentBucket, clearObjects, setBucket, loadObjects } = useObjectStore(
    useShallow((state) => ({
      currentBucket: state.currentBucket,
      clearObjects: state.clearObjects,
      setBucket: state.setBucket,
      loadObjects: state.loadObjects
    }))
  );
  const connections = config?.connections ?? [];
  const activeConnection = connections.find(
    (connection) => connection.id === config?.activeConnectionId
  );

  const handleConnectionChange = async (connectionId: string): Promise<void> => {
    if (activeConnection?.id && connectionStatuses[activeConnection.id] === 'connected') {
      setConnectionStatus(activeConnection.id, 'closed');
    }
    clearBuckets();
    clearObjects();
    try {
      const nextConfig = await window.ossApi.setActiveConnection(connectionId);
      setConfig(nextConfig);
      await loadBuckets(connectionId);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    }
  };

  const handleBucketChange = async (bucket: string): Promise<void> => {
    try {
      setBucket(bucket, activeConnection?.id);
      setActiveActivity('explorer');
      await loadObjects(bucket, '', activeConnection?.id);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    }
  };

  const handleTreeSelect = (selectedKeys: React.Key[]): void => {
    const selectedKey = selectedKeys[0]?.toString() as SidebarTreeKey | undefined;
    if (!selectedKey) return;

    if (selectedKey.startsWith('connection:')) {
      const connectionId = selectedKey.replace('connection:', '');
      if (connectionId !== activeConnection?.id) {
        void handleConnectionChange(connectionId);
      }
      return;
    }

    const bucket = selectedKey.replace('bucket:', '');
    void handleBucketChange(bucket);
  };

  const openConnectionEditor = (connectionId: string | null): void => {
    setEditingConnectionId(connectionId);
    setSettingsMode('connection');
    setSettingsOpen(true);
  };

  const deleteConnection = (connectionId: string): void => {
    const connection = connections.find((item) => item.id === connectionId);
    Modal.confirm({
      title: t('sidebar.deleteConnectionTitle'),
      centered: true,
      content: connection?.profileName,
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const nextConfig = await window.ossApi.deleteConnection(connectionId);
          setConfig(nextConfig);
          removeConnectionStatus(connectionId);
          if (connectionId === activeConnection?.id) {
            clearBuckets();
            clearObjects();
          }
          message.success(t('sidebar.connectionDeleted'));
        } catch (error) {
          if (error instanceof Error) message.error(error.message);
        }
      }
    });
  };

  const treeData: TreeDataNode[] = connections.map((connection) => {
    const isActive = connection.id === activeConnection?.id;
    const connectionStatus = connectionStatuses[connection.id] ?? 'closed';
    return {
      key: `connection:${connection.id}`,
      icon: (
        <span className="connection-tree-icon-wrap">
          <CloudServerOutlined />
          <span className={`connection-status-dot ${connectionStatus}`} />
        </span>
      ),
      title: (
        <div className="connection-tree-row">
          <Typography.Text
            className="connection-tree-label"
            title={connection.profileName}
          >
            {connection.profileName}
          </Typography.Text>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'edit', icon: <EditOutlined />, label: t('common.edit') },
                { key: 'delete', icon: <DeleteOutlined />, label: t('common.delete'), danger: true }
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === 'edit') openConnectionEditor(connection.id);
                if (key === 'delete') deleteConnection(connection.id);
              }
            }}
          >
            <Button
              className="connection-row-action"
              type="text"
              size="small"
              icon={<MoreOutlined />}
              aria-label={t('sidebar.actionsFor', { name: connection.profileName })}
              onClick={(event) => event.stopPropagation()}
            />
          </Dropdown>
        </div>
      ),
      children: isActive
        ? buckets.map((bucket) => ({
            key: `bucket:${bucket.name}`,
            icon: <DatabaseOutlined />,
            title: (
              <Typography.Text className="bucket-tree-title" title={bucket.name}>
                {bucket.name}
              </Typography.Text>
            )
          }))
        : undefined
    };
  });

  const selectedKeys = currentBucket
    ? [`bucket:${currentBucket}`]
    : activeConnection
      ? [`connection:${activeConnection.id}`]
      : [];
  const expandedKeys = activeConnection ? [`connection:${activeConnection.id}`] : [];

  return (
    <div className="sidebar-content">
      <div className="sidebar-section-header connection-title">
        <span>
          <span className="connection-tree-icon-wrap connection-title-icon">
            <CloudServerOutlined />
          </span>
          {t('sidebar.connections')}
        </span>
        <Space size={2}>
          <Button
            className="sidebar-tool-button"
            type="text"
            size="small"
            icon={<PlusOutlined />}
            title={t('sidebar.newConnection')}
            aria-label={t('sidebar.newConnection')}
            onClick={() => {
              openConnectionEditor(null);
            }}
          />
          <Button
            className="sidebar-tool-button"
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            title={t('sidebar.refreshBuckets')}
            aria-label={t('sidebar.refreshBuckets')}
            onClick={() => {
              if (!activeConnection) {
                message.warning(t('sidebar.selectConnectionFirst'));
                return;
              }
              void loadBuckets(activeConnection.id);
            }}
          />
        </Space>
      </div>
      <div className="connection-tree-panel">
        {connections.length > 0 ? (
          <Spin spinning={loading}>
            <Tree
              blockNode
              showIcon
              className="connection-tree"
              treeData={treeData}
              selectedKeys={selectedKeys}
              expandedKeys={expandedKeys}
              onSelect={handleTreeSelect}
            />
          </Spin>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('sidebar.noConnections')} />
        )}
      </div>
      <Button
        className="sidebar-bottom-settings"
        type="text"
        icon={<SettingOutlined />}
        onClick={() => {
          setEditingConnectionId(undefined);
          setSettingsMode('preferences');
          setSettingsOpen(true);
        }}
      >
        {t('common.settings')}
      </Button>
    </div>
  );
}
