import { create } from 'zustand';
import type { AppConfig, BucketInfo, ConnectionConfig } from '@shared/types';
import { useAppStore } from './appStore';
import { useObjectStore } from './objectStore';

let bucketLoadRequestId = 0;

export type ConnectionRuntimeStatus = 'connected' | 'closed' | 'failed';

interface ConnectionState {
  buckets: BucketInfo[];
  loading: boolean;
  connectionStatuses: Record<string, ConnectionRuntimeStatus>;
  clearBuckets: () => void;
  loadBuckets: (connectionId?: string) => Promise<void>;
  saveConnection: (connection: ConnectionConfig) => Promise<AppConfig>;
  setConnectionStatus: (connectionId: string, status: ConnectionRuntimeStatus) => void;
  removeConnectionStatus: (connectionId: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  buckets: [],
  loading: false,
  connectionStatuses: {},
  clearBuckets: () => {
    bucketLoadRequestId += 1;
    set({ buckets: [], loading: false });
  },
  loadBuckets: async (connectionId) => {
    const activeConnectionId =
      connectionId ?? useAppStore.getState().config?.activeConnectionId ?? undefined;
    const requestId = ++bucketLoadRequestId;
    if (!activeConnectionId) {
      set({ buckets: [], loading: false });
      return;
    }
    set((state) => ({
      loading: true,
      connectionStatuses: activeConnectionId
        ? { ...state.connectionStatuses, [activeConnectionId]: 'closed' }
        : state.connectionStatuses
    }));
    try {
      const buckets = await window.ossApi.listBuckets(activeConnectionId);
      if (requestId === bucketLoadRequestId) {
        set((state) => ({
          buckets,
          connectionStatuses: activeConnectionId
            ? { ...state.connectionStatuses, [activeConnectionId]: 'connected' }
            : state.connectionStatuses
        }));
      }
    } catch (error) {
      if (requestId === bucketLoadRequestId) {
        set((state) => ({
          buckets: [],
          connectionStatuses: activeConnectionId
            ? { ...state.connectionStatuses, [activeConnectionId]: 'failed' }
            : state.connectionStatuses
        }));
      }
      throw error;
    } finally {
      if (requestId === bucketLoadRequestId) {
        set({ loading: false });
      }
    }
  },
  saveConnection: async (connection) => {
    const config = await window.ossApi.saveConnection(connection);
    if (connection.id && connection.id === useAppStore.getState().config?.activeConnectionId) {
      get().clearBuckets();
      useObjectStore.getState().clearObjects();
    }
    return config;
  },
  setConnectionStatus: (connectionId, status) => {
    set((state) => ({
      connectionStatuses: {
        ...state.connectionStatuses,
        [connectionId]: status
      }
    }));
  },
  removeConnectionStatus: (connectionId) => {
    set((state) => {
      const connectionStatuses = { ...state.connectionStatuses };
      delete connectionStatuses[connectionId];
      return { connectionStatuses };
    });
  }
}));

export function isCurrentConnection(
  connection?: Pick<ConnectionConfig, 'id' | 'updatedAt'>
): boolean {
  const config = useAppStore.getState().config;
  return Boolean(
    connection &&
    config?.activeConnectionId === connection.id &&
    config.connections.find((current) => current.id === connection.id)?.updatedAt ===
      connection.updatedAt
  );
}
