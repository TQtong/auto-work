import { KeyOutlined, PlusOutlined, SafetyOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect, useState } from 'react';
import {
  weeklyReportWarningRuleCatalog,
  type WeeklyReportWarningRuleCode,
} from '@auto-work/contracts';
import { apiRequest } from '../api/client.js';
import type {
  GitLabProjectCache,
  IdentityAlias,
  Integration,
  UserProfile,
  WeeklyReportReminderClock,
  WeeklyReportReminderPolicy,
} from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';
import { AiProviderSettings } from './AiProviderSettings.js';

interface IntegrationFormValues {
  type: Integration['type'];
  name: string;
  baseUrl?: string;
  token?: string;
  appSecret?: string;
  accessToken?: string;
  webhook?: string;
  secret?: string;
  apiKey?: string;
  appKey?: string;
  corpId?: string;
  operatorUserId?: string;
  templateName?: string;
  organizationName?: string;
  recipientGroupName?: string;
  desktopExecutablePath?: string;
  desktopTimeoutSeconds?: number;
  robotName?: string;
  groupId?: string;
  robotQuietWindowMinutes?: number;
  severeRiskCodes?: WeeklyReportWarningRuleCode[];
  protocol?: 'openai_compatible' | 'anthropic' | 'gemini';
  model?: string;
  aiTimeoutMs?: number;
  aiMaxInputTokens?: number;
  aiMaxOutputTokens?: number;
  aiTemperaturePolicy?: 'deterministic' | 'provider_default';
  aiTemperature?: number;
  aiAllowedPurposes?: Array<
    'weekly_report' | 'evidence_suggestion' | 'quarterly_review' | 'score_suggestion'
  >;
  accountName?: string;
  authScheme?: 'bearer' | 'basic_pat';
  gitlabProjectRefs?: string;
  gitlabHistoryDays?: number;
}

interface ReminderPolicyFormValues {
  enabled: boolean;
  robotConnectionId: string | null;
  timezone: 'Asia/Shanghai';
  workingWeekdays: number[];
  generation: WeeklyReportReminderClock;
  confirmation: WeeklyReportReminderClock;
  deadline: WeeklyReportReminderClock;
  graceMinutes: number;
}

export function SettingsPage() {
  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={2}>设置与集成</Typography.Title>
        <Typography.Text type="secondary">
          秘密值仅在提交瞬间进入本机 DPAPI 保险箱，页面和数据库不会回显明文。
        </Typography.Text>
      </div>
      <Tabs
        items={[
          { key: 'profile', label: '个人身份与别名', children: <ProfileSettings /> },
          { key: 'reminders', label: '周报提醒', children: <ReminderPolicySettings /> },
          { key: 'ai-providers', label: '模型供应商', children: <AiProviderSettings /> },
          { key: 'integrations', label: '外部集成', children: <IntegrationSettings /> },
        ]}
      />
    </Space>
  );
}

function ProfileSettings() {
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const [aliasForm] = Form.useForm();
  const [aliasOpen, setAliasOpen] = useState(false);
  const [messageApi, holder] = message.useMessage();
  const profile = useQuery({
    queryKey: ['profile'],
    queryFn: () => apiRequest<UserProfile>('/api/v1/settings/profile'),
  });
  useEffect(() => {
    if (profile.data?.data) form.setFieldsValue(profile.data.data);
  }, [form, profile.data]);

  const saveProfile = useMutation({
    mutationFn: (values: Pick<UserProfile, 'displayName' | 'timezone' | 'workdayHours'>) =>
      apiRequest<UserProfile>('/api/v1/settings/profile', {
        method: 'PUT',
        body: JSON.stringify({ ...values, version: profile.data?.data.version }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
      void messageApi.success('个人设置已保存');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });
  const addAlias = useMutation({
    mutationFn: (values: { aliasType: string; value: string; enabled: boolean }) =>
      apiRequest<IdentityAlias>('/api/v1/settings/profile/aliases', {
        method: 'POST',
        body: JSON.stringify({ ...values, source: 'user' }),
      }),
    onSuccess: async () => {
      setAliasOpen(false);
      aliasForm.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
      void messageApi.success('身份别名已添加');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });
  const toggleAlias = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiRequest<IdentityAlias>(`/api/v1/settings/profile/aliases/${id}/state`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['profile'] }),
    onError: (error: Error) => void messageApi.error(error.message),
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {holder}
      <Card title="本机用户设置" loading={profile.isLoading}>
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: Pick<UserProfile, 'displayName' | 'timezone' | 'workdayHours'>) =>
            saveProfile.mutate(values)
          }
        >
          <div className="form-grid">
            <Form.Item name="displayName" label="显示名称" rules={[{ required: true }]}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="timezone" label="业务时区" rules={[{ required: true }]}>
              <Input placeholder="Asia/Shanghai" />
            </Form.Item>
            <Form.Item name="workdayHours" label="每人日小时数" rules={[{ required: true }]}>
              <InputNumber min={1} max={24} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <Button type="primary" htmlType="submit" loading={saveProfile.isPending}>
            保存设置
          </Button>
        </Form>
      </Card>
      <Card
        title="身份别名"
        extra={
          <Button icon={<PlusOutlined />} onClick={() => setAliasOpen(true)}>
            添加别名
          </Button>
        }
      >
        <Alert
          type="info"
          showIcon
          message="只有已验证并启用的别名才参与 Git/Jira 归属和证据匹配。"
          style={{ marginBottom: 16 }}
        />
        <Table
          rowKey="id"
          dataSource={profile.data?.data.aliases ?? []}
          pagination={false}
          columns={[
            { title: '类型', dataIndex: 'aliasType' },
            { title: '值', dataIndex: 'value' },
            { title: '来源', dataIndex: 'source', render: (value: string) => <Tag>{value}</Tag> },
            {
              title: '验证时间',
              dataIndex: 'verifiedAt',
              render: (value: string | null) =>
                value ? new Date(value).toLocaleString() : '未验证',
            },
            {
              title: '参与匹配',
              dataIndex: 'enabled',
              render: (enabled: boolean, row: IdentityAlias) => (
                <Switch
                  checked={enabled}
                  loading={toggleAlias.isPending}
                  onChange={(checked) => toggleAlias.mutate({ id: row.id, enabled: checked })}
                />
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title="添加身份别名"
        open={aliasOpen}
        onCancel={() => setAliasOpen(false)}
        onOk={() => aliasForm.submit()}
        confirmLoading={addAlias.isPending}
        destroyOnHidden
      >
        <Form
          form={aliasForm}
          layout="vertical"
          onFinish={(values: { aliasType: string; value: string; enabled: boolean }) =>
            addAlias.mutate(values)
          }
          initialValues={{ enabled: false }}
        >
          <Form.Item name="aliasType" label="别名类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'git_name', label: 'Git 作者名称' },
                { value: 'git_email', label: 'Git 作者邮箱' },
                { value: 'gitlab_user_id', label: 'GitLab 用户 ID' },
                { value: 'gitlab_username', label: 'GitLab 用户名' },
                { value: 'jira_account_id', label: 'Jira Account ID' },
                { value: 'jira_username', label: 'Jira 用户名' },
              ]}
            />
          </Form.Item>
          <Form.Item name="value" label="别名值" rules={[{ required: true }]}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="enabled" label="立即参与匹配" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

function ReminderPolicySettings() {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ReminderPolicyFormValues>();
  const [messageApi, holder] = message.useMessage();
  const policy = useQuery({
    queryKey: ['weekly-report-reminder-policy'],
    queryFn: () => apiRequest<WeeklyReportReminderPolicy>('/api/v1/weekly-reports/reminder-policy'),
  });
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiRequest<Integration[]>('/api/v1/integrations'),
  });
  useEffect(() => {
    if (policy.data?.data) form.setFieldsValue(policy.data.data);
  }, [form, policy.data]);
  const save = useMutation({
    mutationFn: (values: ReminderPolicyFormValues) =>
      apiRequest<WeeklyReportReminderPolicy>('/api/v1/weekly-reports/reminder-policy', {
        method: 'PUT',
        body: JSON.stringify({ ...values, version: policy.data?.data.version ?? 0 }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['weekly-report-reminder-policy'] });
      void messageApi.success('周报提醒策略已保存；保存本身不会发送消息');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });
  const healthyRobots = (integrations.data?.data ?? []).filter(
    (item) =>
      item.type === 'dingtalk_robot' &&
      item.enabled &&
      item.status === 'healthy' &&
      !item.credentialReplacementPending,
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {holder}
      <Alert
        type="info"
        showIcon
        message="提醒只通过已测试健康的加签机器人发送"
        description="生成、确认和截止提醒按 Asia/Shanghai 计算；保存策略不会发消息，也不会自动生成、确认或正式提交周报。应用休眠后的宽限补发将在调度账本中单独留痕。"
      />
      <Card title="工作周与三阶段提醒" loading={policy.isLoading || integrations.isLoading}>
        <Form<ReminderPolicyFormValues>
          form={form}
          layout="vertical"
          onFinish={(values) => save.mutate(values)}
        >
          <div className="form-grid">
            <Form.Item name="enabled" label="启用提醒策略" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item
              name="robotConnectionId"
              label="提醒机器人"
              dependencies={['enabled']}
              rules={[
                ({ getFieldValue }) => ({
                  validator: (_rule, value: unknown) =>
                    getFieldValue('enabled') && !value
                      ? Promise.reject(new Error('启用提醒必须选择健康机器人'))
                      : Promise.resolve(),
                }),
              ]}
            >
              <Select
                allowClear
                placeholder="选择已测试健康的机器人"
                options={healthyRobots.map((item) => ({ value: item.id, label: item.name }))}
              />
            </Form.Item>
            <Form.Item name="timezone" label="固定业务时区">
              <Input disabled />
            </Form.Item>
            <Form.Item
              name="workingWeekdays"
              label="工作星期"
              rules={[{ required: true, message: '至少选择一个工作日' }]}
            >
              <Select mode="multiple" options={weekdayOptions} />
            </Form.Item>
            <Form.Item
              name="graceMinutes"
              label="休眠恢复宽限（分钟）"
              rules={[{ required: true }]}
              extra="恢复时仍在宽限内只补发一次；超出后记录 skipped。"
            >
              <InputNumber min={0} max={1440} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <div className="form-grid">
            <ReminderClockFields prefix="generation" label="生成提醒" />
            <ReminderClockFields prefix="confirmation" label="确认提醒" />
            <ReminderClockFields prefix="deadline" label="截止提醒" />
          </div>
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            保存提醒策略
          </Button>
        </Form>
      </Card>
      <Card title="未来计划预览">
        <Table
          rowKey={(row) => `${row.cycleKey}:${row.reminderType}`}
          dataSource={policy.data?.data.upcoming ?? []}
          pagination={false}
          locale={{ emptyText: '当前配置没有未来提醒时刻' }}
          columns={[
            {
              title: '类型',
              dataIndex: 'reminderType',
              render: (value: WeeklyReportReminderPolicy['upcoming'][number]['reminderType']) =>
                reminderTypeLabels[value],
            },
            {
              title: '周期',
              render: (_value: unknown, row: WeeklyReportReminderPolicy['upcoming'][number]) =>
                `${row.periodStart} 至 ${row.periodEnd}`,
            },
            {
              title: '计划时间',
              dataIndex: 'scheduledFor',
              render: (value: string) => new Date(value).toLocaleString('zh-CN'),
            },
            {
              title: '补发截止',
              dataIndex: 'graceUntil',
              render: (value: string) => new Date(value).toLocaleString('zh-CN'),
            },
          ]}
        />
      </Card>
      <Card title="提醒运行记录">
        <Table
          rowKey="id"
          dataSource={policy.data?.data.recentOccurrences ?? []}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: '策略启用并由调度器建立计划后显示运行记录' }}
          columns={[
            {
              title: '类型',
              dataIndex: 'reminderType',
              render: (value: WeeklyReportReminderPolicy['upcoming'][number]['reminderType']) =>
                reminderTypeLabels[value],
            },
            { title: '策略版本', dataIndex: 'policyVersion', width: 100 },
            {
              title: '周期',
              render: (
                _value: unknown,
                row: WeeklyReportReminderPolicy['recentOccurrences'][number],
              ) => `${row.periodStart} 至 ${row.periodEnd}`,
            },
            {
              title: '计划时间',
              dataIndex: 'scheduledFor',
              render: (value: string) => new Date(value).toLocaleString('zh-CN'),
            },
            {
              title: '状态',
              dataIndex: 'status',
              render: (value: string) => <StatusTag status={value} />,
            },
            {
              title: '跳过/错误',
              render: (
                _value: unknown,
                row: WeeklyReportReminderPolicy['recentOccurrences'][number],
              ) => row.skipReason ?? row.lastErrorCode ?? '—',
            },
          ]}
        />
      </Card>
    </Space>
  );
}

function ReminderClockFields({
  prefix,
  label,
}: {
  prefix: 'generation' | 'confirmation' | 'deadline';
  label: string;
}) {
  return (
    <Card size="small" title={label}>
      <Form.Item name={[prefix, 'enabled']} label="启用" valuePropName="checked">
        <Switch />
      </Form.Item>
      <Form.Item name={[prefix, 'weekday']} label="星期" rules={[{ required: true }]}>
        <Select options={weekdayOptions} />
      </Form.Item>
      <Form.Item
        name={[prefix, 'time']}
        label="时刻"
        rules={[
          { required: true },
          { pattern: /^(?:[01]\d|2[0-3]):[0-5]\d$/u, message: '请输入 HH:mm' },
        ]}
      >
        <Input placeholder="17:30" maxLength={5} />
      </Form.Item>
    </Card>
  );
}

const weekdayOptions = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

const reminderTypeLabels = {
  generation_reminder: '生成提醒',
  confirmation_reminder: '确认提醒',
  deadline_reminder: '截止提醒',
} satisfies Record<WeeklyReportReminderPolicy['upcoming'][number]['reminderType'], string>;

function IntegrationSettings() {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<IntegrationFormValues>();
  const [robotRiskForm] = Form.useForm<{
    quietWindowMinutes: number;
    severeRiskCodes: WeeklyReportWarningRuleCode[];
  }>();
  const selectedType = Form.useWatch('type', form);
  const [open, setOpen] = useState(false);
  const [cacheConnection, setCacheConnection] = useState<Integration | null>(null);
  const [robotRiskConnection, setRobotRiskConnection] = useState<Integration | null>(null);
  const [messageApi, holder] = message.useMessage();
  useEffect(() => {
    form.setFieldValue(
      'baseUrl',
      selectedType === 'dingtalk_log' ? 'https://oapi.dingtalk.com' : undefined,
    );
  }, [form, selectedType]);
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiRequest<Integration[]>('/api/v1/integrations'),
  });
  const gitlabProjects = useQuery({
    queryKey: ['gitlab-projects', cacheConnection?.id],
    queryFn: () => {
      if (!cacheConnection) throw new Error('未选择 GitLab 连接');
      return apiRequest<GitLabProjectCache[]>(
        `/api/v1/integrations/${cacheConnection.id}/gitlab/projects`,
      );
    },
    enabled: Boolean(cacheConnection),
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['integrations'] });
    await queryClient.invalidateQueries({ queryKey: ['gitlab-projects'] });
  };
  const create = useMutation({
    mutationFn: (values: IntegrationFormValues) =>
      apiRequest<Integration>('/api/v1/integrations', {
        method: 'POST',
        body: JSON.stringify(toIntegrationPayload(values)),
      }),
    onSuccess: async () => {
      setOpen(false);
      form.resetFields();
      await refresh();
      void messageApi.success('连接已创建，请执行能力测试');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });
  const saveRobotRiskRules = useMutation({
    mutationFn: (values: {
      quietWindowMinutes: number;
      severeRiskCodes: WeeklyReportWarningRuleCode[];
    }) => {
      if (!robotRiskConnection) throw new Error('尚未选择机器人连接');
      return apiRequest<Integration>(`/api/v1/integrations/${robotRiskConnection.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          version: robotRiskConnection.version,
          // 更新非秘密风险策略时保留机器人名称和群标识，不触碰保险箱凭证。
          config: {
            ...robotRiskConnection.config,
            quietWindowMinutes: values.quietWindowMinutes,
            severeRiskCodes: values.severeRiskCodes,
          },
        }),
      });
    },
    onSuccess: async () => {
      setRobotRiskConnection(null);
      await refresh();
      void messageApi.success('机器人严重风险规则与静默窗口已保存');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });
  const action = useMutation({
    mutationFn: ({
      row,
      kind,
    }: {
      row: Integration;
      kind: 'test' | 'sync' | 'disable' | 'revoke';
    }) => {
      if (kind === 'test')
        return row.type === 'dingtalk_robot'
          ? apiRequest(`/api/v1/integrations/${row.id}/dingtalk-robot/test`, {
              method: 'POST',
              headers: { 'Idempotency-Key': crypto.randomUUID() },
              // Popconfirm 只负责交互提示；服务端仍要求不可省略的显式确认字段。
              body: JSON.stringify({ confirmSendTestMessage: true }),
            })
          : apiRequest(`/api/v1/integrations/${row.id}/test`, { method: 'POST' });
      if (kind === 'sync')
        return apiRequest(`/api/v1/integrations/${row.id}/gitlab/sync`, {
          method: 'POST',
          body: '{}',
        });
      if (kind === 'disable')
        return apiRequest(`/api/v1/integrations/${row.id}/disable`, {
          method: 'POST',
          body: JSON.stringify({ version: row.version }),
        });
      return apiRequest(`/api/v1/integrations/${row.id}/credential`, {
        method: 'DELETE',
        body: JSON.stringify({ version: row.version }),
      });
    },
    onSuccess: async () => {
      await refresh();
      void messageApi.success('操作已受理');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  return (
    <Card
      title="外部连接"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          新建连接
        </Button>
      }
    >
      {holder}
      <Alert
        type="warning"
        showIcon
        icon={<SafetyOutlined />}
        message="凭证不会回显"
        description="普通连接替换凭证时会先测试再切换。钉钉机器人因测试会真实向群里发送固定消息，保存后只进入待测试状态，必须显式确认测试成功才会替换旧凭证；撤销本地凭证不等于外部平台吊销。"
        style={{ marginBottom: 16 }}
      />
      <Table
        rowKey="id"
        loading={integrations.isLoading}
        dataSource={(integrations.data?.data ?? []).filter((item) => item.type !== 'ai')}
        expandable={{
          expandedRowRender: (row: Integration) => (
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="类型">{row.type}</Descriptions.Item>
              <Descriptions.Item label="版本">{row.version}</Descriptions.Item>
              <Descriptions.Item label="上次成功">
                {row.lastSuccessAt ? new Date(row.lastSuccessAt).toLocaleString('zh-CN') : '从未'}
              </Descriptions.Item>
              <Descriptions.Item label="启用状态">
                {row.enabled ? '已启用' : '已禁用'}
              </Descriptions.Item>
              <Descriptions.Item label="非秘密配置" span={2}>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {JSON.stringify(row.config, null, 2)}
                </pre>
              </Descriptions.Item>
              <Descriptions.Item label="能力矩阵" span={2}>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {JSON.stringify(row.capabilities, null, 2)}
                </pre>
              </Descriptions.Item>
            </Descriptions>
          ),
        }}
        columns={[
          {
            title: '连接',
            dataIndex: 'name',
            render: (value: string, row: Integration) => (
              <div>
                <Typography.Text strong>{value}</Typography.Text>
                <br />
                <Typography.Text type="secondary">{row.baseUrl ?? row.type}</Typography.Text>
              </div>
            ),
          },
          {
            title: '状态',
            dataIndex: 'status',
            render: (value: string, row: Integration) => (
              <Space direction="vertical" size={2}>
                <StatusTag status={value} />
                {row.credentialReplacementPending && <Tag color="gold">新凭证待显式测试</Tag>}
              </Space>
            ),
          },
          {
            title: '凭证',
            dataIndex: 'credentialMask',
            render: (value: Record<string, string> | null, row: Integration) => (
              <Space direction="vertical" size={2}>
                <Typography.Text>
                  {row.type === 'dingtalk_desktop'
                    ? '无需凭证，使用当前 Windows 登录会话'
                    : value
                      ? Object.values(value).join(' / ')
                      : '当前凭证未配置'}
                </Typography.Text>
                {row.credentialReplacementPending && (
                  <Typography.Text type="warning">待测试凭证已安全保存</Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: '上次测试',
            dataIndex: 'lastTestedAt',
            render: (value: string | null) => (value ? new Date(value).toLocaleString() : '从未'),
          },
          {
            title: '操作',
            render: (_: unknown, row: Integration) => (
              <Space wrap>
                {row.type === 'dingtalk_robot' ? (
                  <Popconfirm
                    title="确认向目标钉钉群发送固定连接测试消息？"
                    description="测试消息不包含周报正文、凭证或本机链接；成功后待测试凭证才会正式启用。"
                    onConfirm={() => action.mutate({ row, kind: 'test' })}
                  >
                    <Button
                      size="small"
                      disabled={
                        !row.enabled || (!row.credentialMask && !row.credentialReplacementPending)
                      }
                    >
                      {row.credentialReplacementPending ? '测试并启用新凭证' : '发送固定测试消息'}
                    </Button>
                  </Popconfirm>
                ) : row.type !== 'jira' ? (
                  <Button
                    size="small"
                    onClick={() => action.mutate({ row, kind: 'test' })}
                    disabled={!row.enabled}
                  >
                    测试
                  </Button>
                ) : (
                  <Typography.Text type="secondary">
                    每天 06:00 自动只读同步；可在任务页手动刷新
                  </Typography.Text>
                )}
                {row.type === 'gitlab' && (
                  <>
                    <Button
                      size="small"
                      onClick={() => action.mutate({ row, kind: 'sync' })}
                      disabled={
                        !row.enabled ||
                        !row.credentialMask ||
                        !['healthy', 'degraded'].includes(row.status)
                      }
                    >
                      同步只读元数据
                    </Button>
                    <Button size="small" onClick={() => setCacheConnection(row)}>
                      查看项目缓存
                    </Button>
                  </>
                )}
                {row.type === 'dingtalk_robot' && (
                  <Button
                    size="small"
                    onClick={() => {
                      setRobotRiskConnection(row);
                      robotRiskForm.setFieldsValue({
                        quietWindowMinutes: robotQuietWindowMinutes(row.config),
                        severeRiskCodes: robotSevereRiskCodes(row.config),
                      });
                    }}
                  >
                    严重风险规则
                  </Button>
                )}
                {row.type !== 'jira' && (
                  <>
                    <Popconfirm
                      title="禁用后定时同步和外部调用都会停止，历史记录仍保留。"
                      onConfirm={() => action.mutate({ row, kind: 'disable' })}
                    >
                      <Button size="small" disabled={!row.enabled}>
                        禁用
                      </Button>
                    </Popconfirm>
                    <Popconfirm
                      title="确认删除本机保险箱中的凭证？外部平台 Token 仍需在平台侧另行吊销。"
                      onConfirm={() => action.mutate({ row, kind: 'revoke' })}
                    >
                      <Button
                        size="small"
                        danger
                        disabled={!row.credentialMask && !row.credentialReplacementPending}
                      >
                        撤销凭证
                      </Button>
                    </Popconfirm>
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={`${cacheConnection?.name ?? 'GitLab'} · 只读项目缓存`}
        width={1000}
        open={Boolean(cacheConnection)}
        onCancel={() => setCacheConnection(null)}
        footer={null}
      >
        <Alert
          type="info"
          showIcon
          message="这里展示最后一次完整同步缓存；不会在打开弹窗时阻塞调用 GitLab。"
          style={{ marginBottom: 16 }}
        />
        <Table<GitLabProjectCache>
          rowKey="id"
          loading={gitlabProjects.isLoading}
          dataSource={gitlabProjects.data?.data ?? []}
          pagination={{ pageSize: 10 }}
          columns={[
            {
              title: '项目',
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Link href={row.webUrl} target="_blank">
                    {row.pathWithNamespace}
                  </Typography.Link>
                  <Typography.Text type="secondary">
                    #{row.externalId} · {row.visibility} · 默认 {row.defaultBranch ?? '未返回'}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '缓存资源',
              render: (_, row) => (
                <Typography.Text>
                  分支 {row.counts.branches} / 提交 {row.counts.commits} / MR{' '}
                  {row.counts.mergeRequests} / Pipeline {row.counts.pipelines} / Tag{' '}
                  {row.counts.tags} / Release {row.counts.releases} / 成员 {row.counts.members}
                </Typography.Text>
              ),
            },
            {
              title: '状态',
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <StatusTag status={row.syncStatus} />
                  {row.latestPipeline && <StatusTag status={row.latestPipeline.status} />}
                  <Typography.Text type="secondary">
                    {row.syncedAt ? new Date(row.syncedAt).toLocaleString('zh-CN') : '无成功快照'}
                  </Typography.Text>
                </Space>
              ),
            },
          ]}
        />
      </Modal>
      <Modal
        title={`${robotRiskConnection?.name ?? '机器人'} · 严重风险规则`}
        width={720}
        open={Boolean(robotRiskConnection)}
        onCancel={() => setRobotRiskConnection(null)}
        onOk={() => robotRiskForm.submit()}
        confirmLoading={saveRobotRiskRules.isPending}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          message="风险通知默认关闭，只有这里显式启用的规则才允许发送"
          description="保存配置不会立即发消息。周报工作台仍需人工选择当前版本中的具体 warning 并确认；每次最多三项，完整周报与附件永不进入机器人正文。"
          style={{ marginBottom: 16 }}
        />
        <Form
          form={robotRiskForm}
          layout="vertical"
          onFinish={(values) => saveRobotRiskRules.mutate(values)}
        >
          <Form.Item name="severeRiskCodes" label="允许作为严重风险通知的规则">
            <Checkbox.Group
              options={weeklyReportWarningRuleCatalog.map((rule) => ({
                value: rule.code,
                label: `${rule.label}（${rule.code}）— ${rule.description}`,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="quietWindowMinutes"
            label="相同正文静默合并窗口（分钟）"
            extra="0 表示不按正文静默合并；状态版本去重始终生效。最大 1440 分钟。"
            rules={[{ required: true }]}
          >
            <InputNumber min={0} max={1_440} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="新建外部连接"
        width={680}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            type: 'gitlab',
            authScheme: 'bearer',
            protocol: 'openai_compatible',
            aiTimeoutMs: 180_000,
            aiMaxInputTokens: 32_000,
            aiMaxOutputTokens: 4_096,
            aiTemperaturePolicy: 'deterministic',
            aiTemperature: 0,
            aiAllowedPurposes: ['weekly_report'],
            templateName: 'uTwin产研创新部周报',
            desktopTimeoutSeconds: 45,
            gitlabHistoryDays: 120,
            robotQuietWindowMinutes: 30,
            severeRiskCodes: [],
          }}
          onFinish={(values) => create.mutate(values)}
        >
          <div className="form-grid">
            <Form.Item name="type" label="连接类型" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'gitlab', label: 'GitLab' },
                  { value: 'jira', label: 'Jira' },
                  { value: 'dingtalk_log', label: '钉钉正式日志' },
                  { value: 'dingtalk_desktop', label: '钉钉桌面正式日志（无需接口权限）' },
                  { value: 'dingtalk_robot', label: '钉钉加签机器人' },
                ]}
              />
            </Form.Item>
            <Form.Item name="name" label="连接名称" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </div>
          {!['dingtalk_robot', 'dingtalk_desktop'].includes(selectedType ?? '') && (
            <Form.Item
              name="baseUrl"
              label="HTTPS 基础地址"
              rules={[{ required: true }, { type: 'url' }]}
              extra={
                selectedType === 'dingtalk_log'
                  ? '正式日志适配器固定使用钉钉官方 oapi 主机，不接受自定义路径、查询参数或代理地址。'
                  : undefined
              }
            >
              <Input placeholder="https://..." disabled={selectedType === 'dingtalk_log'} />
            </Form.Item>
          )}
          <IntegrationFields type={selectedType ?? 'gitlab'} />
          {selectedType !== 'dingtalk_desktop' && (
            <>
              <Divider titlePlacement="start">
                <KeyOutlined /> 一次性凭证输入
              </Divider>
              <CredentialFields type={selectedType ?? 'gitlab'} />
            </>
          )}
        </Form>
      </Modal>
    </Card>
  );
}

function IntegrationFields({ type }: { type: Integration['type'] }) {
  if (type === 'gitlab')
    return (
      <>
        <Form.Item
          name="gitlabProjectRefs"
          label="项目 ID 或完整 namespace/project（每行一个）"
          extra="留空时仍会按已确认仓库的同主机、端口和 remote 路径匹配；仅接受搜索结果中的完整路径精确匹配。"
        >
          <Input.TextArea rows={4} placeholder={'123\ngroup/team/project'} />
        </Form.Item>
        <Form.Item
          name="gitlabHistoryDays"
          label="首次同步历史窗口（天）"
          extra="Commit、MR 和 Pipeline 首次读取该窗口；后续按成功水位重叠增量同步。"
          rules={[{ required: true }]}
        >
          <InputNumber min={1} max={730} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </>
    );
  if (type === 'jira')
    return (
      <div className="form-grid">
        <Form.Item name="authScheme" label="认证方式">
          <Select
            options={[
              { value: 'bearer', label: 'Bearer PAT' },
              { value: 'basic_pat', label: '用户名 + PAT' },
            ]}
          />
        </Form.Item>
        <Form.Item name="accountName" label="账号名（Basic PAT 时）">
          <Input />
        </Form.Item>
      </div>
    );
  if (type === 'dingtalk_log')
    return (
      <>
        <div className="form-grid">
          <Form.Item name="appKey" label="App Key" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="corpId" label="Corp ID" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </div>
        <Form.Item name="templateName" label="周报模板名称">
          <Input />
        </Form.Item>
        <Form.Item
          name="operatorUserId"
          label="日志操作用户 User ID"
          rules={[{ required: true }]}
          extra="该用户必须在应用可见范围内，并有权读取目标日志模板与创建日志。"
        >
          <Input />
        </Form.Item>
      </>
    );
  if (type === 'dingtalk_desktop')
    return (
      <>
        <Alert
          type="info"
          showIcon
          message="无需申请钉钉接口权限"
          description="系统使用当前 Windows 用户已登录的钉钉桌面客户端，进入公司工作台的正式日志模板并填写、提交。测试连接时请保持电脑解锁并允许钉钉窗口置前；测试不会提交内容，但钉钉可能留下一个空白周报草稿。"
          style={{ marginBottom: 16 }}
        />
        <div className="form-grid">
          <Form.Item
            name="organizationName"
            label="钉钉客户端组织名称"
            rules={[{ required: true }]}
            extra="填写钉钉客户端左侧组织切换按钮显示的名称；不要填写管理后台个人组织名或日志页水印公司名。"
          >
            <Input placeholder="例如：八维通科技有限公司" />
          </Form.Item>
          <Form.Item name="templateName" label="周报模板名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="recipientGroupName"
            label="默认接收群"
            rules={[{ required: true }]}
            extra="提交前必须在日志表单中识别到该群，否则自动停止。"
          >
            <Input placeholder="例如：uTwin产研创新部" />
          </Form.Item>
          <Form.Item
            name="desktopTimeoutSeconds"
            label="单步等待上限（秒）"
            rules={[{ required: true }]}
          >
            <InputNumber min={5} max={180} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <Form.Item
          name="desktopExecutablePath"
          label="钉钉客户端路径（可选）"
          extra="留空会从常见安装位置自动发现。"
        >
          <Input placeholder="C:\Users\...\DingTalk.exe" />
        </Form.Item>
        <Alert
          type="warning"
          showIcon
          message="桌面自动化运行条件"
          description="预约时间到达时电脑必须开机、已解锁且钉钉保持登录。自动填写会临时使用剪贴板，并在结束后清空。页面结构变化、验证码或登录失效都会停止执行并要求人工核对，系统不会盲目重复提交。"
        />
      </>
    );
  if (type === 'dingtalk_robot')
    return (
      <>
        <Alert
          type="warning"
          showIcon
          message="保存不会自动向群里发送消息"
          description="Webhook 和 Secret 会先进入待测试状态。只有你在连接列表显式确认发送固定、无敏感信息的测试消息且钉钉返回成功后，新凭证才会生效。"
          style={{ marginBottom: 16 }}
        />
        <div className="form-grid">
          <Form.Item name="robotName" label="机器人名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="groupId" label="群稳定标识" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </div>
        <Form.Item
          name="severeRiskCodes"
          label="严重风险规则（默认关闭）"
          extra="只有选中的规则才会在周报工作台成为可发送风险；发送前仍需人工选择具体 warning。"
        >
          <Select
            mode="multiple"
            allowClear
            options={weeklyReportWarningRuleCatalog.map((rule) => ({
              value: rule.code,
              label: `${rule.label}（${rule.code}）`,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="robotQuietWindowMinutes"
          label="相同通知静默窗口（分钟）"
          rules={[{ required: true }]}
        >
          <InputNumber min={0} max={1_440} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </>
    );
  if (type === 'ai')
    return (
      <>
        <Alert
          type="info"
          showIcon
          message="AI 仅接收白名单元数据"
          description="连接测试会真实调用所选模型验证结构化输出；系统不会向模型提供工具、源码、diff、附件或任何本机文件读取能力。"
          style={{ marginBottom: 16 }}
        />
        <div className="form-grid">
          <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'openai_compatible', label: 'OpenAI-compatible' },
                { value: 'anthropic', label: 'Anthropic' },
                { value: 'gemini', label: 'Gemini' },
              ]}
            />
          </Form.Item>
          <Form.Item name="model" label="模型" rules={[{ required: true }]}>
            <Input placeholder="必须是连接测试可实际调用的模型名称" />
          </Form.Item>
          <Form.Item name="aiTimeoutMs" label="请求超时（毫秒）" rules={[{ required: true }]}>
            <InputNumber min={1_000} max={300_000} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="aiMaxInputTokens" label="最大输入 Token" rules={[{ required: true }]}>
            <InputNumber min={256} max={1_000_000} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="aiMaxOutputTokens" label="最大输出 Token" rules={[{ required: true }]}>
            <InputNumber min={128} max={100_000} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="aiTemperaturePolicy" label="温度策略" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'deterministic', label: '固定温度（推荐）' },
                { value: 'provider_default', label: '供应商默认' },
              ]}
            />
          </Form.Item>
          <Form.Item name="aiTemperature" label="固定温度" rules={[{ required: true }]}>
            <InputNumber min={0} max={1} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <Form.Item
          name="aiAllowedPurposes"
          label="允许用途"
          rules={[{ required: true, message: '至少选择一个允许用途' }]}
        >
          <Checkbox.Group
            options={[
              { value: 'weekly_report', label: '周报表述' },
              { value: 'evidence_suggestion', label: '证据建议' },
              { value: 'quarterly_review', label: '季度自评' },
              { value: 'score_suggestion', label: '分数建议' },
            ]}
          />
        </Form.Item>
      </>
    );
  return null;
}

function CredentialFields({ type }: { type: Integration['type'] }) {
  if (type === 'gitlab' || type === 'jira')
    return (
      <Form.Item name="token" label="Personal Access Token" rules={[{ required: true }]}>
        <Input.Password autoComplete="new-password" />
      </Form.Item>
    );
  if (type === 'dingtalk_log')
    return (
      <>
        <Form.Item name="appSecret" label="App Secret" rules={[{ required: true }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="accessToken" label="Access Token（如接入方式需要）">
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </>
    );
  if (type === 'dingtalk_robot')
    return (
      <>
        <Form.Item name="webhook" label="Webhook" rules={[{ required: true }, { type: 'url' }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="secret" label="加签 Secret" rules={[{ required: true }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </>
    );
  return (
    <Form.Item name="apiKey" label="API Key" rules={[{ required: true }]}>
      <Input.Password autoComplete="new-password" />
    </Form.Item>
  );
}

export function toIntegrationPayload(values: IntegrationFormValues) {
  const common = {
    type: values.type,
    name: values.name,
    baseUrl: values.type === 'dingtalk_robot' ? undefined : values.baseUrl,
  };
  if (values.type === 'gitlab')
    return {
      ...common,
      config: {
        projectIds: [],
        projectRefs: (values.gitlabProjectRefs ?? '')
          .split(/\r?\n/u)
          .map((value) => value.trim())
          .filter(Boolean),
        historyDays: values.gitlabHistoryDays ?? 120,
      },
      credential: { token: values.token },
    };
  if (values.type === 'jira')
    return {
      ...common,
      config: {
        authScheme: values.authScheme,
        ...(values.authScheme === 'basic_pat' && values.accountName
          ? { accountName: values.accountName }
          : {}),
        maxResults: 100,
      },
      credential: { token: values.token },
    };
  if (values.type === 'dingtalk_log')
    return {
      ...common,
      config: {
        appKey: values.appKey,
        corpId: values.corpId,
        operatorUserId: values.operatorUserId,
        templateName: values.templateName,
      },
      credential: {
        appSecret: values.appSecret,
        ...(values.accessToken ? { accessToken: values.accessToken } : {}),
      },
    };
  if (values.type === 'dingtalk_desktop')
    return {
      ...common,
      baseUrl: undefined,
      config: {
        organizationName: values.organizationName,
        templateName: values.templateName,
        recipientGroupName: values.recipientGroupName,
        timeoutSeconds: values.desktopTimeoutSeconds ?? 45,
        ...(values.desktopExecutablePath ? { executablePath: values.desktopExecutablePath } : {}),
      },
    };
  if (values.type === 'dingtalk_robot')
    return {
      ...common,
      config: {
        robotName: values.robotName,
        groupId: values.groupId,
        quietWindowMinutes: values.robotQuietWindowMinutes ?? 30,
        severeRiskCodes: values.severeRiskCodes ?? [],
      },
      credential: { webhook: values.webhook, secret: values.secret },
    };
  return {
    ...common,
    config: {
      protocol: values.protocol,
      model: values.model,
      metadataOnly: true,
      timeoutMs: values.aiTimeoutMs ?? 180_000,
      maxInputTokens: values.aiMaxInputTokens ?? 32_000,
      maxOutputTokens: values.aiMaxOutputTokens ?? 4_096,
      temperaturePolicy: values.aiTemperaturePolicy ?? 'deterministic',
      temperature: values.aiTemperature ?? 0,
      allowedPurposes: values.aiAllowedPurposes ?? ['weekly_report'],
    },
    credential: { apiKey: values.apiKey },
  };
}

export function robotSevereRiskCodes(
  config: Record<string, unknown>,
): WeeklyReportWarningRuleCode[] {
  const allowed = new Set<string>(weeklyReportWarningRuleCatalog.map((rule) => rule.code));
  return Array.isArray(config.severeRiskCodes)
    ? [
        ...new Set(
          config.severeRiskCodes.filter(
            (code): code is WeeklyReportWarningRuleCode =>
              typeof code === 'string' && allowed.has(code),
          ),
        ),
      ]
    : [];
}

function robotQuietWindowMinutes(config: Record<string, unknown>): number {
  const value = config.quietWindowMinutes;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_440
    ? value
    : 30;
}
