import { ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
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
  Pagination,
  Segmented,
  Space,
  Table,
  Tag,
  Tabs,
  Timeline,
  Typography,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../api/client.js';
import type { Integration, TaskConflict, TaskDetail, TaskSummary } from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';
import { TaskEvidencePanel } from './TaskEvidencePanel.js';
import { evidenceStateLabel } from './evidence-view-model.js';
import { buildTaskQuery, groupTasksByParent } from './task-view-model.js';

const editableTaskFields = [
  { fieldName: 'plannedStartDate', label: '计划开始日期' },
  { fieldName: 'dueDate', label: '到期日期' },
  { fieldName: 'originalEstimateSeconds', label: '原始预估工时' },
] as const;
type EditableTaskField = (typeof editableTaskFields)[number]['fieldName'];

export function TasksPage() {
  const queryClient = useQueryClient();
  const [messageApi, holder] = message.useMessage();
  const [dateRange, setDateRange] = useState<[string, string] | undefined>(() =>
    currentWorkWeekRange(),
  );
  const [viewMode, setViewMode] = useState<'list' | 'parent'>('list');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const pageCursors = useRef(new Map<number, string | undefined>([[1, undefined]]));
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiRequest<Integration[]>('/api/v1/integrations'),
  });
  const jiraConnections = useMemo(
    () => (integrations.data?.data ?? []).filter((item) => item.type === 'jira'),
    [integrations.data],
  );
  const queryString = buildTaskQuery(
    {
      currentUser: 'true',
      source: 'jira',
      visibility: 'visible',
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
  const conflicts = useQuery({
    queryKey: ['task-conflicts'],
    queryFn: () =>
      apiRequest<TaskConflict[]>(
        `/api/v1/tasks/conflicts?${new URLSearchParams({
          limit: '100',
        }).toString()}`,
      ),
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
  const refreshJira = useMutation({
    mutationFn: async () => {
      const connections = jiraConnections.filter(
        (connection) => connection.enabled && connection.credentialMask,
      );
      if (connections.length === 0) throw new Error('没有可用的 Jira 连接');
      return Promise.all(
        connections.map((connection) =>
          ['healthy', 'degraded'].includes(connection.status)
            ? apiRequest(`/api/v1/integrations/${connection.id}/jira/sync`, {
                method: 'POST',
                body: JSON.stringify({ scope: 'full' }),
              })
            : apiRequest(`/api/v1/integrations/${connection.id}/test`, { method: 'POST' }),
        ),
      );
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['integrations'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      ]);
      void messageApi.success('Jira 刷新已开始，完成后任务会自动显示');
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
          {row.conflictCount > 0 && <Tag color="red">{row.conflictCount} 个字段冲突</Tag>}
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
          <Typography.Text>
            开始 {row.schedule.plannedStartDate ?? '—'} {fieldSourceTag(row, 'plannedStartDate')}
          </Typography.Text>
          <Typography.Text>
            到期 {row.schedule.dueDate ?? '—'} {fieldSourceTag(row, 'dueDate')}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '工时',
      width: 150,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>
            预估 {seconds(row.worklog.originalEstimateSeconds)}{' '}
            {fieldSourceTag(row, 'originalEstimateSeconds')}
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
          Jira 会在后台自动拉取分配给你的全部任务；页面只展示任务，周报和绩效按任务日期自动整理。
        </Typography.Text>
      </div>
      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        message="Jira 只读自动同步"
        description="连接后自动全量拉取，之后每天早上 6 点增量更新；也可使用下方“刷新 Jira”立即全量拉取。页面不会写入 Jira。"
      />
      <div className="summary-grid">
        <Card size="small">
          <Typography.Text type="secondary">任务总数</Typography.Text>
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
          <Typography.Text type="secondary">本页其他状态</Typography.Text>
          <Typography.Title level={3}>{counts.other ?? 0}</Typography.Title>
        </Card>
      </div>
      {(conflicts.data?.total ?? 0) > 0 && (
        <Card
          title={`Jira / 人工覆盖冲突（${conflicts.data?.total ?? 0}）`}
          extra={<Tag color="red">必须人工处理，不会静默覆盖</Tag>}
        >
          <Table<TaskConflict>
            rowKey="id"
            size="small"
            loading={conflicts.isLoading}
            dataSource={conflicts.data?.data ?? []}
            pagination={{ pageSize: 10, showSizeChanger: false }}
            onRow={(row) => ({ onClick: () => setSelectedTaskId(row.task.id) })}
            columns={[
              {
                title: '任务',
                render: (_, row) => `${row.task.issueKey ?? '本地任务'} · ${row.task.title}`,
              },
              {
                title: '字段',
                dataIndex: 'fieldName',
                render: taskFieldLabel,
              },
              {
                title: '人工值',
                dataIndex: 'manualValue',
                render: displayTaskFieldValue,
              },
              {
                title: 'Jira 最新值',
                dataIndex: 'jiraValue',
                render: displayTaskFieldValue,
              },
              {
                title: '有效期',
                dataIndex: 'expiresAt',
                render: (value: string | null) =>
                  value ? new Date(value).toLocaleString('zh-CN') : '无',
              },
            ]}
          />
        </Card>
      )}
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={refreshJira.isPending}
            disabled={!jiraConnections.some((item) => item.enabled && item.credentialMask)}
            onClick={() => refreshJira.mutate()}
          >
            刷新 Jira
          </Button>
          <DatePicker.RangePicker
            allowClear
            value={dateRange ? [dayjs(dateRange[0]), dayjs(dateRange[1])] : null}
            format="YYYY-MM-DD"
            placeholder={['到期日期开始', '到期日期结束']}
            onChange={(dates) => {
              setDateRange(
                dates?.[0] && dates[1]
                  ? [dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]
                  : undefined,
              );
              resetPagination();
            }}
          />
        </Space>
        {jiraConnections.length === 0 && (
          <Alert
            type="warning"
            showIcon
            message="尚未配置 Jira 连接"
            description="请先到“设置与集成”添加 Jira 地址和访问凭证；保存后系统会自动连接并拉取全部个人任务。"
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
              locale={{ emptyText: <Empty description="尚未拉取到 Jira 任务" /> }}
              scroll={{ x: 1230 }}
              pagination={{
                current: page,
                pageSize,
                total: tasks.data?.total ?? 0,
                simple: true,
                showSizeChanger: true,
                pageSizeOptions: [20, 50, 100],
                showTotal: (total) => `共 ${total} 条任务`,
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
            <Empty description="尚未拉取到 Jira 任务" />
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
                showTotal={(total) => `共 ${total} 条任务`}
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
    </Space>
  );
}

function currentWorkWeekRange(now = dayjs()): [string, string] {
  const monday = now.subtract((now.day() + 6) % 7, 'day');
  return [monday.format('YYYY-MM-DD'), monday.add(4, 'day').format('YYYY-MM-DD')];
}

function TaskDetailView({ task }: { task: TaskDetail }) {
  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <Tabs
        destroyOnHidden
        items={[
          {
            key: 'overview',
            label: '概览',
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Card title="字段值与来源">
                  <Table
                    rowKey="fieldName"
                    size="small"
                    pagination={false}
                    dataSource={editableTaskFields.map((field) => {
                      const provenance = task.fieldProvenances.find(
                        (item) => item.fieldName === field.fieldName && item.active,
                      );
                      return { ...field, value: taskFieldValue(task, field.fieldName), provenance };
                    })}
                    columns={[
                      { title: '字段', dataIndex: 'label' },
                      { title: '当前值', dataIndex: 'value', render: displayTaskFieldValue },
                      {
                        title: '生效来源',
                        render: (_, row) => (
                          <Space>
                            <Tag color={sourceTagColor(row.provenance?.sourceType)}>
                              {row.provenance?.sourceType ?? '未记录'}
                            </Tag>
                            {row.provenance?.conflictDetectedAt && (
                              <Tag color="red">与 Jira 冲突</Tag>
                            )}
                          </Space>
                        ),
                      },
                      {
                        title: '原因 / 有效期',
                        render: (_, row) => (
                          <Space direction="vertical" size={0}>
                            <Typography.Text>{row.provenance?.reason ?? '—'}</Typography.Text>
                            <Typography.Text type="secondary">
                              {row.provenance?.expiresAt
                                ? `至 ${new Date(row.provenance.expiresAt).toLocaleString('zh-CN')}`
                                : '无人工有效期'}
                            </Typography.Text>
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Card>
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
                  <Descriptions.Item label="经办人">
                    {task.assigneeName ?? '未分配'}
                  </Descriptions.Item>
                  <Descriptions.Item label="可见性">{task.visibilityState}</Descriptions.Item>
                  <Descriptions.Item label="计划开始">
                    {task.schedule.plannedStartDate ?? '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="到期日">
                    {task.schedule.dueDate ?? '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="描述策略" span={2}>
                    不持久化 Jira description，仅保存任务视图所需字段
                  </Descriptions.Item>
                </Descriptions>
              </Space>
            ),
          },
          {
            key: 'sources',
            label: '来源与字段',
            children: (
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
                        render: (value: string) => taskFieldLabel(value),
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
            ),
          },
          {
            key: 'evidence',
            label: '证据',
            children: (
              <div>
                <Typography.Title level={4}>任务与 Git/GitLab 证据</Typography.Title>
                <TaskEvidencePanel task={task} />
              </div>
            ),
          },
          {
            key: 'observations',
            label: '状态观测',
            children: (
              <Space direction="vertical" size={20} style={{ width: '100%' }}>
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
                              {event.from.name ?? '首次观测'} →{' '}
                              {event.to.name ?? event.to.normalized}
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
            ),
          },
          {
            key: 'weekly-references',
            label: `周报引用（${task.weeklyReportReferences.length}）`,
            children: <WeeklyReportReferences task={task} />,
          },
          {
            key: 'quarterly-references',
            label: `绩效引用（${task.quarterlyReviewReferences.length}）`,
            children: <QuarterlyReviewReferences task={task} />,
          },
        ]}
      />
    </Space>
  );
}

function WeeklyReportReferences({ task }: { task: TaskDetail }) {
  if (task.weeklyReportReferences.length === 0) {
    return <Empty description="该任务尚未被任何周报段落引用" />;
  }
  return (
    <Table
      rowKey="id"
      size="small"
      pagination={{ pageSize: 8 }}
      dataSource={task.weeklyReportReferences}
      columns={[
        {
          title: '周报周期',
          render: (_, row) => (
            <Space direction="vertical" size={0}>
              <Typography.Link
                strong
                href={`/weekly-reports?reportId=${encodeURIComponent(row.report.id)}`}
              >
                {row.report.periodStart} ～ {row.report.periodEnd}
              </Typography.Link>
              <Space>
                <Typography.Text type="secondary">填报日 {row.report.reportDate}</Typography.Text>
                <Tag>{row.report.status}</Tag>
              </Space>
            </Space>
          ),
        },
        {
          title: '不可变版本',
          render: (_, row) => (
            <Space wrap>
              <Tag color="blue">v{row.version.versionNo}</Tag>
              <Tag>{row.version.origin}</Tag>
              {/* 当前版本和已确认版本可能不同，必须分别展示，不能合并成含糊的“有效”。 */}
              {row.version.current && <Tag color="processing">当前</Tag>}
              {row.version.confirmed && <Tag color="success">已确认</Tag>}
            </Space>
          ),
        },
        {
          title: '引用位置',
          render: (_, row) => (
            <Space direction="vertical" size={0}>
              <Typography.Text>{weeklyFieldLabel(row.fieldName)}</Typography.Text>
              <Typography.Text code copyable>
                {row.blockId}
              </Typography.Text>
            </Space>
          ),
        },
        {
          title: '冻结来源摘要',
          dataIndex: 'sourceSummary',
          render: displayReferenceSummary,
        },
        {
          title: '引用时间',
          dataIndex: 'linkedAt',
          render: (value: string) => new Date(value).toLocaleString('zh-CN'),
        },
      ]}
    />
  );
}

function QuarterlyReviewReferences({ task }: { task: TaskDetail }) {
  if (task.quarterlyReviewReferences.length === 0) {
    return <Empty description="该任务尚未作为任何季度成果证据" />;
  }
  return (
    <Table
      rowKey="id"
      size="small"
      pagination={{ pageSize: 8 }}
      dataSource={task.quarterlyReviewReferences}
      columns={[
        {
          title: '季度评审',
          render: (_, row) => (
            <Space direction="vertical" size={0}>
              <Typography.Link
                strong
                href={`/quarterly-reviews?reviewId=${encodeURIComponent(row.review.id)}`}
              >
                {row.review.name}
              </Typography.Link>
              <Typography.Text type="secondary">
                {row.review.periodStart} ～ {row.review.periodEnd}
              </Typography.Text>
              <Space>
                <Tag>{row.review.status}</Tag>
                <Typography.Text type="secondary">聚合版本 v{row.review.version}</Typography.Text>
              </Space>
            </Space>
          ),
        },
        {
          title: '成果',
          render: (_, row) => (
            <Space direction="vertical" size={0}>
              <Typography.Text>{row.achievement.title}</Typography.Text>
              <Space wrap>
                <Tag color={row.achievement.selectionStatus === 'selected' ? 'success' : 'default'}>
                  {row.achievement.selectionStatus}
                </Tag>
                <Tag color={row.achievement.evidenceStatus === 'complete' ? 'success' : 'warning'}>
                  {row.achievement.evidenceStatus}
                </Tag>
                <Typography.Text type="secondary">成果 v{row.achievement.version}</Typography.Text>
              </Space>
            </Space>
          ),
        },
        {
          title: '证据身份',
          render: (_, row) => (
            <Space direction="vertical" size={0}>
              <Typography.Text>{row.evidence.title}</Typography.Text>
              <Space wrap>
                <Tag>{row.evidence.sourceType}</Tag>
                {row.evidence.primary && <Tag color="gold">主证据</Tag>}
                <Tag color={row.evidence.availabilityState === 'available' ? 'success' : 'warning'}>
                  {row.evidence.availabilityState}
                </Tag>
              </Space>
            </Space>
          ),
        },
        {
          title: '贡献角度',
          dataIndex: ['evidence', 'contributionAngle'],
          render: (value: string) => value || '未填写',
        },
        {
          title: '引用时间',
          dataIndex: 'linkedAt',
          render: (value: string) => new Date(value).toLocaleString('zh-CN'),
        },
      ]}
    />
  );
}

function weeklyFieldLabel(value: string): string {
  return (
    {
      reportDate: '填报日期',
      recentGoals: '近期目标',
      weeklyWork: '本周工作',
      nextWeekPlans: '下周计划',
      problems: '问题与风险',
      other: '其他事项',
    }[value] ?? value
  );
}

function displayReferenceSummary(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return displaySourceValue(value);
  const summary = value as Record<string, unknown>;
  const issueKey = typeof summary.issueKey === 'string' ? summary.issueKey : '';
  const title = typeof summary.title === 'string' ? summary.title : '';
  if (issueKey || title) return [issueKey, title].filter(Boolean).join(' · ');
  return JSON.stringify(summary);
}

function seconds(value: number | null): string {
  if (value === null) return '—';
  return `${(value / 3600).toFixed(value % 3600 === 0 ? 0 : 1)} h`;
}

function taskFieldLabel(value: string): string {
  return (
    {
      plannedStartDate: '计划开始',
      dueDate: '到期日',
      originalEstimateSeconds: '原始预估工时',
    }[value] ?? value
  );
}

function taskFieldValue(task: TaskSummary, fieldName: EditableTaskField): string | number | null {
  if (fieldName === 'plannedStartDate') return task.schedule.plannedStartDate;
  if (fieldName === 'dueDate') return task.schedule.dueDate;
  return task.worklog.originalEstimateSeconds;
}

function displayTaskFieldValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return seconds(value);
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '—';
}

function sourceTagColor(sourceType: string | undefined): string {
  return sourceType === 'jira'
    ? 'blue'
    : sourceType === 'excel'
      ? 'green'
      : sourceType === 'manual'
        ? 'gold'
        : 'default';
}

function fieldSourceTag(task: TaskSummary, fieldName: EditableTaskField) {
  const source = task.fieldSources[fieldName];
  if (!source) return null;
  return (
    <Tag color={source.conflict ? 'red' : sourceTagColor(source.sourceType)}>
      {source.sourceType.toUpperCase()}
      {source.conflict ? ' 冲突' : ''}
    </Tag>
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
