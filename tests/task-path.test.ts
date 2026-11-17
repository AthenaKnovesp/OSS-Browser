import { describe, expect, it } from 'vitest';
import type { TaskItem, TaskType } from '../src/shared/types';
import { formatTaskPath } from '../src/renderer/src/utils/formatTaskPath';

describe('task path display', () => {
  it.each([
    [
      String.raw`\\?\C:\Users\Administrator\Downloads\file.txt`,
      String.raw`C:\Users\Administrator\Downloads\file.txt`
    ],
    [String.raw`\\?\d:\下载\文件.txt`, String.raw`d:\下载\文件.txt`],
    [String.raw`\\?\UNC\server\share\文件.txt`, String.raw`\\server\share\文件.txt`],
    [String.raw`C:\Downloads\file.txt`, String.raw`C:\Downloads\file.txt`],
    [String.raw`\\server\share\file.txt`, String.raw`\\server\share\file.txt`],
    [String.raw`\\?\Volume{volume-id}\file.txt`, String.raw`\\?\Volume{volume-id}\file.txt`],
    [String.raw`\\.\C:\file.txt`, String.raw`\\.\C:\file.txt`],
    ['', '']
  ])('formats local paths without changing the task: %s', (path, expected) => {
    const download = Object.freeze({
      type: 'download',
      source: 'bucket/key',
      target: path
    } as const);
    const upload = Object.freeze({ type: 'upload', source: path, target: 'bucket/key' } as const);
    expect(formatTaskPath(download, 'target')).toBe(expected);
    expect(formatTaskPath(upload, 'source')).toBe(expected);
    expect(download.target).toBe(path);
    expect(upload.source).toBe(path);
  });

  it('preserves long paths, spaces and Unicode after removing the display prefix', () => {
    const path = `C:\\Downloads\\${'目录\\'.repeat(100)} 文件 .txt`;
    expect(
      formatTaskPath({ type: 'download', source: '', target: `\\\\?\\${path}` }, 'target')
    ).toBe(path);
  });

  it.each<TaskType>(['upload', 'download', 'copy', 'move', 'rename', 'delete'])(
    'leaves remote paths unchanged for %s tasks',
    (type) => {
      const path = String.raw`\\?\C:\object-key`;
      const task: Pick<TaskItem, 'type' | 'source' | 'target'> = {
        type,
        source: path,
        target: path
      };
      if (type !== 'upload') expect(formatTaskPath(task, 'source')).toBe(path);
      if (type !== 'download') expect(formatTaskPath(task, 'target')).toBe(path);
    }
  );
});
