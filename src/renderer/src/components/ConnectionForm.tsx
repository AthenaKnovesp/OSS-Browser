import { CheckCircleFilled, CloseCircleFilled, DownloadOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Tabs
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_SECURITY_SETTINGS,
  DEFAULT_TRANSFER_SETTINGS
} from '@shared/configDefaults';
import { LANGUAGE_OPTIONS } from '@shared/i18n';
import type { AppDiagnostics, AppConfig, ConnectionConfig } from '@shared/types';
import { useConnectionStore } from '@renderer/stores/connectionStore';
import type { SettingsMode } from '@renderer/stores/appStore';
import { useI18n } from '@renderer/i18n';

interface Props {
  config?: AppConfig;
  connectionId?: string | null;
  mode?: SettingsMode | 'all';
  onSaved: (config: AppConfig) => void;
}

type SettingsTabKey = 'transferSecurity' | 'appearance' | 'about';
type TestConnectionState = 'idle' | 'success' | 'failed';
const TEST_CONNECTION_MESSAGE_KEY = 'test-connection';

export function ConnectionForm({
  config,
  connectionId,
  mode = 'all',
  onSaved
}: Props): React.JSX.Element {
  const { message } = App.useApp();
  const { t } = useI18n();
  const [form] = Form.useForm<ConnectionConfig>();
  const [settingsForm] = Form.useForm<AppConfig>();
  const [activeTab, setActiveTab] = useState<SettingsTabKey>('transferSecurity');
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics>();
  const [testingConnection, setTestingConnection] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [testConnectionState, setTestConnectionState] = useState<TestConnectionState>('idle');
  const saveInFlightRef = useRef(false);
  const setConnectionStatus = useConnectionStore((state) => state.setConnectionStatus);
  const saveConnection = useConnectionStore((state) => state.saveConnection);
  const fieldColProps = { xs: 24, md: 12 };
  const active =
    connectionId === null
      ? undefined
      : (config?.connections.find((connection) => connection.id === connectionId) ??
        config?.connections.find((connection) => connection.id === config.activeConnectionId) ??
        config?.connections[0]);

  const initialConnection: ConnectionConfig = useMemo(
    () =>
      active
        ? { ...active, checksumAlgorithm: active.checksumAlgorithm ?? 'disabled' }
        : {
            id: '',
            profileName: 'Production OSS',
            endpoint: '',
            region: 'us-east-1',
            accessKeyId: '',
            secretAccessKey: '',
            forcePathStyle: true,
            ssl: true,
            defaultBucket: '',
            checksumAlgorithm: 'disabled',
            createdAt: '',
            updatedAt: ''
          },
    [active]
  );
  const canUseStoredSecret = Boolean(active?.hasSecretAccessKey);
  const secureCredentialStorageAvailable = diagnostics?.secureCredentialStorageAvailable !== false;

  useEffect(() => {
    form.setFieldsValue({
      ...initialConnection,
      secretAccessKey: ''
    });
    settingsForm.setFieldsValue(normalizeSettingsConfig(config));
  }, [config, form, initialConnection, settingsForm]);

  useEffect(() => {
    if (mode === 'connection') {
      return;
    }
    let canceled = false;
    void window.ossApi
      .getDiagnostics()
      .then((value) => {
        if (canceled) return;
        setDiagnostics(value);
        if (!value.secureCredentialStorageAvailable) {
          settingsForm.setFieldValue(['securitySettings', 'rememberCredentialsLocally'], false);
        }
      })
      .catch((error) => {
        if (error instanceof Error) message.error(error.message);
      });
    return () => {
      canceled = true;
    };
  }, [message, mode, settingsForm]);

  const handleTest = async (): Promise<void> => {
    if (testingConnection) {
      return;
    }

    setTestingConnection(true);
    setTestConnectionState('idle');
    try {
      const values = await form.validateFields();
      message.loading({
        key: TEST_CONNECTION_MESSAGE_KEY,
        content: t('settings.testingConnection'),
        duration: 0
      });
      const result = await window.ossApi.testConnection({ ...initialConnection, ...values });
      if (result.ok) {
        if (initialConnection.id) {
          setConnectionStatus(initialConnection.id, 'connected');
        }
        setTestConnectionState('success');
        message.success({
          key: TEST_CONNECTION_MESSAGE_KEY,
          content: result.message,
          duration: 3
        });
      } else {
        if (initialConnection.id) {
          setConnectionStatus(initialConnection.id, 'failed');
        }
        setTestConnectionState('failed');
        message.error({
          key: TEST_CONNECTION_MESSAGE_KEY,
          content: result.message,
          duration: 4
        });
      }
    } catch (error) {
      if (isFormValidationError(error)) {
        const firstErrorName = error.errorFields[0]?.name;
        if (firstErrorName) {
          form.scrollToField(firstErrorName, { block: 'center' });
        }
        setTestConnectionState('failed');
        message.warning(t('settings.completeConnectionFirst'));
        return;
      }

      if (initialConnection.id) {
        setConnectionStatus(initialConnection.id, 'failed');
      }
      setTestConnectionState('failed');
      if (error instanceof Error) {
        message.error({
          key: TEST_CONNECTION_MESSAGE_KEY,
          content: error.message,
          duration: 4
        });
      } else {
        message.error({
          key: TEST_CONNECTION_MESSAGE_KEY,
          content: t('settings.connectionTestFailed'),
          duration: 4
        });
      }
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSaveConnection = async (): Promise<void> => {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const values = await form.validateFields();
      const next = await saveConnection({
        ...initialConnection,
        ...values,
        checksumAlgorithm: values.checksumAlgorithm ?? 'disabled'
      });
      if (initialConnection.id) {
        setConnectionStatus(initialConnection.id, 'closed');
      }
      onSaved(next);
      message.success(t('settings.connectionSaved'));
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const handleSaveSettings = async (): Promise<void> => {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const values = settingsForm.getFieldsValue(true);
      const next = await window.ossApi.saveSettings({
        compactMode: values.compactMode,
        transferSettings: {
          ...DEFAULT_TRANSFER_SETTINGS,
          ...values.transferSettings
        },
        securitySettings: {
          ...DEFAULT_SECURITY_SETTINGS,
          ...values.securitySettings,
          rememberCredentialsLocally:
            secureCredentialStorageAvailable &&
            values.securitySettings?.rememberCredentialsLocally === true
        },
        appearanceSettings: {
          ...DEFAULT_APPEARANCE_SETTINGS,
          ...values.appearanceSettings
        }
      });
      onSaved(next);
      message.success(t('settings.savedRestart'));
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const handleExportDiagnostics = async (): Promise<void> => {
    if (exportingDiagnostics) return;
    setExportingDiagnostics(true);
    try {
      const path = await window.ossApi.exportDiagnostics();
      if (path) {
        message.success(t('settings.diagnosticsExported', { path }));
      }
    } catch {
      message.error(t('settings.diagnosticsExportFailed'));
    } finally {
      setExportingDiagnostics(false);
    }
  };

  const settingsActions = (
    <Space className="settings-actions">
      <Button type="primary" loading={saving} onClick={() => void handleSaveSettings()}>
        {t('settings.saveSettings')}
      </Button>
    </Space>
  );

  const testConnectionIcon =
    testConnectionState === 'success' ? (
      <CheckCircleFilled className="test-connection-icon success" />
    ) : testConnectionState === 'failed' ? (
      <CloseCircleFilled className="test-connection-icon failed" />
    ) : undefined;

  const connectionContent = (
    <Form
      form={form}
      layout="vertical"
      initialValues={initialConnection}
      className="settings-form settings-form-shell connection-settings-form"
      requiredMark={false}
      onValuesChange={() => setTestConnectionState('idle')}
    >
      <div className="settings-form-body">
        <Row gutter={[16, 0]}>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.profileName')}
              name="profileName"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item label={t('settings.endpoint')} name="endpoint" rules={[{ required: true }]}>
              <Input placeholder="oss-cn-shanghai.aliyuncs.com" />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item label={t('settings.region')} name="region" rules={[{ required: true }]}>
              <Input placeholder="us-east-1" />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.accessKeyId')}
              name="accessKeyId"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.secretAccessKey')}
              name="secretAccessKey"
              extra={canUseStoredSecret ? t('settings.savedSecretHint') : undefined}
              rules={[
                {
                  validator: async (_rule, value?: string) => {
                    if (value?.trim() || canUseStoredSecret) return;
                    throw new Error(t('settings.secretRequired'));
                  }
                }
              ]}
            >
              <Input.Password
                visibilityToggle
                placeholder={
                  canUseStoredSecret ? t('settings.useSavedSecret') : t('settings.secretAccessKey')
                }
              />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item label={t('settings.defaultBucket')} name="defaultBucket">
              <Input />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.forcePathStyle')}
              name="forcePathStyle"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item label={t('settings.ssl')} name="ssl" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.checksumAlgorithm')}
              name="checksumAlgorithm"
              extra={t('settings.checksumAlgorithmHelp')}
            >
              <Select
                options={[
                  { value: 'disabled', label: t('settings.checksumDisabled') },
                  { value: 'CRC32', label: 'CRC32' },
                  { value: 'SHA256', label: 'SHA256' }
                ]}
              />
            </Form.Item>
          </Col>
        </Row>
      </div>
      <Space className="settings-actions">
        <Button
          icon={testingConnection ? undefined : testConnectionIcon}
          loading={testingConnection}
          disabled={saving}
          onClick={() => void handleTest()}
        >
          {t('settings.testConnection')}
        </Button>
        <Button type="primary" loading={saving} onClick={() => void handleSaveConnection()}>
          {t('settings.saveConnection')}
        </Button>
      </Space>
    </Form>
  );

  const transferSecurityContent = (
    <Form
      form={settingsForm}
      layout="vertical"
      className="settings-form settings-form-shell"
      requiredMark={false}
    >
      <div className="settings-form-body">
        <Row gutter={[16, 0]}>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.concurrentTransfers')}
              name={['transferSettings', 'concurrentTransfers']}
              extra={t('settings.concurrentTransfersHelp')}
            >
              <InputNumber min={1} max={8} />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.multipartConcurrency')}
              name={['transferSettings', 'multipartConcurrency']}
              extra={t('settings.multipartConcurrencyHelp')}
            >
              <InputNumber min={1} max={16} />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.chunkSize')}
              name={['transferSettings', 'chunkSizeMb']}
              extra={t('settings.chunkSizeHelp')}
            >
              <InputNumber min={5} max={5120} suffix="MiB" />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.retryCount')}
              name={['transferSettings', 'retryCount']}
              extra={t('settings.retryCountHelp')}
            >
              <InputNumber min={0} max={10} />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.defaultDownloadFolder')}
              htmlFor="settings-download-folder"
              extra={t('settings.defaultDownloadFolderHelp')}
            >
              <Space.Compact block>
                <Form.Item name={['transferSettings', 'defaultDownloadFolder']} noStyle>
                  <Input id="settings-download-folder" />
                </Form.Item>
                <Button
                  onClick={async () => {
                    const folder = await window.ossApi.selectFolder();
                    if (folder) {
                      settingsForm.setFieldValue(
                        ['transferSettings', 'defaultDownloadFolder'],
                        folder
                      );
                    }
                  }}
                >
                  {t('settings.browse')}
                </Button>
              </Space.Compact>
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.localCollisionPolicy')}
              name={['transferSettings', 'overwritePolicy']}
              extra={t('settings.localCollisionPolicyHelp')}
            >
              <Select
                options={[
                  { value: 'ask', label: t('settings.safeAutoRename') },
                  { value: 'overwrite', label: t('settings.overwriteSameName') },
                  { value: 'skip', label: t('settings.skipSameName') }
                ]}
              />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.rememberCredentials')}
              name={['securitySettings', 'rememberCredentialsLocally']}
              valuePropName="checked"
              extra={
                secureCredentialStorageAvailable
                  ? t('settings.rememberCredentialsHelp')
                  : t('settings.secureCredentialStorageUnavailable')
              }
            >
              <Switch disabled={!secureCredentialStorageAvailable} />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.confirmBeforeDelete')}
              name={['securitySettings', 'requireConfirmationBeforeDelete']}
              valuePropName="checked"
              extra={t('settings.confirmBeforeDeleteHelp')}
            >
              <Switch />
            </Form.Item>
          </Col>
        </Row>
        {diagnostics && !secureCredentialStorageAvailable ? (
          <Alert type="warning" showIcon title={t('settings.secureCredentialStorageUnavailable')} />
        ) : null}
      </div>
      {settingsActions}
    </Form>
  );

  const appearanceContent = (
    <Form
      form={settingsForm}
      layout="vertical"
      className="settings-form settings-form-shell"
      requiredMark={false}
    >
      <div className="settings-form-body">
        <Row gutter={[16, 0]}>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.language')}
              name={['appearanceSettings', 'language']}
              extra={t('settings.languageHelp')}
            >
              <Select
                options={LANGUAGE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey)
                }))}
              />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.compactMode')}
              name="compactMode"
              valuePropName="checked"
              extra={t('settings.compactModeHelp')}
            >
              <Switch />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.disableHardwareAcceleration')}
              name={['appearanceSettings', 'disableHardwareAcceleration']}
              valuePropName="checked"
              extra={t('settings.disableHardwareAccelerationHelp')}
            >
              <Switch />
            </Form.Item>
          </Col>
          <Col {...fieldColProps}>
            <Form.Item
              label={t('settings.disableGpuShaderDiskCache')}
              name={['appearanceSettings', 'disableGpuShaderDiskCache']}
              valuePropName="checked"
              extra={t('settings.disableGpuShaderDiskCacheHelp')}
            >
              <Switch />
            </Form.Item>
          </Col>
        </Row>
      </div>
      {settingsActions}
    </Form>
  );

  const aboutContent = (
    <Space className="settings-form about-settings" orientation="vertical" size={12}>
      <Descriptions
        size="small"
        bordered
        column={1}
        items={[
          {
            key: 'name',
            label: t('settings.appName'),
            children: diagnostics?.appName ?? 'OSS Browser'
          },
          {
            key: 'version',
            label: t('settings.appVersion'),
            children: diagnostics?.appVersion ?? '-'
          },
          { key: 'tauri', label: 'Tauri', children: diagnostics?.tauriVersion ?? '-' },
          { key: 'webview', label: 'WebView2', children: diagnostics?.webviewVersion ?? '-' },
          {
            key: 'system',
            label: t('settings.system'),
            children: diagnostics ? `${diagnostics.platform} ${diagnostics.arch}` : '-'
          },
          {
            key: 'config',
            label: t('settings.configFile'),
            children: diagnostics?.configFilePath ?? '-'
          }
        ]}
      />
      <Button
        icon={<DownloadOutlined />}
        loading={exportingDiagnostics}
        onClick={() => void handleExportDiagnostics()}
      >
        {t('settings.exportDiagnostics')}
      </Button>
    </Space>
  );

  if (mode === 'connection') {
    return (
      <>
        <Form form={settingsForm} component={false} />
        {connectionContent}
      </>
    );
  }

  return (
    <>
      <Form form={form} component={false} />
      <Tabs
        className="settings-tabs"
        activeKey={activeTab}
        destroyOnHidden
        items={[
          {
            key: 'transferSecurity',
            label: t('settings.transferSecurity'),
            children: transferSecurityContent
          },
          { key: 'appearance', label: t('settings.appearance'), children: appearanceContent },
          { key: 'about', label: t('settings.about'), children: aboutContent }
        ]}
        onChange={(key) => setActiveTab(key as SettingsTabKey)}
      />
    </>
  );
}

function normalizeSettingsConfig(config?: AppConfig): Partial<AppConfig> {
  return {
    ...config,
    compactMode: config?.compactMode ?? false,
    transferSettings: {
      ...DEFAULT_TRANSFER_SETTINGS,
      ...config?.transferSettings
    },
    securitySettings: {
      ...DEFAULT_SECURITY_SETTINGS,
      ...config?.securitySettings
    },
    appearanceSettings: {
      ...DEFAULT_APPEARANCE_SETTINGS,
      ...config?.appearanceSettings
    }
  };
}

function isFormValidationError(
  error: unknown
): error is { errorFields: Array<{ name: Array<string | number> }> } {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    Array.isArray((error as { errorFields?: unknown }).errorFields)
  );
}
