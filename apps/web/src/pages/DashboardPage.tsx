import {
  CloudServerOutlined,
  DatabaseOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Col, Empty, Progress, Row, Space, Statistic, Table, Typography } from 'antd';
import { apiRequest } from '../api/client.js';
import type { Health, Integration, Job } from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';

export function DashboardPage() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiRequest<Health>('/api/v1/health'),
    refetchInterval: 15_000,
  });
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiRequest<Integration[]>('/api/v1/integrations'),
    refetchInterval: 30_000,
  });
  const runningJobs = useQuery({
    queryKey: ['jobs', 'running'],
    queryFn: () => apiRequest<Job[]>('/api/v1/operations?status=running&limit=20'),
    refetchInterval: 2_000,
  });
  const connections = integrations.data?.data ?? [];
  const jobs = runningJobs.data?.data ?? [];

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={2}>工作台总览</Typography.Title>
        <Typography.Text type="secondary">
          先展示持久化缓存和采集时间，外部刷新不会阻塞首屏。
        </Typography.Text>
      </div>
      {health.data?.data.status === 'degraded' && (
        <Alert
          type="warning"
          showIcon
          message="本机服务处于降级状态"
          description="查看下方组件状态；外部连接异常不会阻断本地缓存和只读能力。"
        />
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} xl={6}>
          <Card>
            <Statistic
              title="本机服务"
              value={health.data?.data.status === 'ready' ? '就绪' : '降级'}
              prefix={<SafetyCertificateOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card>
            <Statistic
              title="已配置连接"
              value={connections.length}
              prefix={<CloudServerOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card>
            <Statistic
              title="运行中作业"
              value={jobs.length}
              prefix={<SyncOutlined spin={jobs.length > 0} />}
            />
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card>
            <Statistic
              title="数据库完整性"
              value={health.data?.data.readiness.database.quickCheck ?? '检查中'}
              prefix={<DatabaseOutlined />}
            />
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card
            title="集成新鲜度"
            extra={
              <Typography.Text type="secondary">
                as of{' '}
                {integrations.data?.meta.asOf
                  ? new Date(integrations.data.meta.asOf).toLocaleString()
                  : '—'}
              </Typography.Text>
            }
          >
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={connections}
              locale={{ emptyText: <Empty description="尚未配置集成" /> }}
              columns={[
                { title: '连接', dataIndex: 'name' },
                { title: '类型', dataIndex: 'type' },
                {
                  title: '状态',
                  dataIndex: 'status',
                  render: (value: string) => <StatusTag status={value} />,
                },
                {
                  title: '上次成功',
                  dataIndex: 'lastSuccessAt',
                  render: (value: string | null) =>
                    value ? new Date(value).toLocaleString() : '从未',
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title="正在运行的作业">
            {jobs.length === 0 ? (
              <Empty description="当前没有运行中的作业" />
            ) : (
              jobs.map((job) => (
                <div className="job-progress" key={job.id}>
                  <Space>
                    <Typography.Text strong>{job.type}</Typography.Text>
                    <StatusTag status={job.status} />
                  </Space>
                  <Progress percent={job.progress} size="small" />
                </div>
              ))
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
