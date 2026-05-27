import { Button, Card, Flex, Tag, Typography } from 'antd';
import { useShallow } from 'zustand/react/shallow';
import { TaskTable } from '@renderer/components/TaskTable';
import { useI18n } from '@renderer/i18n';
import { useTaskStore } from '@renderer/stores/taskStore';

export function TasksPage(): React.JSX.Element {
  const { t } = useI18n();
  const { tasks, clearCompleted } = useTaskStore(
    useShallow((state) => ({
      tasks: state.tasks,
      clearCompleted: state.clearCompleted
    }))
  );
  const failedCount = tasks.filter((task) => task.status === 'failed').length;

  return (
    <div className="page">
      <Card
        className="page-card"
        title={
          <Flex align="center" gap={10}>
            <Typography.Text strong>{t('tasks.title')}</Typography.Text>
            <Tag color="default">{t('tasks.taskCount', { count: tasks.length })}</Tag>
            <Tag color={failedCount > 0 ? 'error' : 'default'}>
              {t('tasks.failedCount', { count: failedCount })}
            </Tag>
          </Flex>
        }
        extra={
          <Button size="small" onClick={() => void clearCompleted()}>
            {t('tasks.clearCompleted')}
          </Button>
        }
      >
        <TaskTable
          tasks={tasks}
          onCancel={(task) => void window.ossApi.cancelTask(task.id)}
          onRetry={(task) => void window.ossApi.retryTask(task.id)}
        />
      </Card>
    </div>
  );
}

