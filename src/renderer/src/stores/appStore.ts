import { create } from 'zustand';
import type { AppConfig } from '@shared/types';

export type SettingsMode = 'connection' | 'preferences';

interface AppState {
  config?: AppConfig;
  settingsOpen: boolean;
  settingsMode: SettingsMode;
  editingConnectionId?: string | null;
  searchTerm: string;
  setConfig: (config: AppConfig) => void;
  setEditingConnectionId: (connectionId?: string | null) => void;
  setSettingsMode: (mode: SettingsMode) => void;
  setSettingsOpen: (open: boolean) => void;
  setSearchTerm: (value: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  settingsOpen: false,
  settingsMode: 'connection',
  editingConnectionId: undefined,
  searchTerm: '',
  setConfig: (config) => set({ config }),
  setEditingConnectionId: (editingConnectionId) => set({ editingConnectionId }),
  setSettingsMode: (settingsMode) => set({ settingsMode }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSearchTerm: (searchTerm) => set({ searchTerm })
}));
