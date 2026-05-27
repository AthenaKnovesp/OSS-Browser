import { CloseOutlined, PushpinOutlined } from '@ant-design/icons';
import { Button, Flex } from 'antd';
import { useShallow } from 'zustand/react/shallow';
import { ObjectDetails } from '@renderer/components/ObjectDetails';
import { useI18n } from '@renderer/i18n';
import { useAppStore } from '@renderer/stores/appStore';
import { useObjectStore } from '@renderer/stores/objectStore';

interface Props {
  onDownload: () => void;
  onCopyPath: () => void;
  onCopyUrl: () => void;
  onDelete: () => void;
}

export function DetailPanel(props: Props): React.JSX.Element | null {
  const { t } = useI18n();
  const { config, setDetailVisible } = useAppStore(
    useShallow((state) => ({
      config: state.config,
      setDetailVisible: state.setDetailVisible
    }))
  );
  const { selectedObject, currentBucket } = useObjectStore(
    useShallow((state) => ({
      selectedObject: state.selectedObject,
      currentBucket: state.currentBucket
    }))
  );
  const activeConnection = config?.connections.find((connection) => connection.id === config.activeConnectionId);

  return (
    <div className="detail-panel">
      <Flex className="panel-title" align="center" justify="space-between">
        <span>
          <PushpinOutlined /> {t('object.details')}
        </span>
        <Button className="icon-button" type="text" size="small" icon={<CloseOutlined />} onClick={() => setDetailVisible(false)} />
      </Flex>
      <ObjectDetails
        object={selectedObject}
        bucketName={currentBucket}
        connectionName={activeConnection?.profileName}
        endpoint={activeConnection?.endpoint}
        region={activeConnection?.region}
        {...props}
      />
    </div>
  );
}

