import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Descriptions,
  Form,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect } from 'react';
import { apiRequest } from '../api/client.js';
import type {
  Integration,
  JiraCapabilities,
  JiraCapabilityField,
  JiraMappingVersion,
  ProjectSummary,
} from '../api/types.js';

const fieldPurposes = [
  ['plannedStartDate', '计划开始日期', true],
  ['dueDate', '到期日', false],
  ['sprint', 'Sprint', true],
  ['parent', '父任务', false],
  ['originalEstimateSeconds', '原始预估秒', false],
  ['remainingEstimateSeconds', '剩余预估秒', false],
  ['timeSpentSeconds', '已耗时秒', false],
  ['assignee', '经办人', false],
  ['status', '状态', false],
  ['priority', '优先级', false],
  ['labels', '标签', false],
  ['components', '组件', false],
] as const;

const normalizedStatuses = [
  { value: 'planned', label: '计划中' },
  { value: 'in_progress', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'blocked', label: '受阻' },
  { value: 'cancelled', label: '已取消' },
  { value: 'other', label: '其他（保留原状态）' },
];

interface MappingFormValues {
  fieldMappings: Record<string, string | null | undefined>;
  statusMappings: Record<string, string>;
  projectMappings: Record<string, string | null | undefined>;
}

export function JiraSettingsModal({
  connection,
  onClose,
}: {
  connection: Integration | null;
  onClose: () => void;
}) {
  const [form] = Form.useForm<MappingFormValues>();
  const [messageApi, holder] = message.useMessage();
  const queryClient = useQueryClient();
  const capabilities = useQuery({
    queryKey: ['jira-capabilities', connection?.id],
    queryFn: () => {
      if (!connection) throw new Error('未选择 Jira 连接');
      return apiRequest<JiraCapabilities>(
        `/api/v1/integrations/${connection.id}/jira/capabilities`,
      );
    },
    enabled: Boolean(connection),
  });
  const mappings = useQuery({
    queryKey: ['jira-mappings', connection?.id],
    queryFn: () => {
      if (!connection) throw new Error('未选择 Jira 连接');
      return apiRequest<JiraMappingVersion[]>(
        `/api/v1/integrations/${connection.id}/jira/mappings`,
      );
    },
    enabled: Boolean(connection),
  });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiRequest<ProjectSummary[]>('/api/v1/projects'),
    enabled: Boolean(connection),
  });
  const fields = capabilities.data?.data.capabilities.fields ?? [];
  const statuses = capabilities.data?.data.capabilities.statuses ?? [];
  const latest = mappings.data?.data[0];
  useEffect(() => {
    if (!connection || fields.length === 0) return;
    const byId = new Map(fields.map((field) => [field.id, field]));
    const systemDefaults: Record<string, string | undefined> = {
      plannedStartDate: findField(fields, ['start date', '开始日期', '计划开始']),
      dueDate: byId.has('duedate') ? 'duedate' : findField(fields, ['due date', '到期日']),
      sprint: findField(fields, ['sprint']),
      parent: byId.has('parent') ? 'parent' : findField(fields, ['parent', '父任务']),
      originalEstimateSeconds: byId.has('timeoriginalestimate')
        ? 'timeoriginalestimate'
        : undefined,
      remainingEstimateSeconds: byId.has('timeestimate') ? 'timeestimate' : undefined,
      timeSpentSeconds: byId.has('timespent') ? 'timespent' : undefined,
      assignee: byId.has('assignee') ? 'assignee' : undefined,
      status: byId.has('status') ? 'status' : undefined,
      priority: byId.has('priority') ? 'priority' : undefined,
      labels: byId.has('labels') ? 'labels' : undefined,
      components: byId.has('components') ? 'components' : undefined,
    };
    form.setFieldsValue({
      fieldMappings: latest?.fieldMappings ?? systemDefaults,
      statusMappings:
        latest?.statusMappings ??
        Object.fromEntries(
          statuses.map((status) => [status.id, categoryDefault(status.categoryKey)]),
        ),
      projectMappings: Object.fromEntries(
        (projects.data?.data ?? []).map((project) => [project.id, project.jiraProjectKey]),
      ),
    });
  }, [connection, fields, form, latest, projects.data?.data, statuses]);

  const save = useMutation({
    mutationFn: async (values: MappingFormValues) => {
      if (!connection) throw new Error('未选择 Jira 连接');
      const selectedProjectKeys = Object.values(values.projectMappings ?? {}).filter(
        (value): value is string => Boolean(value),
      );
      if (new Set(selectedProjectKeys).size !== selectedProjectKeys.length) {
        throw new Error('同一个 Jira 项目不能同时绑定多个本地业务项目');
      }
      const fieldMappings = Object.fromEntries(
        fieldPurposes.map(([purpose, , nullable]) => [
          purpose,
          values.fieldMappings[purpose] ?? (nullable ? null : undefined),
        ]),
      );
      // 先创建不可变映射版本，只有映射校验成功后才更新本地项目绑定，避免半配置状态。
      const result = await apiRequest<JiraMappingVersion>(
        `/api/v1/integrations/${connection.id}/jira/mappings`,
        {
          method: 'POST',
          body: JSON.stringify({
            fieldMappings,
            statusMappings: values.statusMappings,
            parserRules: {
              parentFallbackFieldId: null,
              sprintStringFallback: true,
              preserveUnknownStatus: true,
            },
          }),
        },
      );
      const changedProjects = (projects.data?.data ?? []).filter(
        (project) =>
          (values.projectMappings?.[project.id] ?? null) !== (project.jiraProjectKey ?? null),
      );
      await Promise.all(
        changedProjects.map((project) =>
          apiRequest<ProjectSummary>(`/api/v1/projects/${project.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              version: project.version,
              jiraProjectKey: values.projectMappings?.[project.id] ?? null,
            }),
          }),
        ),
      );
      return result;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['jira-mappings', connection?.id] }),
        queryClient.invalidateQueries({ queryKey: ['jira-capabilities', connection?.id] }),
        queryClient.invalidateQueries({ queryKey: ['integrations'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
      ]);
      void messageApi.success('Jira 字段与状态映射已保存为不可变新版本');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  return (
    <Modal
      title={`${connection?.name ?? 'Jira'} · 字段与状态映射`}
      width={1120}
      open={Boolean(connection)}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      {holder}
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="Jira 始终是同 issue key 的主事实"
          description="映射按版本保存；任务同步只读且不持久化 description。未知状态保留原 ID/名称并归入 other，不会按中文字符串猜测。"
        />
        <Descriptions bordered size="small" column={3}>
          <Descriptions.Item label="连接状态">
            {capabilities.data?.data.status ?? connection?.status}
          </Descriptions.Item>
          <Descriptions.Item label="搜索方式">
            {capabilities.data?.data.capabilities.search?.selectedMethod?.toUpperCase() ?? '未探测'}
          </Descriptions.Item>
          <Descriptions.Item label="当前映射">
            {latest ? `v${latest.versionNo}` : '尚未配置'}
          </Descriptions.Item>
          <Descriptions.Item label="当前身份">
            {capabilities.data?.data.capabilities.identity?.name ?? '未探测'}
          </Descriptions.Item>
          <Descriptions.Item label="样例任务">
            {capabilities.data?.data.capabilities.sampleIssueCount ?? 0} /{' '}
            {capabilities.data?.data.capabilities.sampleTotal ?? 0}
          </Descriptions.Item>
          <Descriptions.Item label="项目可见数">
            {capabilities.data?.data.capabilities.projects?.length ?? 0}
          </Descriptions.Item>
        </Descriptions>
        {fields.length === 0 ? (
          <Alert
            type="warning"
            showIcon
            message="请先在连接列表执行能力测试，获取字段、状态和样例出现率。"
          />
        ) : (
          <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
            <Typography.Title level={4}>字段用途映射</Typography.Title>
            <div className="form-grid">
              {fieldPurposes.map(([purpose, label, nullable]) => (
                <Form.Item
                  key={purpose}
                  name={['fieldMappings', purpose]}
                  label={label}
                  rules={nullable ? [] : [{ required: true }]}
                >
                  <Select
                    allowClear={nullable}
                    showSearch
                    optionFilterProp="label"
                    options={fields.map((field) => ({
                      value: field.id,
                      label: `${field.name} · ${field.id} · ${field.schema?.type ?? 'unknown'} · ${(field.occurrenceRate * 100).toFixed(0)}%`,
                    }))}
                  />
                </Form.Item>
              ))}
            </div>
            <Typography.Title level={4}>业务项目与 Jira 项目绑定</Typography.Title>
            <Alert
              type="warning"
              showIcon
              message="一个 Jira 项目键只能绑定一个本地业务项目"
              description="任务同步会按该绑定写入项目归属；取消绑定不会删除历史任务，只会让后续未匹配任务保持未归属。"
              style={{ marginBottom: 12 }}
            />
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={projects.data?.data ?? []}
              columns={[
                {
                  title: '本地业务项目',
                  render: (_, row) => (
                    <>
                      <Typography.Text strong>{row.name}</Typography.Text>
                      {row.alias ? (
                        <Typography.Text type="secondary"> · {row.alias}</Typography.Text>
                      ) : null}
                    </>
                  ),
                },
                {
                  title: 'Jira 项目',
                  render: (_, row) => (
                    <Form.Item name={['projectMappings', row.id]} style={{ margin: 0 }}>
                      <Select
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        placeholder="未绑定"
                        options={(capabilities.data?.data.capabilities.projects ?? []).map(
                          (project) => ({
                            value: project.key,
                            label: `${project.name} · ${project.key}${project.archived ? ' · 已归档' : ''}`,
                            disabled: project.archived,
                          }),
                        )}
                      />
                    </Form.Item>
                  ),
                },
                {
                  title: '现有任务',
                  dataIndex: 'taskCount',
                  width: 100,
                },
              ]}
            />
            <Typography.Title level={4}>原始状态映射</Typography.Title>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={statuses}
              columns={[
                {
                  title: '原状态',
                  render: (_, row) => (
                    <>
                      <Typography.Text strong>{row.name}</Typography.Text>
                      <br />
                      <Typography.Text type="secondary">{row.id}</Typography.Text>
                    </>
                  ),
                },
                {
                  title: '分类',
                  render: (_, row) => <Tag>{row.categoryName ?? row.categoryKey ?? '无分类'}</Tag>,
                },
                {
                  title: '统一状态',
                  render: (_, row) => (
                    <Form.Item
                      name={['statusMappings', row.id]}
                      rules={[{ required: true }]}
                      style={{ margin: 0 }}
                    >
                      <Select options={normalizedStatuses} style={{ minWidth: 200 }} />
                    </Form.Item>
                  ),
                },
              ]}
            />
            <Button
              type="primary"
              htmlType="submit"
              loading={save.isPending}
              style={{ marginTop: 16 }}
            >
              校验样例并创建映射版本
            </Button>
          </Form>
        )}
      </Space>
    </Modal>
  );
}

function findField(fields: JiraCapabilityField[], names: string[]): string | undefined {
  return fields.find((field) => names.some((name) => field.name.toLocaleLowerCase().includes(name)))
    ?.id;
}

function categoryDefault(category: string | null): string {
  if (category === 'new') return 'planned';
  if (category === 'indeterminate') return 'in_progress';
  if (category === 'done') return 'done';
  return 'other';
}
