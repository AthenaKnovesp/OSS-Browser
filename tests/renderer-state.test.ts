import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../src/renderer/src/stores/appStore';
import {
  isCurrentConnection,
  useConnectionStore
} from '../src/renderer/src/stores/connectionStore';
import { useObjectStore } from '../src/renderer/src/stores/objectStore';
import { useLogStore } from '../src/renderer/src/stores/logStore';
import type { AppConfig, ConnectionConfig, LogEntry, ObjectItem } from '../src/shared/types';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_SECURITY_SETTINGS,
  DEFAULT_TRANSFER_SETTINGS
} from '../src/shared/configDefaults';

const connection: ConnectionConfig = {
  id: 'connection',
  profileName: 'test',
  endpoint: 'http://old-storage',
  region: 'us-east-1',
  accessKeyId: 'test',
  forcePathStyle: true,
  ssl: false,
  createdAt: 'before',
  updatedAt: 'before'
};
const config: AppConfig = {
  connections: [connection],
  activeConnectionId: connection.id,
  compactMode: false,
  transferSettings: DEFAULT_TRANSFER_SETTINGS,
  securitySettings: DEFAULT_SECURITY_SETTINGS,
  appearanceSettings: DEFAULT_APPEARANCE_SETTINGS
};
const object = (key: string): ObjectItem => ({
  key,
  name: key,
  bucket: 'bucket',
  prefix: '',
  type: 'text/plain',
  isFolder: false
});
const log = (id: string): LogEntry => ({
  id,
  timestamp: '2026-11-16T00:00:00Z',
  level: 'info',
  message: id
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('renderer state regressions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.getState().setConfig(config);
    useObjectStore.getState().clearObjects();
    useConnectionStore.getState().clearBuckets();
    useLogStore.setState({ logs: [] });
    vi.stubGlobal('window', { ossApi: {} });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('merges logs received during a delayed snapshot without losing or duplicating events', async () => {
    const snapshot = deferred<LogEntry[]>();
    window.ossApi.listLogs = vi.fn(() => snapshot.promise);
    const loading = useLogStore.getState().loadLogs();
    useLogStore.getState().addLog(log('new'));
    await vi.advanceTimersByTimeAsync(150);
    snapshot.resolve([log('old')]);
    await loading;
    await vi.advanceTimersByTimeAsync(150);
    expect(useLogStore.getState().logs.map((item) => item.id)).toEqual(['old', 'new']);
  });

  it('deduplicates events already included in a log snapshot', async () => {
    const snapshot = deferred<LogEntry[]>();
    window.ossApi.listLogs = vi.fn(() => snapshot.promise);
    const loading = useLogStore.getState().loadLogs();
    useLogStore.getState().addLog(log('new'));
    snapshot.resolve([log('old'), log('new')]);
    await loading;
    await vi.advanceTimersByTimeAsync(150);
    expect(useLogStore.getState().logs.map((item) => item.id)).toEqual(['old', 'new']);
  });

  it('does not restore a stale log snapshot after clearing logs', async () => {
    const snapshot = deferred<LogEntry[]>();
    window.ossApi.listLogs = vi.fn(() => snapshot.promise);
    window.ossApi.clearLogs = vi.fn(async () => undefined);
    const loading = useLogStore.getState().loadLogs();
    await useLogStore.getState().clearLogs();
    useLogStore.getState().addLog(log('after-clear'));
    snapshot.resolve([log('old')]);
    await loading;
    await vi.advanceTimersByTimeAsync(150);
    expect(useLogStore.getState().logs.map((item) => item.id)).toEqual(['after-clear']);
  });

  it('sorts the first page with the same comparator used when merging later pages', async () => {
    window.ossApi.listObjects = vi
      .fn()
      .mockResolvedValueOnce({
        objects: ['B', 'a', '中'].map(object),
        isTruncated: true,
        nextContinuationToken: 'next'
      })
      .mockResolvedValueOnce({ objects: ['C', '文'].map(object), isTruncated: false });
    await useObjectStore.getState().loadObjects('bucket', '', connection.id);
    const loadingMore = useObjectStore.getState().loadMoreObjects();
    await vi.advanceTimersByTimeAsync(0);
    await loadingMore;
    expect(useObjectStore.getState().objects.map((item) => item.key)).toEqual(
      ['B', 'a', '中', 'C', '文'].sort((a, b) => a.localeCompare(b))
    );
  });

  it('invalidates old objects, selections and in-flight reads when saving the active connection', async () => {
    const objects = deferred<{ objects: ObjectItem[]; isTruncated: boolean }>();
    const buckets = deferred<Array<{ name: string }>>();
    window.ossApi.listObjects = vi.fn(() => objects.promise);
    window.ossApi.listBuckets = vi.fn(() => buckets.promise);
    window.ossApi.saveConnection = vi.fn(async () => ({
      ...config,
      connections: [{ ...connection, endpoint: 'http://new-storage', updatedAt: 'after' }]
    }));
    const objectRead = useObjectStore.getState().loadObjects('bucket', '', connection.id);
    const bucketRead = useConnectionStore.getState().loadBuckets(connection.id);
    useObjectStore.setState({
      objects: [object('old')],
      selectedObjects: [object('old')],
      selectedObject: object('old')
    });
    await useConnectionStore.getState().saveConnection(connection);
    objects.resolve({ objects: [object('stale')], isTruncated: false });
    buckets.resolve([{ name: 'stale-bucket' }]);
    await Promise.all([objectRead, bucketRead]);
    expect(useObjectStore.getState()).toMatchObject({
      objects: [],
      selectedObjects: [],
      selectedObject: undefined,
      currentBucket: undefined,
      loading: false
    });
    expect(useConnectionStore.getState()).toMatchObject({ buckets: [], loading: false });
  });

  it('rejects captured operation contexts after saving or switching connections', () => {
    expect(isCurrentConnection(connection)).toBe(true);
    useAppStore
      .getState()
      .setConfig({ ...config, connections: [{ ...connection, updatedAt: 'after' }] });
    expect(isCurrentConnection(connection)).toBe(false);
    useAppStore.getState().setConfig({ ...config, activeConnectionId: 'different' });
    expect(isCurrentConnection(connection)).toBe(false);
  });
});
