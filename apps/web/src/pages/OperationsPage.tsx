import {
  CloudDownloadOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Progress, Space, Table, Tabs, Typography, message } from 'antd';
import { apiRequest } from '../api/client.js';
import type { AuditEvent, Backup, Job } from '../api/types.js';
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
        ]}
      />
    </Space>
  );
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
