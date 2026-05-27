import {
  FolderOpenOutlined,
  SearchOutlined,
  SettingOutlined,
  UnorderedListOutlined
} from '@ant-design/icons';
import { Menu } from 'antd';
import type { MenuProps } from 'antd';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ActivityKey } from '@renderer/stores/appStore';
import { useAppStore } from '@renderer/stores/appStore';
import { useI18n } from '@renderer/i18n';

export function ActivityBar(): React.JSX.Element {
  const { t } = useI18n();
  const {
    activeActivity,
    setActiveActivity,
    setEditingConnectionId,
    setSettingsMode,
    setSettingsOpen
  } = useAppStore(
    useShallow((state) => ({
      activeActivity: state.activeActivity,
      setActiveActivity: state.setActiveActivity,
      setEditingConnectionId: state.setEditingConnectionId,
      setSettingsMode: state.setSettingsMode,
      setSettingsOpen: state.setSettingsOpen
    }))
  );
  const items = useMemo<MenuProps['items']>(
    () => [
      { key: 'explorer', label: t('activity.explorer'), icon: <FolderOpenOutlined /> },
      { key: 'search', label: t('activity.search'), icon: <SearchOutlined /> },
      { key: 'tasks', label: t('activity.tasks'), icon: <UnorderedListOutlined /> },
      { key: 'settings', label: t('activity.settings'), icon: <SettingOutlined /> }
    ],
    [t]
  );

  return (
    <Menu
      className="activity-bar"
      mode="inline"
      selectedKeys={[activeActivity]}
      items={items}
      onClick={({ key }) => {
        if (key === 'settings') {
          setEditingConnectionId(undefined);
          setSettingsMode('preferences');
          setSettingsOpen(true);
          return;
        }
        setActiveActivity(key as ActivityKey);
      }}
    />
  );
}

