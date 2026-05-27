import {
  CloudDownloadOutlined,
  CopyOutlined,
  DeleteOutlined,
  FileOutlined,
  EditOutlined,
  ExportOutlined,
  LinkOutlined
} from '@ant-design/icons';
import { Button, Descriptions, Flex, Space, Tag, Typography } from 'antd';
import { memo, useMemo } from 'react';
import type { ObjectItem } from '@shared/types';
import type { SemanticTagColor } from '@renderer/types/ui';
import { formatDate } from '@renderer/utils/formatDate';
import { formatSize } from '@renderer/utils/formatSize';
import { useI18n } from '@renderer/i18n';

interface Props {
  object?: ObjectItem;
  bucketName?: string;
  connectionName?: string;
  endpoint?: string;
  region?: string;
  showHeader?: boolean;
  showActions?: boolean;
  onDownload?: () => void;
  onCopyPath?: () => void;
  onCopyUrl?: () => void;
  onDelete?: () => void;
}

function ObjectDetailsComponent({
  object,
  bucketName,
  connectionName,
  endpoint,
  region,
  showHeader = true,
  showActions = false,
  onDownload,
  onCopyPath,
  onCopyUrl,
  onDelete
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const rows = useMemo(() => {
    if (object) {
      return [
        [t('object.name'), object.name],
        ['Bucket', object.bucket],
        [t('object.prefix'), object.prefix || '/'],
        [t('object.path'), object.key],
        [t('object.keyLength'), `${object.key.length}`],
        [t('object.size'), object.isFolder ? '-' : formatSize(object.size)],
        [t('object.rawSize'), object.size === undefined ? '-' : `${object.size} bytes`],
        [t('common.type'), object.type === 'Folder' ? t('common.folder') : object.type],
        [t('object.storageClass'), object.storageClass ?? '-'],
        [t('object.lastModified'), formatDate(object.lastModified)],
        [t('object.folder'), object.isFolder ? t('common.yes') : t('common.no')],
        ['S3 URI', `s3://${object.bucket}/${object.key}`],
        ['URL', object.url ?? `s3://${object.bucket}/${object.key}`]
      ];
    }

    return [
      ['Bucket', bucketName ?? '-'],
      ['Connection', connectionName ?? '-'],
      ['Endpoint', endpoint ?? '-'],
      ['Region', region ?? '-']
    ];
  }, [bucketName, connectionName, endpoint, object, region, t]);

  const title = object?.name ?? bucketName ?? 'Bucket';
  const kind = object ? (object.isFolder ? t('common.folder') : t('common.object')) : 'Bucket';
  const kindColor: SemanticTagColor = object?.isFolder ? 'warning' : 'processing';
  return (
    <div className="object-details">
      {showHeader ? (
        <Flex className="details-heading" align="center" gap={8}>
          <span className="details-icon">
            <FileOutlined />
          </span>
          <Typography.Text className="ellipsis-text" strong title={title}>
            {title}
          </Typography.Text>
          <Tag color={kindColor}>{kind}</Tag>
        </Flex>
      ) : null}
      <Descriptions
        className="detail-descriptions"
        column={1}
        size="small"
        bordered
        colon={false}
        items={rows.map(([label, value]) => ({
          key: label,
          label,
          children: detailText(value)
        }))}
      />
      {object && showActions ? (
        <Space direction="vertical" className="details-actions">
          <Space.Compact block>
            <Button block icon={<CloudDownloadOutlined />} disabled={object.isFolder} onClick={onDownload}>
              {t('common.download')}
            </Button>
            <Button block icon={<CopyOutlined />} onClick={onCopyPath}>
              {t('object.copyKey')}
            </Button>
          </Space.Compact>
          <Space.Compact block>
            <Button block icon={<LinkOutlined />} disabled={object.isFolder} onClick={onCopyUrl}>
              {t('object.copyUrl')}
            </Button>
            <Button block icon={<EditOutlined />} disabled>
              {t('common.rename')}
            </Button>
          </Space.Compact>
          <Space.Compact block>
            <Button block icon={<ExportOutlined />} disabled>
              {t('common.moveTo')}
            </Button>
            <Button block danger icon={<DeleteOutlined />} onClick={onDelete}>
              {t('common.delete')}
            </Button>
          </Space.Compact>
        </Space>
      ) : null}
    </div>
  );
}

export const ObjectDetails = memo(ObjectDetailsComponent);

function detailText(value: string): React.JSX.Element {
  return (
    <Typography.Text className="detail-value ellipsis-text" title={value}>
      {value}
    </Typography.Text>
  );
}

