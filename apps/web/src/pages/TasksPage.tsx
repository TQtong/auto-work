import { FileExcelOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Collapse,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Pagination,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../api/client.js';
import type { Integration, ProjectSummary, TaskDetail, TaskSummary } from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';
import { ExcelImportModal } from './ExcelImportModal.js';
import { TaskEvidencePanel } from './TaskEvidencePanel.js';
import { evidenceStateLabel } from './evidence-view-model.js';
import { buildTaskQuery, groupTasksByParent } from './task-view-model.js';

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
  const [rawStatus, setRawStatus] = useState<string>();
  const [currentUser, setCurrentUser] = useState<string>('true');
  const [connectionId, setConnectionId] = useState<string>();
  const [projectId, setProjectId] = useState<string>();
  const [parentIssueKey, setParentIssueKey] = useState<string>();
  const [sprintId, setSprintId] = useState<string>();
  const [source, setSource] = useState<string>();
  const [evidenceState, setEvidenceState] = useState<string>();
  const [visibility, setVisibility] = useState('visible');
  const [dateRange, setDateRange] = useState<[string, string] | undefined>();
  const [viewMode, setViewMode] = useState<'list' | 'parent'>('list');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const pageCursors = useRef(new Map<number, string | undefined>([[1, undefined]]));
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [excelImportOpen, setExcelImportOpen] = useState(false);
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiRequest<Integration[]>('/api/v1/integrations'),
  });
  const jiraConnections = useMemo(
    () => (integrations.data?.data ?? []).filter((item) => item.type === 'jira'),
    [integrations.data],
  );
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiRequest<ProjectSummary[]>('/api/v1/projects'),
  });
  const queryString = buildTaskQuery(
    {
      status,
      rawStatus,
      currentUser,
      connectionId,
      projectId,
      parentIssueKey,
      sprintId,
      source,
      evidenceState,
      visibility,
      dateFrom: dateRange?.[0],
      dateTo: dateRange?.[1],
    },
    { limit: pageSize, cursor: pageCursors.current.get(page) },
  );
  const tasks = useQuery({
    queryKey: ['tasks', queryString],
    queryFn: () => apiRequest<TaskSummary[]>(`/api/v1/tasks?${queryString}`),
    refetchInterval: 15_000,
  });
  useEffect(() => {
    const nextCursor = tasks.data?.page?.nextCursor;
    if (nextCursor) pageCursors.current.set(page + 1, nextCursor);
  }, [page, tasks.data?.page?.nextCursor]);

  const resetPagination = () => {
    pageCursors.current = new Map([[1, undefined]]);
    setPage(1);
  };
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
  const parentGroups = groupTasksByParent(taskItems);
  const taskColumns: TableColumnsType<TaskSummary> = [
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
          {row.sprints.length > 0 && (
            <Typography.Text type="secondary">
              Sprint：
              {row.sprints.map((sprint) => sprint.name ?? sprint.id ?? sprint.raw).join('、')}
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
          <Typography.Text type="secondary">原始：{row.status.rawName ?? '未返回'}</Typography.Text>
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
          <Typography.Text>预估 {seconds(row.worklog.originalEstimateSeconds)}</Typography.Text>
          <Typography.Text>已耗 {seconds(row.worklog.timeSpentSeconds)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '来源 / 经办人',
      width: 180,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Tag color={row.source === 'jira' ? 'blue' : 'default'}>{row.source.toUpperCase()}</Tag>
          <Typography.Text>{row.assigneeName ?? '未分配'}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '证据',
      width: 180,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Tag color={evidenceStateColor(row.evidence.state)}>
            {evidenceStateLabel(row.evidence.state)}
          </Tag>
          <Typography.Text type="secondary">
            确认 {row.evidence.counts.confirmed} · 待处理{' '}
            {row.evidence.counts.suggested + row.evidence.needsRevalidation}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '最后观测',
      dataIndex: 'lastObservedAt',
      width: 190,
      render: (value: string) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{new Date(value).toLocaleString('zh-CN')}</Typography.Text>
          {Date.now() - new Date(value).getTime() > 15 * 60_000 && (
            <Tag color="gold">缓存可能过期</Tag>
          )}
        </Space>
      ),
    },
  ];

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
          <Typography.Text type="secondary">筛选总数</Typography.Text>
          <Typography.Title level={3}>{tasks.data?.total ?? 0}</Typography.Title>
        </Card>
        <Card size="small">
          <Typography.Text type="secondary">本页进行中</Typography.Text>
          <Typography.Title level={3}>{counts.in_progress ?? 0}</Typography.Title>
        </Card>
        <Card size="small">
          <Typography.Text type="secondary">本页已完成</Typography.Text>
          <Typography.Title level={3}>{counts.done ?? 0}</Typography.Title>
        </Card>
        <Card size="small">
          <Typography.Text type="secondary">本页其他/待映射</Typography.Text>
          <Typography.Title level={3}>{counts.other ?? 0}</Typography.Title>
        </Card>
      </div>
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Button
            type="primary"
            icon={<FileExcelOutlined />}
            onClick={() => setExcelImportOpen(true)}
          >
            Excel 安全导入
          </Button>
          <Select
            allowClear
            placeholder="统一状态"
            value={status}
            onChange={(value) => {
              setStatus(value);
              resetPagination();
            }}
            options={statusOptions}
            style={{ width: 160 }}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="项目"
            value={projectId}
            onChange={(value) => {
              setProjectId(value);
              resetPagination();
            }}
            options={(projects.data?.data ?? []).map((project) => ({
              value: project.id,
              label: `${project.name}${project.jiraProjectKey ? ` (${project.jiraProjectKey})` : ''}`,
            }))}
            style={{ width: 220 }}
          />
          <Input
            allowClear
            placeholder="Jira 原始状态（精确）"
            value={rawStatus}
            onChange={(event) => {
              setRawStatus(event.target.value || undefined);
              resetPagination();
            }}
            style={{ width: 200 }}
          />
          <Input
            allowClear
            placeholder="父任务 Key"
            value={parentIssueKey}
            onChange={(event) => {
              setParentIssueKey(event.target.value || undefined);
              resetPagination();
            }}
            style={{ width: 170 }}
          />
          <Input
            allowClear
            placeholder="Sprint ID / 名称"
            value={sprintId}
            onChange={(event) => {
              setSprintId(event.target.value || undefined);
              resetPagination();
            }}
            style={{ width: 180 }}
          />
          <Select
            allowClear
            placeholder="来源"
            value={source}
            onChange={(value) => {
              setSource(value);
              resetPagination();
            }}
            options={[
              { value: 'jira', label: 'Jira' },
              { value: 'excel', label: 'Excel' },
              { value: 'manual', label: '人工' },
            ]}
            style={{ width: 130 }}
          />
          <Select
            value={currentUser}
            onChange={(value) => {
              setCurrentUser(value);
              resetPagination();
            }}
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
            onChange={(value) => {
              setConnectionId(value);
              resetPagination();
            }}
            options={jiraConnections.map((item) => ({ value: item.id, label: item.name }))}
            style={{ width: 220 }}
          />
          <Select
            allowClear
            placeholder="证据状态"
            value={evidenceState}
            onChange={(value) => {
              setEvidenceState(value);
              resetPagination();
            }}
            style={{ width: 170 }}
            options={[
              { value: 'none', label: '无证据' },
              { value: 'suggested', label: '待确认' },
              { value: 'confirmed', label: '已有确认' },
              { value: 'rejected', label: '已拒绝' },
              { value: 'expired', label: '已失效' },
              { value: 'needs_revalidation', label: '需要复核' },
            ]}
          />
          <DatePicker.RangePicker
            onChange={(dates) => {
              setDateRange(
                dates?.[0] && dates[1]
                  ? [dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]
                  : undefined,
              );
              resetPagination();
            }}
            placeholder={['到期日起', '到期日止']}
          />
          <Select
            value={visibility}
            onChange={(value) => {
              setVisibility(value);
              resetPagination();
            }}
            options={[
              { value: 'visible', label: '当前可见' },
              { value: 'out_of_scope', label: '超出范围' },
              { value: 'unavailable', label: '来源不可用' },
            ]}
            style={{ width: 150 }}
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
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Segmented
            value={viewMode}
            onChange={(value) => setViewMode(value as 'list' | 'parent')}
            options={[
              { value: 'list', label: '任务列表' },
              { value: 'parent', label: '按父任务分组' },
            ]}
          />
          {viewMode === 'list' ? (
            <Table<TaskSummary>
              rowKey="id"
              loading={tasks.isLoading}
              dataSource={taskItems}
              locale={{ emptyText: <Empty description="当前筛选没有缓存任务" /> }}
              scroll={{ x: 1230 }}
              pagination={{
                current: page,
                pageSize,
                total: tasks.data?.total ?? 0,
                simple: true,
                showSizeChanger: true,
                pageSizeOptions: [20, 50, 100],
                showTotal: (total) => `共 ${total} 条本地事实`,
                onChange: (nextPage, nextPageSize) => {
                  if (nextPageSize !== pageSize) {
                    setPageSize(nextPageSize);
                    resetPagination();
                  } else if (pageCursors.current.has(nextPage)) {
                    setPage(nextPage);
                  }
                },
              }}
              onRow={(row) => ({ onClick: () => setSelectedTaskId(row.id) })}
              columns={taskColumns}
            />
          ) : parentGroups.length === 0 ? (
            <Empty description="当前筛选没有缓存任务" />
          ) : (
            <>
              <Collapse
                items={parentGroups.map((group) => ({
                  key: group.key,
                  label: (
                    <Space>
                      <Typography.Text strong>{group.issueKey ?? '无父任务'}</Typography.Text>
                      <Typography.Text>{group.title}</Typography.Text>
                      <Tag>{group.tasks.length} 项</Tag>
                    </Space>
                  ),
                  children: (
                    <Table<TaskSummary>
                      rowKey="id"
                      dataSource={group.tasks}
                      columns={taskColumns}
                      pagination={false}
                      scroll={{ x: 1230 }}
                      onRow={(row) => ({ onClick: () => setSelectedTaskId(row.id) })}
                    />
                  ),
                }))}
              />
              <Pagination
                current={page}
                pageSize={pageSize}
                total={tasks.data?.total ?? 0}
                simple
                showSizeChanger
                pageSizeOptions={[20, 50, 100]}
                showTotal={(total) => `共 ${total} 条本地事实`}
                onChange={(nextPage, nextPageSize) => {
                  if (nextPageSize !== pageSize) {
                    setPageSize(nextPageSize);
                    resetPagination();
                  } else if (pageCursors.current.has(nextPage)) {
                    setPage(nextPage);
                  }
                }}
              />
            </>
          )}
        </Space>
      </Card>
      <Drawer
        title={detail.data?.data.issueKey ?? '任务详情'}
        width="min(1280px, 96vw)"
        open={Boolean(selectedTaskId)}
        onClose={() => setSelectedTaskId(null)}
        destroyOnHidden
      >
        {detail.data?.data && <TaskDetailView task={detail.data.data} />}
      </Drawer>
      <ExcelImportModal open={excelImportOpen} onClose={() => setExcelImportOpen(false)} />
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
        <Typography.Title level={4}>字段来源与合并决定</Typography.Title>
        {task.fieldProvenances.length === 0 ? (
          <Empty description="尚无逐字段来源记录" />
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={{ pageSize: 8 }}
            dataSource={task.fieldProvenances}
            columns={[
              {
                title: '字段',
                dataIndex: 'fieldName',
                render: (value: string) => fieldLabel(value),
              },
              {
                title: '当前来源',
                render: (_, row) => (
                  <Space>
                    <Tag color={row.sourceType === 'jira' ? 'blue' : 'green'}>
                      {row.sourceType.toUpperCase()}
                    </Tag>
                    <Tag color={row.active ? 'success' : 'default'}>
                      {row.active ? '当前生效' : '历史'}
                    </Tag>
                  </Space>
                ),
              },
              {
                title: '决定 / 值',
                render: (_, row) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>{provenanceDecision(row.decision)}</Typography.Text>
                    <Typography.Text code>{displaySourceValue(row.value)}</Typography.Text>
                  </Space>
                ),
              },
              {
                title: '原因',
                dataIndex: 'reason',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: '生效 / 失效',
                render: (_, row) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>
                      {new Date(row.effectiveAt).toLocaleString('zh-CN')}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {row.supersededAt
                        ? `失效 ${new Date(row.supersededAt).toLocaleString('zh-CN')}`
                        : '仍在生效'}
                    </Typography.Text>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </div>
      <div>
        <Typography.Title level={4}>任务与 Git/GitLab 证据</Typography.Title>
        <TaskEvidencePanel task={task} />
      </div>
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

function fieldLabel(value: string): string {
  return (
    {
      plannedStartDate: '计划开始',
      dueDate: '到期日',
      originalEstimateSeconds: '原始预估工时',
    }[value] ?? value
  );
}

function provenanceDecision(value: TaskDetail['fieldProvenances'][number]['decision']): string {
  return {
    source_fact: '来源事实',
    supplement: 'Excel 补充 Jira 空字段',
    keep_jira: '保留 Jira 主事实',
    override: '人工覆盖',
    superseded: '已被替代',
  }[value];
}

function displaySourceValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function evidenceStateColor(state: TaskSummary['evidence']['state']): string {
  return {
    none: 'default',
    suggested: 'processing',
    confirmed: 'success',
    rejected: 'error',
    expired: 'default',
    needs_revalidation: 'warning',
  }[state];
}
