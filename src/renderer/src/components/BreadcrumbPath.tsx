import { HomeOutlined } from '@ant-design/icons';
import { Breadcrumb, Button } from 'antd';
import { breadcrumbParts } from '@renderer/utils/objectKey';
import { useI18n } from '@renderer/i18n';

interface Props {
  prefix: string;
  onNavigate: (prefix: string) => void;
}

export function BreadcrumbPath({ prefix, onNavigate }: Props): React.JSX.Element {
  const { t } = useI18n();
  const parts = breadcrumbParts(prefix);

  return (
    <div className="breadcrumb-row">
      <div className="breadcrumb-scroll">
        <Breadcrumb
          className="path-breadcrumb"
          items={[
            {
              title: (
                <Button
                  className="breadcrumb-button breadcrumb-home"
                  size="small"
                  type="text"
                  icon={<HomeOutlined />}
                  title={t('breadcrumb.home')}
                  aria-label={t('breadcrumb.home')}
                  onClick={() => onNavigate('')}
                />
              )
            },
            ...parts.map((part) => ({
              title: (
                <Button
                  className="breadcrumb-button breadcrumb-text"
                  size="small"
                  type="text"
                  aria-label={t('breadcrumb.navigateTo', { name: part.label })}
                  onClick={() => onNavigate(part.prefix)}
                >
                  <span className="breadcrumb-tooltip-text" title={part.label}>
                    {part.label}
                  </span>
                </Button>
              )
            }))
          ]}
        />
      </div>
    </div>
  );
}
