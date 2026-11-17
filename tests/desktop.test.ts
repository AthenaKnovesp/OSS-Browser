import { describe, expect, it, vi } from 'vitest';
import {
  createDesktopApi,
  type DesktopInvoke,
  type DesktopListen
} from '../src/renderer/src/desktop';
import { IPC_CHANNELS } from '../src/shared/ipc';
import type { TaskItem } from '../src/shared/types';

describe('Tauri desktop bridge', () => {
  it('keeps the IPC argument order and converts Rust errors into Error instances', async () => {
    const invoke = vi.fn().mockResolvedValue({ objects: [], isTruncated: false });
    const subscribe = vi.fn().mockResolvedValue(vi.fn());
    const { api, dispose } = await createDesktopApi(invoke as DesktopInvoke, subscribe);
    await api.listObjects('connection', 'bucket', 'prefix/', 'page-2', 50);
    expect(invoke).toHaveBeenCalledWith('dispatch', {
      channel: IPC_CHANNELS.S3_LIST_OBJECTS,
      args: ['connection', 'bucket', 'prefix/', 'page-2', 50]
    });
    invoke.mockRejectedValue({ message: '连接失败', category: 'network', retryable: true });
    await expect(api.listBuckets('connection')).rejects.toMatchObject({
      message: '连接失败',
      category: 'network',
      retryable: true
    });
    await expect(api.listBuckets('connection')).rejects.toBeInstanceOf(Error);
    dispose();
  });

  it('registers events before returning and synchronously unsubscribes each subscriber', async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    const unlisten = vi.fn();
    const subscribe: DesktopListen = async (name, callback) => {
      handlers.set(name, callback as (event: { payload: unknown }) => void);
      return unlisten;
    };
    const { api, dispose } = await createDesktopApi(vi.fn() as DesktopInvoke, subscribe);
    expect(handlers.size).toBe(3);
    const listener = vi.fn();
    const stop = api.onTaskUpdated(listener);
    const task = { id: 'task' } as TaskItem;
    handlers.get(IPC_CHANNELS.TASK_UPDATED)!({ payload: task });
    expect(listener).toHaveBeenCalledExactlyOnceWith(task);
    stop();
    handlers.get(IPC_CHANNELS.TASK_UPDATED)!({ payload: task });
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    dispose();
    expect(unlisten).toHaveBeenCalledTimes(3);
  });

  it('cleans up successful event registrations if another registration fails', async () => {
    const stop = vi.fn();
    const subscribe = vi
      .fn()
      .mockResolvedValueOnce(stop)
      .mockRejectedValueOnce('permission denied')
      .mockResolvedValueOnce(stop);
    await expect(createDesktopApi(vi.fn() as DesktopInvoke, subscribe)).rejects.toThrow(
      'permission denied'
    );
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
