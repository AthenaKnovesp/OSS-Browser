import {
  BellOutlined,
  CloseOutlined,
  CloudOutlined,
  DeleteOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  MinusOutlined
} from '@ant-design/icons';
import {
  Badge,
  Button,
  DatePicker,
  Empty,
  Flex,
  List,
  Popover,
  Select,
  Tag,
  Typography
} from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLogStore } from '@renderer/stores/logStore';
import type { SemanticTagColor } from '@renderer/types/ui';
import { formatDate } from '@renderer/utils/formatDate';
import type { LogEntry, LogLevel } from '@shared/types';
import { useI18n } from '@renderer/i18n';

type LogFilterValue = 'all' | LogLevel;

const logLevelColors: Record<LogLevel, SemanticTagColor> = {
  info: 'processing',
  warn: 'warning',
  error: 'error',
  success: 'success'
};

export function TitleBar(): React.JSX.Element {
  const { t } = useI18n();
  const logs = useLogStore((state) => state.logs);
  const clearLogs = useLogStore((state) => state.clearLogs);
  const [isMaximized, setIsMaximized] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [selectedLogDate, setSelectedLogDate] = useState<Dayjs | null>(() => dayjs());
  const [selectedLogFilter, setSelectedLogFilter] = useState<LogFilterValue>('all');
  const [viewedErrorIds, setViewedErrorIds] = useState<Set<string>>(() => new Set());
  const filteredLogs = useMemo(
    () =>
      logs.filter((log) => {
        const matchesDate = selectedLogDate
          ? dayjs(log.timestamp).isSame(selectedLogDate, 'day')
          : true;
        const matchesLevel = selectedLogFilter === 'all' || log.level === selectedLogFilter;
        return matchesDate && matchesLevel;
      }),
    [logs, selectedLogDate, selectedLogFilter]
  );
  const notificationLogs = useMemo(() => filteredLogs.slice(-80).reverse(), [filteredLogs]);
  const notificationCountText = useMemo(() => {
    const hasFilter = Boolean(selectedLogDate) || selectedLogFilter !== 'all';
    const filteredCount = filteredLogs.length;
    const visibleCount = notificationLogs.length;

    if (filteredCount > visibleCount) {
      return hasFilter
        ? t('logs.visibleFilteredCount', {
            visible: visibleCount,
            filtered: filteredCount,
            total: logs.length
          })
        : t('logs.visibleCount', { visible: visibleCount, total: logs.length });
    }
    return hasFilter
      ? t('logs.filteredCount', { filtered: filteredCount, total: logs.length })
      : t('logs.count', { count: logs.length });
  }, [
    filteredLogs.length,
    logs.length,
    notificationLogs.length,
    selectedLogDate,
    selectedLogFilter,
    t
  ]);
  const logFilterOptions = useMemo<Array<{ value: LogFilterValue; label: string }>>(
    () => [
      { value: 'all', label: t('logs.all') },
      { value: 'info', label: 'info' },
      { value: 'warn', label: 'warn' },
      { value: 'error', label: 'error' },
      { value: 'success', label: 'success' }
    ],
    [t]
  );
  const errorLogIds = useMemo(
    () => logs.filter((log) => log.level === 'error').map((log) => log.id),
    [logs]
  );
  const unreadErrorCount = useMemo(
    () => errorLogIds.filter((id) => !viewedErrorIds.has(id)).length,
    [errorLogIds, viewedErrorIds]
  );
  const openNotifications = useCallback((): void => {
    setNotificationOpen(true);
    setViewedErrorIds(new Set(errorLogIds));
  }, [errorLogIds]);
  const clearAllLogs = useCallback((): void => {
    setViewedErrorIds(new Set());
    void clearLogs();
  }, [clearLogs]);

  useEffect(() => {
    void window.ossApi
      .isWindowMaximized()
      .then(setIsMaximized)
      .catch(() => undefined);
    return window.ossApi.onWindowMaximizedChanged(setIsMaximized);
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <CloudOutlined className="brand-icon" />
        <strong>OSS Browser</strong>
      </div>
      <Flex className="titlebar-right" align="center" gap={10}>
        <Popover
          trigger="click"
          open={notificationOpen}
          onOpenChange={(open) => {
            if (open) {
              openNotifications();
            } else {
              setNotificationOpen(false);
            }
          }}
          placement="bottomRight"
          title={
            <Flex className="notification-title" align="center" justify="space-between">
              <Typography.Text className="notification-heading" strong>
                {t('logs.title')}
              </Typography.Text>
              <DatePicker
                className="notification-date-filter"
                size="small"
                allowClear
                value={selectedLogDate}
                onChange={(value) => setSelectedLogDate(value)}
              />
              <Select
                className="notification-level-filter"
                size="small"
                value={selectedLogFilter}
                options={logFilterOptions}
                onChange={setSelectedLogFilter}
              />
              <Typography.Text className="notification-count" type="secondary">
                {notificationCountText}
              </Typography.Text>
              <Button
                size="small"
                type="text"
                icon={<DeleteOutlined />}
                disabled={logs.length === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  clearAllLogs();
                }}
              />
            </Flex>
          }
          content={
            <div className="notification-popover">
              {notificationLogs.length > 0 ? (
                <List
                  size="small"
                  dataSource={notificationLogs}
                  renderItem={(log) => {
                    const message = notificationMessage(log);
                    return (
                      <List.Item className="notification-item">
                        <Typography.Text className="notification-time" type="secondary">
                          {formatDate(log.timestamp)}
                        </Typography.Text>
                        <Tag className="notification-level" color={logTagColor(log)}>
                          {logTagText(log)}
                        </Tag>
                        <Typography.Text
                          className="notification-message"
                          title={message}
                        >
                          {message}
                        </Typography.Text>
                      </List.Item>
                    );
                  }}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('logs.empty')} />
              )}
            </div>
          }
        >
          <Button
            className="notification-button"
            type="text"
            icon={
              <Badge size="small" count={unreadErrorCount} overflowCount={99}>
                <BellOutlined />
              </Badge>
            }
          />
        </Popover>
        <span className="title-separator" />
        <Button
          className="window-button"
          type="text"
          icon={<MinusOutlined />}
          onClick={() => void window.ossApi.windowMinimize()}
        />
        <Button
          className="window-button"
          type="text"
          icon={isMaximized ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
          onClick={() => {
            void window.ossApi
              .windowMaximize()
              .then(() => window.ossApi.isWindowMaximized())
              .then(setIsMaximized)
              .catch(() => undefined);
          }}
        />
        <Button
          className="window-button danger"
          type="text"
          icon={<CloseOutlined />}
          onClick={() => void window.ossApi.windowClose()}
        />
      </Flex>
    </div>
  );
}

function notificationMessage(log: LogEntry): string {
  return log.detail ? `${log.message} ${log.detail}` : log.message;
}

function logTagText(log: LogEntry): string {
  return log.level;
}

function logTagColor(log: LogEntry): SemanticTagColor {
  return logLevelColors[log.level];
}
