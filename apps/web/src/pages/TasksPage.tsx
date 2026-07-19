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
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tabs,
  Timeline,
  Typography,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../api/client.js';
import type {
  Integration,
  ProjectSummary,
  TaskConflict,
  TaskDetail,
  TaskOverrideResult,
  TaskSummary,
} from '../api/types.js';
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

const editableTaskFields = [
  { fieldName: 'plannedStartDate', label: '计划开始日期' },
  { fieldName: 'dueDate', label: '到期日期' },
  { fieldName: 'originalEstimateSeconds', label: '原始预估工时' },
] as const;
type EditableTaskField = (typeof editableTaskFields)[number]['fieldName'];

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
  const [conflict, setConflict] = useState<string>();
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
      conflict,
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
  const conflicts = useQuery({
    queryKey: ['task-conflicts', projectId],
    queryFn: () =>
      apiRequest<TaskConflict[]>(
        `/api/v1/tasks/conflicts?${new URLSearchParams({
          limit: '100',
          ...(projectId ? { projectId } : {}),
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
          <Select
            allowClear
            placeholder="字段冲突"
            value={conflict}
            onChange={(value) => {
              setConflict(value);
              resetPagination();
            }}
            options={[
              { value: 'true', label: '仅有冲突' },
              { value: 'false', label: '排除冲突' },
            ]}
            style={{ width: 140 }}
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
        {detail.data?.data && (
          <TaskDetailView
            task={detail.data.data}
            onUpdated={async () => {
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['tasks'] }),
                queryClient.invalidateQueries({ queryKey: ['task-detail', selectedTaskId] }),
                queryClient.invalidateQueries({ queryKey: ['task-conflicts'] }),
              ]);
            }}
          />
        )}
      </Drawer>
      <ExcelImportModal open={excelImportOpen} onClose={() => setExcelImportOpen(false)} />
    </Space>
  );
}

function TaskDetailView({ task, onUpdated }: { task: TaskDetail; onUpdated: () => Promise<void> }) {
  const [messageApi, holder] = message.useMessage();
  const [overrideField, setOverrideField] = useState<EditableTaskField>();
  const [revokeField, setRevokeField] = useState<EditableTaskField>();
  const [overrideForm] = Form.useForm<{
    dateValue?: Dayjs;
    estimateHours?: number;
    reason: string;
    expiresAt: Dayjs;
  }>();
  const [revokeForm] = Form.useForm<{ reason: string }>();
  const setOverride = useMutation({
    mutationFn: async (values: {
      dateValue?: Dayjs;
      estimateHours?: number;
      reason: string;
      expiresAt: Dayjs;
    }) => {
      if (!overrideField) throw new Error('未选择覆盖字段');
      // 页面使用“小时”方便人工填写，接口和任务事实仍统一保存为整数秒。
      const value =
        overrideField === 'originalEstimateSeconds'
          ? Math.round((values.estimateHours ?? 0) * 3_600)
          : values.dateValue?.format('YYYY-MM-DD');
      if (value === undefined) throw new Error('覆盖值不能为空');
      return apiRequest<TaskOverrideResult>(`/api/v1/tasks/${task.id}/overrides`, {
        method: 'PUT',
        body: JSON.stringify({
          fieldName: overrideField,
          value,
          reason: values.reason,
          expiresAt: values.expiresAt.toISOString(),
          version: task.version,
        }),
      });
    },
    onSuccess: async () => {
      setOverrideField(undefined);
      overrideForm.resetFields();
      // 覆盖会同时改变任务摘要、详情来源和冲突清单，三个缓存必须原子失效。
      await onUpdated();
      void messageApi.success('本地覆盖已保存；Jira 主事实仍会同步并显式提示冲突');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });
  const revokeOverride = useMutation({
    mutationFn: async (values: { reason: string }) => {
      if (!revokeField) throw new Error('未选择撤销字段');
      return apiRequest(`/api/v1/tasks/${task.id}/overrides/${revokeField}`, {
        method: 'DELETE',
        body: JSON.stringify({ version: task.version, reason: values.reason }),
      });
    },
    onSuccess: async () => {
      setRevokeField(undefined);
      revokeForm.resetFields();
      await onUpdated();
      void messageApi.success('人工覆盖已撤销，已恢复最新可用来源事实');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const openOverride = (fieldName: EditableTaskField) => {
    const currentValue = taskFieldValue(task, fieldName);
    setOverrideField(fieldName);
    overrideForm.setFieldsValue({
      ...(fieldName === 'originalEstimateSeconds'
        ? typeof currentValue === 'number'
          ? { estimateHours: currentValue / 3_600 }
          : {}
        : {
            ...(typeof currentValue === 'string' && currentValue
              ? { dateValue: dayjs(currentValue) }
              : {}),
          }),
      expiresAt: dayjs().add(30, 'day').endOf('day'),
      reason: '',
    });
  };

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      {holder}
      <Alert
        type="warning"
        showIcon
        message="本地覆盖不会修改 Jira"
        description="覆盖必须填写原因和有效期。Jira 新值与人工值不同时会进入冲突清单；到期或撤销后恢复最新 Jira/Excel 来源事实。"
      />
      <Tabs
        destroyOnHidden
        items={[
          {
            key: 'overview',
            label: '概览',
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Card title="本地字段覆盖与来源">
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
                  {row.provenance?.conflictDetectedAt && <Tag color="red">与 Jira 冲突</Tag>}
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
            {
              title: '操作',
              render: (_, row) => (
                <Space>
                  <Button size="small" onClick={() => openOverride(row.fieldName)}>
                    {row.provenance?.sourceType === 'manual' ? '调整覆盖' : '人工覆盖'}
                  </Button>
                  {row.provenance?.sourceType === 'manual' && row.provenance.active && (
                    <Button
                      size="small"
                      danger
                      onClick={() => {
                        revokeForm.resetFields();
                        setRevokeField(row.fieldName);
                      }}
                    >
                      撤销
                    </Button>
                  )}
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
      <Modal
        title={`人工覆盖：${taskFieldLabel(overrideField ?? '')}`}
        open={Boolean(overrideField)}
        confirmLoading={setOverride.isPending}
        onCancel={() => setOverrideField(undefined)}
        onOk={() => overrideForm.submit()}
        destroyOnHidden
      >
        <Form
          form={overrideForm}
          layout="vertical"
          onFinish={(values) => setOverride.mutate(values)}
        >
          {overrideField === 'originalEstimateSeconds' ? (
            <Form.Item
              name="estimateHours"
              label="原始预估（小时）"
              rules={[{ required: true, message: '请输入非负工时' }]}
            >
              <InputNumber min={0} max={87_660} precision={2} style={{ width: '100%' }} />
            </Form.Item>
          ) : (
            <Form.Item
              name="dateValue"
              label="业务日期"
              rules={[{ required: true, message: '请选择日期' }]}
            >
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          )}
          <Form.Item
            name="reason"
            label="覆盖原因"
            rules={[{ required: true, min: 3, message: '请填写至少 3 个字符的原因' }]}
          >
            <Input.TextArea rows={3} maxLength={1_000} showCount />
          </Form.Item>
          <Form.Item
            name="expiresAt"
            label="有效期截止"
            rules={[{ required: true, message: '请选择有效期' }]}
          >
            <DatePicker
              showTime
              // 服务端要求有效期处于未来且不超过 366 天，页面先行阻止明显无效日期。
              disabledDate={(value) =>
                value.endOf('day').isBefore(dayjs()) || value.startOf('day').isAfter(dayjs().add(366, 'day'))
              }
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={`撤销人工覆盖：${taskFieldLabel(revokeField ?? '')}`}
        open={Boolean(revokeField)}
        confirmLoading={revokeOverride.isPending}
        okButtonProps={{ danger: true }}
        okText="确认撤销并恢复来源事实"
        onCancel={() => setRevokeField(undefined)}
        onOk={() => revokeForm.submit()}
        destroyOnHidden
      >
        <Form
          form={revokeForm}
          layout="vertical"
          onFinish={(values) => revokeOverride.mutate(values)}
        >
          <Form.Item
            name="reason"
            label="撤销原因"
            rules={[{ required: true, min: 3, message: '请填写至少 3 个字符的原因' }]}
          >
            <Input.TextArea rows={3} maxLength={1_000} showCount />
          </Form.Item>
        </Form>
      </Modal>
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
