import type { TaskItem } from '@shared/types';

export function formatTaskPath(
  task: Pick<TaskItem, 'type' | 'source' | 'target'>,
  field: 'source' | 'target'
): string {
  const path = task[field];
  const isLocal =
    (task.type === 'upload' && field === 'source') ||
    (task.type === 'download' && field === 'target');
  if (isLocal) {
    if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
    if (path.startsWith('\\\\?\\') && /^[a-z]:\\/i.test(path.slice(4))) return path.slice(4);
  }
  return path;
}
