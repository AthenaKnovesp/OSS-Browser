import {
  CloudDownloadOutlined,
  CopyOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  SearchOutlined
} from '@ant-design/icons';
import {
  App,
  Button,
  Card,
  DatePicker,
  Empty,
  Flex,
  Input,
  InputNumber,
  message,
  Select,
  Space,
  Table,
  Tag,
  Typography
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ObjectItem } from '@shared/types';
import { useAppStore } from '@renderer/stores/appStore';
import { useConnectionStore } from '@renderer/stores/connectionStore';
import { useObjectStore } from '@renderer/stores/objectStore';
import {
  matchesObjectSearch,
  objectDisplayName,
  objectIdentityKey
} from '@renderer/utils/objectDisplay';
import { formatDate } from '@renderer/utils/formatDate';
import { formatSize } from '@renderer/utils/formatSize';
import { normalizeFolderPrefixInput, parentPrefix } from '@renderer/utils/objectKey';
import { useI18n } from '@renderer/i18n';

const { RangePicker } = DatePicker;
const SEARCH_PAGE_SIZE = 1000;

type SearchScope = 'current' | 'bucket' | 'prefix';

interface SearchCriteria {
  term: string;
  prefix: string;
  suffix: string;
  minSize?: number;
  maxSize?: number;
  modifiedRange?: [Dayjs | null, Dayjs | null] | null;
}

interface RemoteCursor {
  bucket: string;
  prefix: string;
  continuationToken?: string;
  complete: boolean;
  scannedPages: number;
}

export function SearchPage(): React.JSX.Element {
  const { t } = useI18n();
  const { modal } = App.useApp();
  const { config, setActiveActivity } = useAppStore(
    useShallow((state) => ({
      config: state.config,
      setActiveActivity: state.setActiveActivity
    }))
  );
  const buckets = useConnectionStore((state) => state.buckets);
  const {
    currentBucket,
    currentConnectionId,
    currentPrefix,
    objects,
    setBucket,
    setPrefix,
    loadObjects
  } = useObjectStore(
    useShallow((state) => ({
      currentBucket: state.currentBucket,
      currentConnectionId: state.currentConnectionId,
      currentPrefix: state.currentPrefix,
      objects: state.objects,
      setBucket: state.setBucket,
      setPrefix: state.setPrefix,
      loadObjects: state.loadObjects
    }))
  );
  const activeConnection = config?.connections.find(
    (connection) => connection.id === config.activeConnectionId
  );
  const [scope, setScope] = useState<SearchScope>('current');
  const [bucket, setBucketName] = useState(currentBucket ?? activeConnection?.defaultBucket ?? '');
  const [term, setTerm] = useState('');
  const [prefix, setPrefixInput] = useState(currentPrefix);
  const [suffix, setSuffix] = useState('');
  const [minSize, setMinSize] = useState<number | undefined>();
  const [maxSize, setMaxSize] = useState<number | undefined>();
  const [modifiedRange, setModifiedRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [results, setResults] = useState<ObjectItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<RemoteCursor>();
  const cursorRef = useRef<RemoteCursor | undefined>(undefined);

  const criteria = useMemo<SearchCriteria>(
    () => ({
      term,
      prefix,
      suffix,
      minSize,
      maxSize,
      modifiedRange
    }),
    [maxSize, minSize, modifiedRange, prefix, suffix, term]
  );

  const currentDirectoryResults = useMemo(
    () => objects.filter((object) => matchesObject(object, criteria)),
    [criteria, objects]
  );
  const displayResults = scope === 'current' ? currentDirectoryResults : results;
  const hasMoreRemote = Boolean(cursor && !cursor.complete);

  const loadNextRemotePage = useCallback(
    async (nextCursor = cursorRef.current, replace = false): Promise<void> => {
      if (!nextCursor || nextCursor.complete) {
        return;
      }
      setLoading(true);
      try {
        const working: RemoteCursor = { ...nextCursor };
        const page = await window.ossApi.listObjectsFlat(
          working.bucket,
          working.prefix,
          working.continuationToken,
          SEARCH_PAGE_SIZE
        );
        const matches = page.objects.filter((object) => matchesObject(object, criteria));
        setResults((current) => (replace ? matches : mergeSearchResults(current, matches)));

        if (page.isTruncated && page.nextContinuationToken) {
          working.continuationToken = page.nextContinuationToken;
        } else {
          working.continuationToken = undefined;
          working.complete = true;
        }
        working.scannedPages += 1;
        cursorRef.current = working;
        setCursor(working);
      } finally {
        setLoading(false);
      }
    },
    [criteria]
  );

  const startSearch = useCallback((): void => {
    if (scope === 'current') {
      setResults([]);
      setCursor(undefined);
      cursorRef.current = undefined;
      return;
    }
    const selectedBucket = bucket || currentBucket;
    if (!selectedBucket) {
      modal.warning({ title: t('explorer.selectBucketFirst') });
      return;
    }
    const rootPrefix = scope === 'prefix' ? normalizeFolderPrefixInput(prefix) : '';
    const nextCursor: RemoteCursor = {
      bucket: selectedBucket,
      prefix: rootPrefix,
      continuationToken: undefined,
      complete: false,
      scannedPages: 0
    };
    setResults([]);
    setCursor(nextCursor);
    cursorRef.current = nextCursor;
    void loadNextRemotePage(nextCursor, true).catch((error) => {
      modal.error({ title: error.message });
    });
  }, [bucket, currentBucket, loadNextRemotePage, modal, prefix, scope, t]);

  const openInExplorer = useCallback(
    async (object: ObjectItem): Promise<void> => {
      const targetPrefix = object.isFolder ? object.key : parentPrefix(object.key);
      setBucket(object.bucket, activeConnection?.id ?? currentConnectionId);
      setPrefix(targetPrefix);
      setActiveActivity('explorer');
      await loadObjects(object.bucket, targetPrefix, activeConnection?.id ?? currentConnectionId);
    },
    [
      activeConnection?.id,
      currentConnectionId,
      loadObjects,
      setActiveActivity,
      setBucket,
      setPrefix
    ]
  );

  const downloadObject = useCallback(async (object: ObjectItem): Promise<void> => {
    if (object.isFolder) {
      return;
    }
    await window.ossApi.downloadObject({
      bucket: object.bucket,
      key: object.key,
      size: object.size
    });
  }, []);

  const deleteObject = useCallback(
    (object: ObjectItem): void => {
      modal.confirm({
        title: object.isFolder ? t('search.confirmDeleteFolder') : t('search.confirmDeleteObject'),
        content: object.isFolder
          ? t('search.deleteFolderContent', { key: object.key })
          : object.key,
        okText: t('common.delete'),
        okButtonProps: { danger: true },
        centered: true,
        onOk: async () => {
          await window.ossApi.deleteObject({ bucket: object.bucket, key: object.key });
        }
      });
    },
    [modal, t]
  );

  const columns: ColumnsType<ObjectItem> = useMemo(
    () => [
      {
        title: t('object.name'),
        dataIndex: 'name',
        width: 280,
        ellipsis: { showTitle: false },
        render: (_value, record) => (
          <Typography.Text className="ellipsis-text" title={record.key}>
            {objectDisplayName(record)}
          </Typography.Text>
        )
      },
      {
        title: 'Bucket',
        dataIndex: 'bucket',
        width: 150,
        ellipsis: true
      },
      {
        title: t('object.size'),
        width: 86,
        render: (_value, record) => (record.isFolder ? '-' : formatSize(record.size))
      },
      {
        title: t('common.type'),
        dataIndex: 'type',
        width: 150,
        ellipsis: true,
        render: (value: string) => (value === 'Folder' ? t('common.folder') : value)
      },
      {
        title: t('object.lastModified'),
        width: 132,
        render: (_value, record) => formatDate(record.lastModified)
      },
      {
        title: t('tasks.actions'),
        width: 178,
        render: (_value, record) => (
          <Space size={4}>
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={() => void openInExplorer(record)}
            >
              {t('common.open')}
            </Button>
            <Button
              size="small"
              icon={<CloudDownloadOutlined />}
              disabled={record.isFolder}
              onClick={() => void downloadObject(record)}
            />
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => void copyText(record.key, t('explorer.keyCopied'))}
            />
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => deleteObject(record)}
            />
          </Space>
        )
      }
    ],
    [deleteObject, downloadObject, openInExplorer, t]
  );

  return (
    <div className="page search-page">
      <Card
        className="page-card search-card"
        title={
          <Flex align="center" gap={10}>
            <Typography.Text strong>{t('search.title')}</Typography.Text>
            <Tag color="default">{t('search.resultCount', { count: displayResults.length })}</Tag>
            {scope !== 'current' ? (
              <Tag>{t('search.scannedPages', { count: cursor?.scannedPages ?? 0 })}</Tag>
            ) : null}
          </Flex>
        }
      >
        <div className="search-toolbar">
          <Select
            className="search-scope-select"
            value={scope}
            options={[
              { value: 'current', label: t('search.currentDirectory') },
              { value: 'bucket', label: t('search.currentBucket') },
              { value: 'prefix', label: t('search.specificPrefix') }
            ]}
            onChange={setScope}
          />
          <Select
            className="search-bucket-select"
            placeholder="Bucket"
            value={bucket || currentBucket || undefined}
            disabled={scope === 'current'}
            options={buckets.map((item) => ({ value: item.name, label: item.name }))}
            onChange={setBucketName}
          />
          <Input
            className="search-text-input"
            allowClear
            prefix={<SearchOutlined />}
            placeholder={t('search.nameContains')}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onPressEnter={startSearch}
          />
          <Input
            className="search-small-input"
            allowClear
            placeholder={t('search.prefix')}
            value={prefix}
            disabled={scope === 'bucket'}
            onChange={(event) => setPrefixInput(event.target.value)}
          />
          <Input
            className="search-small-input"
            allowClear
            placeholder={t('search.suffix')}
            value={suffix}
            onChange={(event) => setSuffix(event.target.value)}
          />
          <InputNumber
            className="search-number-input"
            min={0}
            placeholder={t('search.minBytes')}
            value={minSize}
            onChange={(value) => setMinSize(value ?? undefined)}
          />
          <InputNumber
            className="search-number-input"
            min={0}
            placeholder={t('search.maxBytes')}
            value={maxSize}
            onChange={(value) => setMaxSize(value ?? undefined)}
          />
          <RangePicker
            className="search-date-range"
            value={modifiedRange}
            showTime
            onChange={(value) => setModifiedRange(value)}
          />
          <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={startSearch}>
            {t('search.search')}
          </Button>
          {scope !== 'current' ? (
            <Button
              disabled={!hasMoreRemote}
              loading={loading}
              onClick={() =>
                void loadNextRemotePage().catch((error) => {
                  modal.error({ title: error.message });
                })
              }
            >
              {t('object.loadMore')}
            </Button>
          ) : null}
        </div>
        <Table
          className="search-results-table"
          size="small"
          rowKey={objectIdentityKey}
          columns={columns}
          dataSource={displayResults}
          pagination={{ pageSize: 50, size: 'small', showSizeChanger: true }}
          tableLayout="fixed"
          scroll={{ x: 1020, y: 420 }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={scope === 'current' ? t('search.currentEmpty') : t('search.setCriteria')}
              />
            )
          }}
        />
      </Card>
    </div>
  );
}

function matchesObject(object: ObjectItem, criteria: SearchCriteria): boolean {
  const term = criteria.term.trim().toLowerCase();
  const prefix = normalizeFolderPrefixInput(criteria.prefix);
  const suffix = criteria.suffix.trim().toLowerCase();
  if (term && !matchesObjectSearch(object, term)) {
    return false;
  }
  if (prefix && !object.key.startsWith(prefix)) {
    return false;
  }
  if (suffix && !object.key.toLowerCase().endsWith(suffix)) {
    return false;
  }
  if (criteria.minSize !== undefined || criteria.maxSize !== undefined) {
    if (object.isFolder || object.size === undefined) {
      return false;
    }
    if (criteria.minSize !== undefined && object.size < criteria.minSize) {
      return false;
    }
    if (criteria.maxSize !== undefined && object.size > criteria.maxSize) {
      return false;
    }
  }
  const [start, end] = criteria.modifiedRange ?? [];
  if ((start || end) && !object.lastModified) {
    return false;
  }
  const modified = object.lastModified ? dayjs(object.lastModified) : undefined;
  if (start && modified?.isBefore(start)) {
    return false;
  }
  if (end && modified?.isAfter(end)) {
    return false;
  }
  return true;
}

function mergeSearchResults(current: ObjectItem[], next: ObjectItem[]): ObjectItem[] {
  if (next.length === 0) {
    return current;
  }
  const map = new Map(current.map((object) => [objectIdentityKey(object), object]));
  for (const object of next) {
    map.set(objectIdentityKey(object), object);
  }
  return [...map.values()];
}

async function copyText(value: string, successMessage: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  message.success(successMessage);
}
