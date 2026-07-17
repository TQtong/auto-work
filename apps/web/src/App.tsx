import {
  ApartmentOutlined,
  AuditOutlined,
  BarChartOutlined,
  BranchesOutlined,
  DashboardOutlined,
  FileTextOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Layout, Menu, Skeleton, Space, Spin, Typography } from 'antd';
import { lazy, Suspense } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { apiRequest, getSession } from './api/client.js';
import type { Health, Integration, Job } from './api/types.js';
import { StatusTag } from './components/StatusTag.js';

const DashboardPage = lazy(async () => ({
  default: (await import('./pages/DashboardPage.js')).DashboardPage,
}));
const FeatureStagePage = lazy(async () => ({
  default: (await import('./pages/FeatureStagePage.js')).FeatureStagePage,
}));
const RepositoriesPage = lazy(async () => ({
  default: (await import('./pages/RepositoriesPage.js')).RepositoriesPage,
}));
const GitBatchesPage = lazy(async () => ({
  default: (await import('./pages/GitBatchesPage.js')).GitBatchesPage,
}));
const OperationsPage = lazy(async () => ({
  default: (await import('./pages/OperationsPage.js')).OperationsPage,
}));
const SettingsPage = lazy(async () => ({
  default: (await import('./pages/SettingsPage.js')).SettingsPage,
}));

const navigation = [
  { key: '/', icon: <DashboardOutlined />, label: '总览' },
  { key: '/repositories', icon: <ApartmentOutlined />, label: '项目与仓库' },
  { key: '/git-batches', icon: <BranchesOutlined />, label: 'Git 批次' },
  { key: '/tasks', icon: <UnorderedListOutlined />, label: '任务与证据' },
  { key: '/weekly-reports', icon: <FileTextOutlined />, label: '周报' },
  { key: '/quarterly-reviews', icon: <BarChartOutlined />, label: '季度绩效' },
  { key: '/operations', icon: <AuditOutlined />, label: '作业与审计' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置与集成' },
];

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: getSession,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiRequest<Health>('/api/v1/health'),
    refetchInterval: 15_000,
    enabled: session.isSuccess,
  });
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiRequest<Integration[]>('/api/v1/integrations'),
    refetchInterval: 30_000,
    enabled: session.isSuccess,
  });
  const jobs = useQuery({
    queryKey: ['jobs', 'running'],
    queryFn: () => apiRequest<Job[]>('/api/v1/operations?status=running&limit=20'),
    refetchInterval: 2_000,
    enabled: session.isSuccess,
  });
  if (session.isLoading)
    return (
      <div className="startup">
        <Spin size="large" />
        <Typography.Text>正在建立本机会话…</Typography.Text>
      </div>
    );
  if (session.isError)
    return (
      <div className="startup">
        <Typography.Title level={3}>无法连接本机服务</Typography.Title>
        <Typography.Text type="danger">{session.error.message}</Typography.Text>
      </div>
    );
  const sessionData = session.data?.data;
  if (!sessionData)
    return (
      <div className="startup">
        <Typography.Text>本机会话响应缺少用户数据</Typography.Text>
      </div>
    );
  const degradedConnections = (integrations.data?.data ?? []).filter(
    (item) => !['healthy', 'disabled'].includes(item.status),
  ).length;

  return (
    <Layout className="app-layout">
      <Layout.Sider width={246} theme="light" className="app-sider">
        <div className="brand">
          <div className="brand-mark">AW</div>
          <div>
            <Typography.Title level={4}>Auto Work</Typography.Title>
            <Typography.Text type="secondary">本机研发工作台</Typography.Text>
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={navigation}
          onClick={({ key }) => {
            void navigate(key);
          }}
        />
        <div className="local-boundary">
          <StatusTag status={health.data?.data.status ?? 'unknown'} />
          <Typography.Text type="secondary">仅限 127.0.0.1</Typography.Text>
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="app-header">
          <Space size="large">
            <Space>
              <Typography.Text type="secondary">外部连接</Typography.Text>
              <Typography.Text strong>
                {degradedConnections === 0 ? '正常' : `${degradedConnections} 项需处理`}
              </Typography.Text>
            </Space>
            <Space>
              <Typography.Text type="secondary">运行作业</Typography.Text>
              <Typography.Text strong>{jobs.data?.data.length ?? 0}</Typography.Text>
            </Space>
          </Space>
          <Space>
            <Avatar>{sessionData.displayName.slice(0, 1)}</Avatar>
            <div>
              <Typography.Text strong>{sessionData.displayName}</Typography.Text>
              <br />
              <Typography.Text type="secondary">{sessionData.windowsSidSummary}</Typography.Text>
            </div>
          </Space>
        </Layout.Header>
        <Layout.Content className="app-content">
          <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/repositories" element={<RepositoriesPage />} />
              <Route path="/git-batches" element={<GitBatchesPage />} />
              <Route
                path="/tasks"
                element={
                  <FeatureStagePage
                    title="任务与证据"
                    description="Jira 复合水位、Excel 逐行预检与 Git 证据生命周期将在第三阶段接入。"
                    dependencies={[
                      'Jira 字段映射版本',
                      'Excel 安全解析',
                      '逐字段来源合并',
                      '证据匹配与人工确认',
                    ]}
                  />
                }
              />
              <Route
                path="/weekly-reports"
                element={
                  <FeatureStagePage
                    title="六字段周报"
                    description="规则先行、AI 后置；确认版本后才能进入钉钉正式日志交付。"
                    dependencies={[
                      '任务与证据快照',
                      '六字段模板映射',
                      'AI 数据净化',
                      '钉钉能力探测与幂等意图',
                    ]}
                  />
                }
              />
              <Route
                path="/quarterly-reviews"
                element={
                  <FeatureStagePage
                    title="季度绩效"
                    description="成果池、指标公式、自评版本和 Excel/Word 导出将在证据与周报稳定后接入。"
                    dependencies={[
                      '多来源成果候选',
                      '指标模板版本',
                      '评分公式与取整',
                      '导出渲染 QA',
                    ]}
                  />
                }
              />
              <Route path="/operations" element={<OperationsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </Suspense>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
