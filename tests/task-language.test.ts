import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ColumnType } from 'antd/es/table';
import { expect, it, vi } from 'vitest';
import type { TaskItem } from '../src/shared/types';
import { TaskTable } from '../src/renderer/src/components/TaskTable';
import { translate } from '../src/shared/i18n';

const captured = vi.hoisted(() => ({
  columns: [] as ColumnType<TaskItem>[],
  language: 'zh-CN' as 'zh-CN' | 'en-US'
}));
vi.mock('../src/renderer/src/i18n', () => ({
  useI18n: () => ({
    t: (key: Parameters<typeof translate>[1]) => translate(captured.language, key)
  })
}));
vi.mock('antd', async (original) => ({
  ...(await original<typeof import('antd')>()),
  Table: (props: { columns: ColumnType<TaskItem>[] }) => {
    captured.columns = props.columns;
    return null;
  }
}));

it.each(['success', 'failed'] as const)(
  'refreshes unchanged %s tasks and action labels after switching language',
  (status) => {
    const task = {
      id: 'test',
      type: 'download',
      status,
      failure: { category: 'network', message: '' }
    } as TaskItem;
    const render = () => {
      renderToStaticMarkup(
        createElement(TaskTable, { tasks: [task], onCancel: vi.fn(), onRetry: vi.fn() })
      );
      return [1, 2, 5, 8].map((index) => {
        const column = captured.columns[index];
        expect(column.shouldCellUpdate?.(task, task) ?? true).toBe(true);
        return renderToStaticMarkup(
          createElement('div', null, column.render?.(task.type, task, 0) as ReactNode)
        );
      });
    };
    captured.language = 'zh-CN';
    const chinese = render();
    captured.language = 'en-US';
    const english = render();
    for (let index = 0; index < chinese.length; index++) {
      expect(english[index]).not.toBe(chinese[index]);
    }
  }
);
