import { create } from 'zustand';
import type { BucketInfo, ConnectionConfig } from '@shared/types';
import { useAppStore } from './appStore';

let bucketLoadRequestId = 0;

export type ConnectionRuntimeStatus = 'connected' | 'closed' | 'failed';

interface ConnectionState {
  buckets: BucketInfo[];
  loading: boolean;
  connectionStatuses: Record<string, ConnectionRuntimeStatus>;
  clearBuckets: () => void;
  loadBuckets: (connectionId?: string) => Promise<void>;
  saveConnection: (connection: ConnectionConfig) => Promise<void>;
  setConnectionStatus: (connectionId: string, status: ConnectionRuntimeStatus) => void;
  removeConnectionStatus: (connectionId: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
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
    set((state) => ({
      loading: true,
      connectionStatuses: activeConnectionId
        ? { ...state.connectionStatuses, [activeConnectionId]: 'closed' }
        : state.connectionStatuses
    }));
    try {
      const buckets = await window.ossApi.listBuckets();
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
    await window.ossApi.saveConnection(connection);
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
