import {
  CloudDownloadOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Progress,
  Space,
  Statistic,
  Table,
  Tabs,
  Typography,
  message,
} from 'antd';
import { useState } from 'react';
import { apiDownload, apiRequest } from '../api/client.js';
import type {
  AuditEvent,
  Backup,
  DiagnosticBundle,
  DiagnosticBundlePreview,
  DiagnosticFacts,
  Job,
} from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';

export function OperationsPage() {
  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={2}>作业、审计与备份</Typography.Title>
        <Typography.Text type="secondary">
          后台任务在页面关闭后继续运行；外部写结果未知时不会被自动重放。
        </Typography.Text>
      </div>
      <Tabs
        items={[
          { key: 'jobs', label: '持久化作业', children: <JobsPanel /> },
          { key: 'audit', label: '审计事件', children: <AuditPanel /> },
          { key: 'backup', label: '一致备份', children: <BackupPanel /> },
          { key: 'diagnostics', label: '诊断与容量', children: <DiagnosticsPanel /> },
        ]}
      />
    </Space>
  );
}

function DiagnosticsPanel() {
  const queryClient = useQueryClient();
  const [acknowledged, setAcknowledged] = useState(false);
  const [messageApi, holder] = message.useMessage();
  const facts = useQuery({
    queryKey: ['maintenance-diagnostics'],
    queryFn: () => apiRequest<DiagnosticFacts>('/api/v1/maintenance/diagnostics'),
    refetchInterval: 30_000,
  });
  const preview = useQuery({
    queryKey: ['diagnostic-bundle-preview'],
    queryFn: () =>
      apiRequest<DiagnosticBundlePreview>('/api/v1/maintenance/diagnostic-bundles/preview'),
  });
  const bundles = useQuery({
    queryKey: ['diagnostic-bundles'],
    queryFn: () => apiRequest<DiagnosticBundle[]>('/api/v1/maintenance/diagnostic-bundles'),
  });
  const createBundle = useMutation({
    mutationFn: () =>
      apiRequest<DiagnosticBundle>('/api/v1/maintenance/diagnostic-bundles', {
        method: 'POST',
        body: JSON.stringify({ acknowledgedExclusions: true, includeRecentErrors: true }),
      }),
    onSuccess: async () => {
      setAcknowledged(false);
      await queryClient.invalidateQueries({ queryKey: ['diagnostic-bundles'] });
      void messageApi.success('脱敏诊断包已生成并完成内容自检');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });
  const downloadBundle = useMutation({
    mutationFn: async (bundle: DiagnosticBundle) => {
      const file = await apiDownload(
        `/api/v1/maintenance/diagnostic-bundles/${bundle.bundleId}/download`,
      );
      // 下载只在用户点击后创建短生命周期 Blob URL，不把诊断内容写入浏览器持久存储。
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });
  const data = facts.data?.data;
  const availablePercent = data
    ? Math.round((data.storage.availableBytes / Math.max(data.storage.totalBytes, 1)) * 1000) / 10
    : 0;
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {holder}
      <Card
        title="运行健康与容量事实"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void facts.refetch()}>
            重新诊断
          </Button>
        }
        loading={facts.isLoading}
      >
        {data ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <div className="operations-stat-grid">
              <Statistic title="数据库 quick_check" value={data.database.readiness.quickCheck} />
              <Statistic title="磁盘可用" value={availablePercent} suffix="%" />
              <Statistic title="不可变审计" value={data.audit.immutableEventCount} suffix="条" />
              <Statistic
                title="最近校验备份"
                value={data.backups.verificationAgeHours ?? '—'}
                suffix={data.backups.verificationAgeHours === null ? undefined : '小时'}
              />
            </div>
            {!data.storage.growthAllowed ? (
              <Alert
                type="error"
                showIcon
                message="磁盘空间低于安全阈值，增长型操作已停止"
                description={`至少需要保留 ${formatBytes(data.storage.minimumAvailableBytes)}；导入、备份、季度导出和诊断包会返回明确错误，已有数据仍可只读。`}
              />
            ) : null}
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="应用 / Node">
                {data.runtime.applicationVersion} · {data.runtime.nodeVersion}
              </Descriptions.Item>
              <Descriptions.Item label="监听边界">
                {data.runtime.binding.host}:{data.runtime.binding.port} · 仅回环
              </Descriptions.Item>
              <Descriptions.Item label="SQLite">
                {data.database.journalMode} · {data.database.pageCount} 页 · 空闲{' '}
                {data.database.freePageCount} 页
              </Descriptions.Item>
              <Descriptions.Item label="数据库占用">
                {formatBytes(data.storage.databaseBytes)}
              </Descriptions.Item>
              <Descriptions.Item label="作业状态" span={2}>
                {Object.entries(data.jobs)
                  .map(([status, count]) => `${status} ${count}`)
                  .join(' · ') || '暂无作业'}
              </Descriptions.Item>
              <Descriptions.Item label="受控目录分类" span={2}>
                {Object.entries(data.storage.categories)
                  .map(([name, bytes]) => `${name} ${formatBytes(bytes)}`)
                  .join(' · ')}
              </Descriptions.Item>
            </Descriptions>
            {data.recentErrors.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`最近有 ${data.recentErrors.length} 条结构化错误事实`}
                description="诊断只展示组件、事件和错误码；原始请求、正文、路径和堆栈不会进入页面或诊断包。"
              />
            ) : (
              <Alert type="success" showIcon message="未发现结构化 error/fatal 事件" />
            )}
          </Space>
        ) : null}
      </Card>
      <Card
        title={
          <Space>
            <FileSearchOutlined />
            脱敏诊断包
          </Space>
        }
        extra={
          <Button
            type="primary"
            disabled={!acknowledged}
            loading={createBundle.isPending}
            onClick={() => createBundle.mutate()}
          >
            生成诊断包
          </Button>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="生成前先核对内容和排除项"
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text>
                  包含：{preview.data?.data.includedSections.join('、') ?? '正在读取预览…'}
                </Typography.Text>
                <Typography.Text type="secondary">
                  排除：{preview.data?.data.exclusions.join('；') ?? '正在读取排除项…'}
                </Typography.Text>
              </Space>
            }
          />
          <Checkbox
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          >
            我已核对诊断包内容和排除项，确认只生成本机脱敏文件
          </Checkbox>
          <Table
            rowKey="bundleId"
            size="small"
            loading={bundles.isLoading}
            dataSource={bundles.data?.data ?? []}
            columns={[
              { title: '文件', dataIndex: 'fileName' },
              {
                title: '大小',
                dataIndex: 'sizeBytes',
                render: (value: number) => formatBytes(value),
              },
              {
                title: 'SHA-256',
                dataIndex: 'sha256',
                render: (value: string) => (
                  <Typography.Text code>{value.slice(0, 16)}…</Typography.Text>
                ),
              },
              {
                title: '生成时间',
                dataIndex: 'createdAt',
                render: (value: string) => new Date(value).toLocaleString(),
              },
              {
                title: '操作',
                render: (_: unknown, row: DiagnosticBundle) => (
                  <Button
                    size="small"
                    icon={<CloudDownloadOutlined />}
                    loading={downloadBundle.isPending}
                    onClick={() => downloadBundle.mutate(row)}
                  >
                    下载
                  </Button>
                ),
              },
            ]}
          />
        </Space>
      </Card>
    </Space>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

function JobsPanel() {
  const query = useQuery({
    queryKey: ['jobs'],
    queryFn: () => apiRequest<Job[]>('/api/v1/operations?limit=100'),
    refetchInterval: 2_000,
  });
  return (
    <Card
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void query.refetch()}>
          刷新
        </Button>
      }
    >
      <Table
        rowKey="id"
        loading={query.isLoading}
        dataSource={query.data?.data ?? []}
        expandable={{
          expandedRowRender: (row) => (
            <pre className="safe-json">
              {JSON.stringify(
                { payload: row.payloadSummary, errorCode: row.lastErrorCode, error: row.lastError },
                null,
                2,
              )}
            </pre>
          ),
        }}
        columns={[
          { title: '作业', dataIndex: 'type' },
          {
            title: '状态',
            dataIndex: 'status',
            render: (value: string) => <StatusTag status={value} />,
          },
          {
            title: '进度',
            dataIndex: 'progress',
            width: 180,
            render: (value: number) => (
              <Progress
                percent={value}
                size="small"
                status={value === 100 ? 'success' : 'active'}
              />
            ),
          },
          {
            title: '尝试',
            render: (_: unknown, row: Job) => `${row.attemptCount}/${row.maxAttempts}`,
          },
          {
            title: '创建时间',
            dataIndex: 'createdAt',
            render: (value: string) => new Date(value).toLocaleString(),
          },
          {
            title: '完成时间',
            dataIndex: 'completedAt',
            render: (value: string | null) => (value ? new Date(value).toLocaleString() : '—'),
          },
        ]}
      />
    </Card>
  );
}

function AuditPanel() {
  const query = useQuery({
    queryKey: ['audit'],
    queryFn: () => apiRequest<AuditEvent[]>('/api/v1/audit-events?limit=100'),
    refetchInterval: 10_000,
  });
  return (
    <Card extra={<Typography.Text type="secondary">审计只保存非敏感摘要哈希</Typography.Text>}>
      <Table
        rowKey="eventId"
        loading={query.isLoading}
        dataSource={query.data?.data ?? []}
        columns={[
          {
            title: '时间',
            dataIndex: 'occurredAt',
            render: (value: string) => new Date(value).toLocaleString(),
          },
          { title: '动作', dataIndex: 'action' },
          {
            title: '对象',
            render: (_: unknown, row: AuditEvent) =>
              `${row.targetType} · ${row.targetId.slice(0, 12)}`,
          },
          {
            title: '结果',
            dataIndex: 'outcome',
            render: (value: string) => <StatusTag status={value} />,
          },
          {
            title: '错误码',
            dataIndex: 'errorCode',
            render: (value: string | null) => value ?? '—',
          },
        ]}
      />
    </Card>
  );
}

function BackupPanel() {
  const queryClient = useQueryClient();
  const [messageApi, holder] = message.useMessage();
  const query = useQuery({
    queryKey: ['backups'],
    queryFn: () => apiRequest<Backup[]>('/api/v1/backups'),
    refetchInterval: 5_000,
  });
  const action = useMutation({
    mutationFn: ({ kind, id }: { kind: 'create' | 'verify'; id?: string }) =>
      apiRequest(
        kind === 'create' ? '/api/v1/maintenance/backup' : `/api/v1/backups/${id}/verify`,
        { method: 'POST' },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['backups'] });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void messageApi.success('备份作业已进入持久化队列');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });
  return (
    <Card
      title={
        <Space>
          <SafetyCertificateOutlined />
          SQLite 在线一致备份
        </Space>
      }
      extra={
        <Button
          type="primary"
          icon={<CloudDownloadOutlined />}
          loading={action.isPending}
          onClick={() => action.mutate({ kind: 'create' })}
        >
          立即备份
        </Button>
      }
    >
      {holder}
      <Typography.Paragraph type="secondary">
        使用 SQLite VACUUM INTO 生成一致快照；校验同时核对 SHA-256 和隔离数据库
        quick_check，不复制活动 WAL 文件组合。
      </Typography.Paragraph>
      <Table
        rowKey="id"
        loading={query.isLoading}
        dataSource={query.data?.data ?? []}
        columns={[
          {
            title: '文件',
            dataIndex: 'fileName',
            render: (value: string | null) => value ?? '生成中',
          },
          {
            title: '状态',
            dataIndex: 'status',
            render: (value: string) => <StatusTag status={value} />,
          },
          {
            title: '大小',
            dataIndex: 'sizeBytes',
            render: (value: string | null) =>
              value ? `${(Number(value) / 1024 / 1024).toFixed(2)} MB` : '—',
          },
          {
            title: 'SHA-256',
            dataIndex: 'sha256',
            render: (value: string | null) =>
              value ? <Typography.Text code>{value.slice(0, 16)}…</Typography.Text> : '—',
          },
          {
            title: '生成时间',
            dataIndex: 'createdAt',
            render: (value: string) => new Date(value).toLocaleString(),
          },
          {
            title: '校验',
            render: (_: unknown, row: Backup) => (
              <Button
                size="small"
                disabled={!row.sha256}
                loading={action.isPending}
                onClick={() => action.mutate({ kind: 'verify', id: row.id })}
              >
                隔离校验
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}
