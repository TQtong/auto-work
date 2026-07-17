import { ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import { useMemo, useState } from 'react';
import { apiRequest } from '../api/client.js';
import type { Integration, TaskDetail, TaskSummary } from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';

const statusOptions = [
  { value: 'planned', label: '计划中' },
  { value: 'in_progress', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'blocked', label: '受阻' },
  { value: 'cancelled', label: '已取消' },
  { value: 'other', label: '其他' },
];

export function TasksPage() {
  const queryClient = useQueryClient();
  const [messageApi, holder] = message.useMessage();
  const [status, setStatus] = useState<string>();
  const [currentUser, setCurrentUser] = useState<string>('true');
  const [connectionId, setConnectionId] = useState<string>();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiRequest<Integration[]>('/api/v1/integrations'),
  });
  const jiraConnections = useMemo(
    () => (integrations.data?.data ?? []).filter((item) => item.type === 'jira'),
    [integrations.data],
  );
  const queryString = new URLSearchParams({
    limit: '100',
    visibility: 'visible',
    ...(status ? { status } : {}),
    ...(currentUser ? { currentUser } : {}),
    ...(connectionId ? { connectionId } : {}),
  }).toString();
  const tasks = useQuery({
    queryKey: ['tasks', status, currentUser, connectionId],
    queryFn: () => apiRequest<TaskSummary[]>(`/api/v1/tasks?${queryString}`),
    refetchInterval: 15_000,
  });
  const detail = useQuery({
    queryKey: ['task-detail', selectedTaskId],
    queryFn: () => {
      if (!selectedTaskId) throw new Error('未选择任务');
      return apiRequest<TaskDetail>(`/api/v1/tasks/${selectedTaskId}`);
    },
    enabled: Boolean(selectedTaskId),
  });
  const sync = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/integrations/${id}/jira/sync`, {
        method: 'POST',
        body: JSON.stringify({ scope: 'incremental' }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['operations'] });
      void messageApi.success('Jira 增量同步已进入持久化队列');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });
  const taskItems = tasks.data?.data ?? [];
  const counts = taskItems.reduce(
    (result, task) => {
      result.total = (result.total ?? 0) + 1;
      result[task.status.normalized] = (result[task.status.normalized] ?? 0) + 1;
      return result;
    },
    { total: 0 } as Record<string, number>,
  );

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      {holder}
      <div>
        <Typography.Title level={2}>任务与证据</Typography.Title>
        <Typography.Text type="secondary">
          Jira 主事实、原始/统一状态、复合水位和逐次观测均来自本地只读缓存；页面不会修改 Jira。
        </Typography.Text>
      </div>
      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        message="只读任务事实边界"
        description="同步仅请求字段白名单，不保存 description；没有 changelog 时，状态变化只标注为两次观测之间发生，不伪造精确完成时刻。"
      />
      <div className="summary-grid">
        <Card size="small">
          <Typography.Text type="secondary">当前筛选</Typography.Text>
          <Typography.Title level={3}>{counts.total}</Typography.Title>
        </Card>
        <Card size="small">
          <Typography.Text type="secondary">进行中</Typography.Text>
          <Typography.Title level={3}>{counts.in_progress ?? 0}</Typography.Title>
        </Card>
        <Card size="small">
          <Typography.Text type="secondary">已完成</Typography.Text>
          <Typography.Title level={3}>{counts.done ?? 0}</Typography.Title>
        </Card>
        <Card size="small">
          <Typography.Text type="secondary">其他/待映射</Typography.Text>
          <Typography.Title level={3}>{counts.other ?? 0}</Typography.Title>
        </Card>
      </div>
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            allowClear
            placeholder="统一状态"
            value={status}
            onChange={setStatus}
            options={statusOptions}
            style={{ width: 160 }}
          />
          <Select
            value={currentUser}
            onChange={setCurrentUser}
            options={[
              { value: 'true', label: '仅当前用户' },
              { value: '', label: '全部经办人' },
              { value: 'false', label: '非当前用户' },
            ]}
            style={{ width: 160 }}
          />
          <Select
            allowClear
            placeholder="Jira 连接"
            value={connectionId}
            onChange={setConnectionId}
            options={jiraConnections.map((item) => ({ value: item.id, label: item.name }))}
            style={{ width: 220 }}
          />
          {jiraConnections.map((connection) => (
            <Button
              key={connection.id}
              icon={<ReloadOutlined />}
              loading={sync.isPending}
              disabled={
                !connection.enabled ||
                !connection.credentialMask ||
                !['healthy', 'degraded'].includes(connection.status)
              }
              onClick={() => sync.mutate(connection.id)}
            >
              同步 {connection.name}
            </Button>
          ))}
        </Space>
        {jiraConnections.length === 0 && (
          <Alert
            type="warning"
            showIcon
            message="尚未配置 Jira 连接"
            description="请先到“设置与集成”创建连接、执行能力测试并确认字段/状态映射。"
            style={{ marginBottom: 16 }}
          />
        )}
        <Table<TaskSummary>
          rowKey="id"
          loading={tasks.isLoading}
          dataSource={taskItems}
          locale={{ emptyText: <Empty description="当前筛选没有缓存任务" /> }}
          scroll={{ x: 1100 }}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          onRow={(row) => ({ onClick: () => setSelectedTaskId(row.id) })}
          columns={[
            {
              title: '任务',
              width: 380,
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Space>
                    <Typography.Text strong>{row.issueKey ?? '本地补充'}</Typography.Text>
                    <Tag>{row.issueType ?? row.source}</Tag>
                  </Space>
                  <Typography.Text>{row.title}</Typography.Text>
                  {row.parent.issueKey && (
                    <Typography.Text type="secondary">
                      父任务：{row.parent.issueKey} · {row.parent.title}
                    </Typography.Text>
                  )}
                </Space>
              ),
            },
            {
              title: '状态',
              width: 170,
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <StatusTag status={row.status.normalized} />
                  <Typography.Text type="secondary">
                    原始：{row.status.rawName ?? '未返回'}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '排期',
              width: 180,
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text>开始 {row.schedule.plannedStartDate ?? '—'}</Typography.Text>
                  <Typography.Text>到期 {row.schedule.dueDate ?? '—'}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '工时',
              width: 150,
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text>
                    预估 {seconds(row.worklog.originalEstimateSeconds)}
                  </Typography.Text>
                  <Typography.Text>已耗 {seconds(row.worklog.timeSpentSeconds)}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '来源 / 经办人',
              width: 180,
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Tag color={row.source === 'jira' ? 'blue' : 'default'}>
                    {row.source.toUpperCase()}
                  </Tag>
                  <Typography.Text>{row.assigneeName ?? '未分配'}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '最后观测',
              dataIndex: 'lastObservedAt',
              render: (value: string) => new Date(value).toLocaleString('zh-CN'),
            },
          ]}
        />
      </Card>
      <Drawer
        title={detail.data?.data.issueKey ?? '任务详情'}
        width={760}
        open={Boolean(selectedTaskId)}
        onClose={() => setSelectedTaskId(null)}
        destroyOnHidden
      >
        {detail.data?.data && <TaskDetailView task={detail.data.data} />}
      </Drawer>
    </Space>
  );
}

function TaskDetailView({ task }: { task: TaskDetail }) {
  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <Descriptions bordered column={2} size="small">
        <Descriptions.Item label="标题" span={2}>
          {task.title}
        </Descriptions.Item>
        <Descriptions.Item label="统一状态">
          <StatusTag status={task.status.normalized} />
        </Descriptions.Item>
        <Descriptions.Item label="Jira 原状态">
          {task.status.rawName ?? '未返回'} ({task.status.rawId ?? '无 ID'})
        </Descriptions.Item>
        <Descriptions.Item label="主来源">
          <Tag>{task.source.toUpperCase()}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="映射版本">
          {task.mappingVersion ? `v${task.mappingVersion.versionNo}` : '无'}
        </Descriptions.Item>
        <Descriptions.Item label="经办人">{task.assigneeName ?? '未分配'}</Descriptions.Item>
        <Descriptions.Item label="可见性">{task.visibilityState}</Descriptions.Item>
        <Descriptions.Item label="计划开始">
          {task.schedule.plannedStartDate ?? '—'}
        </Descriptions.Item>
        <Descriptions.Item label="到期日">{task.schedule.dueDate ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="描述策略" span={2}>
          不持久化 Jira description，仅保存任务视图所需字段
        </Descriptions.Item>
      </Descriptions>
      <div>
        <Typography.Title level={4}>状态观测时间线</Typography.Title>
        {task.statusEvents.length === 0 ? (
          <Empty description="尚无状态变化观测" />
        ) : (
          <Timeline
            items={task.statusEvents.map((event) => ({
              color: 'blue',
              children: (
                <div>
                  <Typography.Text strong>
                    {event.from.name ?? '首次观测'} → {event.to.name ?? event.to.normalized}
                  </Typography.Text>
                  <br />
                  <Typography.Text type="secondary">
                    观测于 {new Date(event.observedAt).toLocaleString('zh-CN')}
                    {event.observedIntervalStart
                      ? `；发生区间起点 ${new Date(event.observedIntervalStart).toLocaleString('zh-CN')}`
                      : ''}
                  </Typography.Text>
                </div>
              ),
            }))}
          />
        )}
      </div>
      <div>
        <Typography.Title level={4}>来源观测</Typography.Title>
        <Table
          rowKey="id"
          size="small"
          pagination={{ pageSize: 8 }}
          dataSource={task.observations}
          columns={[
            {
              title: '来源',
              dataIndex: 'sourceType',
              render: (value: string) => <Tag>{value}</Tag>,
            },
            {
              title: '来源更新时间',
              dataIndex: 'sourceUpdatedAt',
              render: (value: string | null) =>
                value ? new Date(value).toLocaleString('zh-CN') : '—',
            },
            {
              title: '警告',
              dataIndex: 'warnings',
              render: (value: TaskDetail['observations'][number]['warnings']) =>
                value.length === 0
                  ? '无'
                  : value.map((warning) => (
                      <Tag color="warning" key={`${warning.code}:${warning.message}`}>
                        {warning.code}
                      </Tag>
                    )),
            },
            {
              title: '哈希',
              dataIndex: 'contentHash',
              render: (value: string) => (
                <Typography.Text code>{value.slice(0, 12)}</Typography.Text>
              ),
            },
          ]}
        />
      </div>
    </Space>
  );
}

function seconds(value: number | null): string {
  if (value === null) return '—';
  return `${(value / 3600).toFixed(value % 3600 === 0 ? 0 : 1)} h`;
}
