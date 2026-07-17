import { ClockCircleOutlined } from '@ant-design/icons';
import { Alert, Card, Steps, Typography } from 'antd';

interface FeatureStagePageProps {
  title: string;
  description: string;
  dependencies: string[];
}

export function FeatureStagePage({ title, description, dependencies }: FeatureStagePageProps) {
  return (
    <div>
      <Typography.Title level={2}>{title}</Typography.Title>
      <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        icon={<ClockCircleOutlined />}
        message="该工作包正在按详细设计接入"
        description="当前页面明确显示依赖状态，不会用无效按钮或模拟数据冒充完成。"
      />
      <Card title="交付依赖" style={{ marginTop: 20 }}>
        <Steps
          direction="vertical"
          current={0}
          items={dependencies.map((item) => ({ title: item, status: 'wait' }))}
        />
      </Card>
    </div>
  );
}
