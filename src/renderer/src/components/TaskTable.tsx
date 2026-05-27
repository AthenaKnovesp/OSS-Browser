import { CloseCircleOutlined, CopyOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  Button,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  message,
  Progress,
  Space,
  Table,
  Tag,
  Typography
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry, TaskFailureCategory, TaskItem, TaskStatus, TaskType } from '@shared/types';
import type { MessageKey } from '@shared/i18n';
import type { SemanticTagColor } from '@renderer/types/ui';
import { useI18n } from '@renderer/i18n';
import { useLogStore } from '@renderer/stores/logStore';
import { formatDate } from '@renderer/utils/formatDate';
import { formatSize } from '@renderer/utils/formatSize';

interface Props {
  tasks: TaskItem[];
  compact?: boolean;
  onCancel: (task: TaskItem) => void;
  onRetry: (task: TaskItem) => void;
}

const TASK_TABLE_WIDTH = 1052;
const DEFAULT_TABLE_BODY_HEIGHT = 420;
const TASK_TABLE_HEADER_FALLBACK_HEIGHT = 40;
const COMPACT_MIN_TABLE_BODY_HEIGHT = 108;
const DEFAULT_MIN_TABLE_BODY_HEIGHT = 180;

const statusColors: Record<TaskItem['status'], SemanticTagColor> = {
  pending: 'default',
  running: 'processing',
  paused: 'warning',
  stopped: 'default',
  success: 'success',
  partial_success: 'warning',
  failed: 'error',
  canceled: 'default'
};

const taskTypes: TaskType[] = ['upload', 'download', 'delete', 'copy', 'move', 'rename'];
const taskStatuses: TaskStatus[] = [
  'pending',
  'running',
  'paused',
  'stopped',
  'success',
  'partial_success',
  'failed',
  'canceled'
];

function TaskTableComponent({ tasks, compact, onCancel, onRetry }: Props): React.JSX.Element {
  const { t } = useI18n();
  const shellRef = useRef<HTMLDivElement>(null);
  const headerHeightRef = useRef<number | undefined>(undefined);
  const [detailTask, setDetailTask] = useState<TaskItem>();
  const [tableBodyHeight, setTableBodyHeight] = useState(DEFAULT_TABLE_BODY_HEIGHT);
  const taskTypeFilters = useMemo(
    () => taskTypes.map((value) => ({ text: taskTypeLabel(value, t), value })),
    [t]
  );
  const statusFilters = useMemo(
    () => taskStatuses.map((value) => ({ text: taskStatusLabel(value, t), value })),
    [t]
  );

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    let frameId: number | undefined;
    const updateHeight = (shellHeight: number): void => {
      if (frameId !== undefined) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        const headerHeight = headerHeightRef.current ?? measureTableHeaderHeight(shell);
        headerHeightRef.current = headerHeight;
        const minBodyHeight = compact
          ? COMPACT_MIN_TABLE_BODY_HEIGHT
          : DEFAULT_MIN_TABLE_BODY_HEIGHT;
        const nextHeight = Math.max(minBodyHeight, Math.floor(shellHeight - headerHeight - 2));
        setTableBodyHeight((current) => (current === nextHeight ? current : nextHeight));
      });
    };

    updateHeight(shell.getBoundingClientRect().height);
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        updateHeight(entry.contentRect.height);
      }
    });
    resizeObserver.observe(shell);

    return () => {
      if (frameId !== undefined) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver.disconnect();
    };
  }, [compact]);

  const columns: ColumnsType<TaskItem> = useMemo(
    () => [
      {
        title: t('tasks.name'),
        dataIndex: 'name',
        width: 176,
        ellipsis: { showTitle: false },
        shouldCellUpdate: (record, previousRecord) => record.name !== previousRecord.name,
        render: (value: string) => ellipsisText(value)
      },
      {
        title: t('tasks.type'),
        dataIndex: 'type',
        width: 82,
        ellipsis: true,
        filters: taskTypeFilters,
        onFilter: (value, record) => record.type === value,
        shouldCellUpdate: (record, previousRecord) => record.type !== previousRecord.type,
        render: (value: TaskType) => taskTypeLabel(value, t)
      },
      {
        title: t('tasks.status'),
        dataIndex: 'status',
        width: 106,
        filters: statusFilters,
        onFilter: (value, record) => record.status === value,
        shouldCellUpdate: (record, previousRecord) => record.status !== previousRecord.status,
        render: (_value, record) => (
          <Tag color={statusColors[record.status]}>{taskStatusLabel(record.status, t)}</Tag>
        )
      },
      {
        title: t('tasks.progress'),
        width: 150,
        shouldCellUpdate: (record, previousRecord) =>
          record.progress !== previousRecord.progress || record.status !== previousRecord.status,
        render: (_value, record) => (
          <div className="task-table-progress-cell">
            <Progress size="small" percent={record.progress} status={progressStatus(record)} />
          </div>
        )
      },
      {
        title: t('tasks.parts'),
        width: 76,
        shouldCellUpdate: (record, previousRecord) =>
          record.completedParts !== previousRecord.completedParts ||
          record.totalParts !== previousRecord.totalParts ||
          record.partStats?.completedParts !== previousRecord.partStats?.completedParts ||
          record.partStats?.totalParts !== previousRecord.partStats?.totalParts,
        render: (_value, record) => formatParts(record)
      },
      {
        title: t('tasks.info'),
        width: 108,
        ellipsis: { showTitle: false },
        shouldCellUpdate: (record, previousRecord) =>
          record.errorMessage !== previousRecord.errorMessage ||
          record.failure?.message !== previousRecord.failure?.message ||
          record.report?.failed !== previousRecord.report?.failed,
        render: (_value, record) => {
          const value = formatTaskInfo(record, t);
          return ellipsisText(value);
        }
      },
      {
        title: t('tasks.path'),
        width: 150,
        ellipsis: { showTitle: false },
        shouldCellUpdate: (record, previousRecord) =>
          record.source !== previousRecord.source || record.target !== previousRecord.target,
        render: (_value, record) => {
          const value = formatTaskPath(record);
          return ellipsisText(value);
        }
      },
      {
        title: t('tasks.duration'),
        width: 74,
        ellipsis: { showTitle: false },
        shouldCellUpdate: (record, previousRecord) =>
          record.status !== previousRecord.status ||
          record.startedAt !== previousRecord.startedAt ||
          record.durationMs !== previousRecord.durationMs ||
          record.updatedAt !== previousRecord.updatedAt,
        render: (_value, record) => {
          const value = formatDuration(record);
          return ellipsisText(value);
        }
      },
      {
        title: t('tasks.actions'),
        width: 112,
        shouldCellUpdate: (record, previousRecord) => record.status !== previousRecord.status,
        render: (_value, record) => (
          <Space size={4}>
            <Button
              className="task-table-action-button"
              size="small"
              title={t('tasks.viewDetails')}
              aria-label={t('tasks.viewDetails')}
              icon={<EyeOutlined />}
              onClick={() => setDetailTask(record)}
            />
            <Button
              className="task-table-action-button"
              size="small"
              title={t('tasks.cancelTask')}
              aria-label={t('tasks.cancelTask')}
              icon={<CloseCircleOutlined />}
              disabled={record.status !== 'pending' && record.status !== 'running'}
              onClick={() => onCancel(record)}
            />
            <Button
              className="task-table-action-button"
              size="small"
              title={t('tasks.retryTask')}
              aria-label={t('tasks.retryTask')}
              icon={<ReloadOutlined />}
              disabled={record.status !== 'failed'}
              onClick={() => onRetry(record)}
            />
          </Space>
        )
      }
    ],
    [onCancel, onRetry, statusFilters, taskTypeFilters, t]
  );

  return (
    <div className={`task-table-shell${compact ? ' compact' : ''}`} ref={shellRef}>
      <Table
        className="task-table"
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={tasks}
        pagination={false}
        tableLayout="fixed"
        virtual
        scroll={{ x: TASK_TABLE_WIDTH, y: tableBodyHeight }}
        locale={{
          emptyText: (
            <div className="task-table-empty">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('tasks.empty')} />
            </div>
          )
        }}
        onRow={(record) => ({
          onDoubleClick: () => setDetailTask(record)
        })}
      />
      {detailTask ? (
        <TaskDetailsDrawer task={detailTask} onClose={() => setDetailTask(undefined)} />
      ) : null}
    </div>
  );
}

export const TaskTable = memo(TaskTableComponent);

function measureTableHeaderHeight(shell: HTMLElement): number {
  return (
    shell.querySelector<HTMLElement>('.ant-table-header')?.getBoundingClientRect().height ??
    TASK_TABLE_HEADER_FALLBACK_HEIGHT
  );
}

function progressStatus(record: TaskItem): 'success' | 'exception' | 'active' | undefined {
  if (record.status === 'failed') {
    return 'exception';
  }
  if (record.status === 'success') {
    return 'success';
  }
  if (record.status === 'running') {
    return 'active';
  }
  return undefined;
}

function taskStatusLabel(
  status: TaskStatus,
  translateText: ReturnType<typeof useI18n>['t']
): string {
  return translateText(`taskStatus.${status}` as MessageKey);
}

function taskTypeLabel(type: TaskType, translateText: ReturnType<typeof useI18n>['t']): string {
  return translateText(`taskType.${type}` as MessageKey);
}

function failureCategoryLabel(
  category: TaskFailureCategory,
  translateText: ReturnType<typeof useI18n>['t']
): string {
  return translateText(`failure.${category}` as MessageKey);
}

function formatParts(record: TaskItem): string {
  if (record.partStats?.totalParts !== undefined) {
    return `${record.partStats.completedParts ?? 0}/${record.partStats.totalParts}`;
  }
  if (record.totalParts !== undefined) {
    return `${record.completedParts ?? 0}/${record.totalParts}`;
  }
  return '-';
}

function formatTaskInfo(record: TaskItem, translateText: ReturnType<typeof useI18n>['t']): string {
  if (record.errorMessage) {
    return record.errorMessage;
  }
  if (record.failure?.message) {
    return record.failure.message;
  }
  if (record.failure) {
    return failureCategoryLabel(record.failure.category, translateText);
  }
  if (record.report && record.report.failed > 0) {
    return translateText('tasks.failed', { value: record.report.failed });
  }
  return '-';
}

function formatTaskPath(record: TaskItem): string {
  const value = record.target || record.source || '';
  return value.trim() ? value : '-';
}

function formatDuration(record: TaskItem): string {
  const duration =
    record.durationMs ??
    (record.startedAt && record.status === 'running'
      ? Date.now() - new Date(record.startedAt).getTime()
      : undefined);
  if (duration === undefined || !Number.isFinite(duration)) {
    return '-';
  }

  const totalSeconds = Math.max(0, Math.floor(duration / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function TaskDetailsDrawer({
  task,
  onClose
}: {
  task: TaskItem;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const logs = useLogStore((state) => state.logs);
  const relatedLogs = useMemo(() => findRelatedLogs(logs, task), [logs, task]);
  const copyDetails = useCallback(async (): Promise<void> => {
    const detail = [
      `${t('tasks.id')}：${task.id}`,
      `${t('tasks.name')}：${task.name}`,
      `${t('tasks.type')}：${taskTypeLabel(task.type, t)}`,
      `${t('tasks.status')}：${taskStatusLabel(task.status, t)}`,
      `${t('tasks.source')}：${task.source || '-'}`,
      `${t('tasks.target')}：${task.target || '-'}`,
      `${t('tasks.info')}：${task.errorMessage ?? task.failure?.message ?? '-'}`,
      `${t('tasks.failureCategory')}：${task.failure ? failureCategoryLabel(task.failure.category, t) : '-'}`,
      `${t('tasks.recentError')}：${task.failure?.detail ?? task.errorMessage ?? '-'}`
    ].join('\n');
    await navigator.clipboard.writeText(detail);
    message.success(t('tasks.detailsCopied'));
  }, [task, t]);

  return (
    <Drawer
      title={t('tasks.detailsTitle')}
      open
      width={560}
      onClose={onClose}
      extra={
        <Button size="small" icon={<CopyOutlined />} onClick={() => void copyDetails()}>
          {t('tasks.copyDetails')}
        </Button>
      }
    >
      <Space className="task-detail-drawer" direction="vertical" size={14}>
        <Descriptions
          size="small"
          bordered
          column={1}
          items={[
            { key: 'name', label: t('tasks.name'), children: textValue(task.name) },
            { key: 'type', label: t('tasks.type'), children: taskTypeLabel(task.type, t) },
            { key: 'source', label: t('tasks.source'), children: textValue(task.source || '-') },
            { key: 'target', label: t('tasks.target'), children: textValue(task.target || '-') },
            { key: 'status', label: t('tasks.status'), children: statusTag(task, t) },
            { key: 'progress', label: t('tasks.progress'), children: `${task.progress}%` },
            {
              key: 'failure',
              label: t('tasks.info'),
              children: task.errorMessage ?? task.failure?.message ?? '-'
            },
            {
              key: 'failureCategory',
              label: t('tasks.failureCategory'),
              children: task.failure ? failureCategoryLabel(task.failure.category, t) : '-'
            },
            { key: 'retry', label: t('tasks.retries'), children: `${task.retries}/${task.maxRetries}` },
            { key: 'createdAt', label: t('tasks.createdAt'), children: formatDate(task.createdAt) },
            { key: 'startedAt', label: t('tasks.startedAt'), children: formatDate(task.startedAt) },
            { key: 'completedAt', label: t('tasks.completedAt'), children: formatDate(task.completedAt) },
            { key: 'duration', label: t('tasks.duration'), children: formatDuration(task) }
          ]}
        />
        <TaskPartSummary task={task} />
        <TaskReportSummary task={task} />
        <TaskErrorSummary task={task} />
        <RelatedLogList logs={relatedLogs} />
      </Space>
    </Drawer>
  );
}

function TaskPartSummary({ task }: { task: TaskItem }): React.JSX.Element | null {
  const { t } = useI18n();
  const stats = task.partStats;
  if (!stats && task.totalParts === undefined) {
    return null;
  }
  return (
    <div className="task-detail-section">
      <Typography.Text strong>{t('tasks.partStats')}</Typography.Text>
      <Flex gap={8} wrap="wrap">
        <Tag>{t('tasks.totalParts', { value: stats?.totalParts ?? task.totalParts ?? '-' })}</Tag>
        <Tag color="success">{t('tasks.successParts', { value: stats?.completedParts ?? task.completedParts ?? 0 })}</Tag>
        <Tag color={stats?.failedParts ? 'error' : 'default'}>{t('tasks.failedParts', { value: stats?.failedParts ?? 0 })}</Tag>
        <Tag>{t('tasks.retriedParts', { value: stats?.retriedParts ?? task.retries })}</Tag>
        <Tag>{t('tasks.activeParts', { value: stats?.activeParts ?? 0 })}</Tag>
        <Tag>{t('tasks.averageSpeed', { value: formatSize(stats?.averageSpeed) })}</Tag>
        <Tag>{t('tasks.eta', { value: formatSeconds(stats?.estimatedSecondsRemaining) })}</Tag>
      </Flex>
    </div>
  );
}

function TaskReportSummary({ task }: { task: TaskItem }): React.JSX.Element | null {
  const { t } = useI18n();
  const report = task.report;
  if (!report) {
    return null;
  }
  return (
    <div className="task-detail-section">
      <Typography.Text strong>{t('tasks.batchReport')}</Typography.Text>
      <Flex gap={8} wrap="wrap">
        <Tag>{t('tasks.total', { value: report.total })}</Tag>
        <Tag color="success">{t('tasks.success', { value: report.success })}</Tag>
        <Tag>{t('tasks.skipped', { value: report.skipped })}</Tag>
        <Tag color={report.failed > 0 ? 'error' : 'default'}>{t('tasks.failed', { value: report.failed })}</Tag>
      </Flex>
      {report.failedItems.length > 0 ? (
        <Table
          className="task-failed-items-table"
          size="small"
          rowKey={(item) => `${item.key}:${item.reason}`}
          pagination={{ pageSize: 5, size: 'small' }}
          dataSource={report.failedItems}
          columns={[
            {
              title: 'Key',
              dataIndex: 'key',
              ellipsis: true,
              render: (value: string) => ellipsisText(value)
            },
            {
              title: t('tasks.reason'),
              dataIndex: 'reason',
              ellipsis: true,
              render: (value: string) => ellipsisText(value)
            },
            {
              title: t('tasks.type'),
              dataIndex: 'category',
              width: 92,
              render: (value: TaskFailureCategory) => failureCategoryLabel(value, t)
            }
          ]}
        />
      ) : null}
    </div>
  );
}

function TaskErrorSummary({ task }: { task: TaskItem }): React.JSX.Element | null {
  const { t } = useI18n();
  if (!task.errorMessage && !task.failure?.detail) {
    return null;
  }
  const value = [task.errorMessage, task.failure?.detail].filter(Boolean).join('\n');
  return (
    <div className="task-detail-section">
      <Typography.Text strong>{t('tasks.recentError')}</Typography.Text>
      <Typography.Paragraph className="task-error-block" copyable>
        {value}
      </Typography.Paragraph>
    </div>
  );
}

function RelatedLogList({ logs }: { logs: LogEntry[] }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="task-detail-section">
      <Typography.Text strong>{t('tasks.relatedLogs')}</Typography.Text>
      {logs.length > 0 ? (
        <Space direction="vertical" size={6} className="task-related-logs">
          {logs.slice(0, 8).map((log) => (
            <Typography.Text key={log.id} className="task-related-log" type="secondary">
              {formatDate(log.timestamp)} · {log.operation ?? log.level} · {log.message}
            </Typography.Text>
          ))}
        </Space>
      ) : (
        <Typography.Text type="secondary">{t('tasks.noRelatedLogs')}</Typography.Text>
      )}
    </div>
  );
}

function findRelatedLogs(logs: LogEntry[], task: TaskItem): LogEntry[] {
  return logs
    .filter((log) => {
      if (log.taskId === task.id) {
        return true;
      }
      const text = `${log.message} ${log.detail ?? ''}`;
      return Boolean(task.name && text.includes(task.name));
    })
    .slice(-20)
    .reverse();
}

function statusTag(task: TaskItem, translateText: ReturnType<typeof useI18n>['t']): React.JSX.Element {
  return <Tag color={statusColors[task.status]}>{taskStatusLabel(task.status, translateText)}</Tag>;
}

function textValue(value: string): React.JSX.Element {
  return ellipsisText(value);
}

function ellipsisText(value: string): React.JSX.Element {
  return (
    <Typography.Text className="ellipsis-text" title={value}>
      {value}
    </Typography.Text>
  );
}

function formatSeconds(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  if (value < 60) {
    return `${value}s`;
  }
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}m ${seconds}s`;
}
