import { create } from 'zustand';
import type { AppConfig } from '@shared/types';

export type ActivityKey = 'explorer' | 'search' | 'tasks';
export type SettingsMode = 'connection' | 'preferences';

interface AppState {
  config?: AppConfig;
  activeActivity: ActivityKey;
  detailVisible: boolean;
  settingsOpen: boolean;
  settingsMode: SettingsMode;
  editingConnectionId?: string | null;
  searchTerm: string;
  setConfig: (config: AppConfig) => void;
  setActiveActivity: (activity: ActivityKey) => void;
  setDetailVisible: (visible: boolean) => void;
  setEditingConnectionId: (connectionId?: string | null) => void;
  setSettingsMode: (mode: SettingsMode) => void;
  setSettingsOpen: (open: boolean) => void;
  setSearchTerm: (value: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeActivity: 'explorer',
  detailVisible: false,
  settingsOpen: false,
  settingsMode: 'connection',
  editingConnectionId: undefined,
  searchTerm: '',
  setConfig: (config) => set({ config }),
  setActiveActivity: (activeActivity) => set({ activeActivity }),
  setDetailVisible: (detailVisible) => set({ detailVisible }),
  setEditingConnectionId: (editingConnectionId) => set({ editingConnectionId }),
  setSettingsMode: (settingsMode) => set({ settingsMode }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSearchTerm: (searchTerm) => set({ searchTerm })
}));
