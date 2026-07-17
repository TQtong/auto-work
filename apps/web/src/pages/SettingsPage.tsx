import { KeyOutlined, PlusOutlined, SafetyOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
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
import { apiRequest } from '../api/client.js';
import type { IdentityAlias, Integration, UserProfile } from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';

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
  templateName?: string;
  robotName?: string;
  groupId?: string;
  protocol?: 'openai_compatible' | 'anthropic' | 'gemini';
  model?: string;
  accountName?: string;
  authScheme?: 'bearer' | 'basic_pat';
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

function IntegrationSettings() {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<IntegrationFormValues>();
  const selectedType = Form.useWatch('type', form);
  const [open, setOpen] = useState(false);
  const [messageApi, holder] = message.useMessage();
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiRequest<Integration[]>('/api/v1/integrations'),
  });
  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['integrations'] });
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
  const action = useMutation({
    mutationFn: ({ row, kind }: { row: Integration; kind: 'test' | 'disable' | 'revoke' }) => {
      if (kind === 'test')
        return apiRequest(`/api/v1/integrations/${row.id}/test`, { method: 'POST' });
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
        description="替换凭证时系统先用新凭证通过能力测试，再切换引用并删除旧保险箱条目；撤销本地凭证不等于外部平台吊销。"
        style={{ marginBottom: 16 }}
      />
      <Table
        rowKey="id"
        loading={integrations.isLoading}
        dataSource={integrations.data?.data ?? []}
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
            render: (value: string) => <StatusTag status={value} />,
          },
          {
            title: '凭证',
            dataIndex: 'credentialMask',
            render: (value: Record<string, string> | null) =>
              value ? Object.values(value).join(' / ') : '未配置',
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
                <Button
                  size="small"
                  onClick={() => action.mutate({ row, kind: 'test' })}
                  disabled={!row.enabled}
                >
                  测试
                </Button>
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
                  <Button size="small" danger disabled={!row.credentialMask}>
                    撤销凭证
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
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
            templateName: 'uTwin产研创新部周报',
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
                  { value: 'dingtalk_robot', label: '钉钉加签机器人' },
                  { value: 'ai', label: '外部 AI' },
                ]}
              />
            </Form.Item>
            <Form.Item name="name" label="连接名称" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </div>
          {selectedType !== 'dingtalk_robot' && (
            <Form.Item
              name="baseUrl"
              label="HTTPS 基础地址"
              rules={[{ required: true }, { type: 'url' }]}
            >
              <Input placeholder="https://..." />
            </Form.Item>
          )}
          <IntegrationFields type={selectedType ?? 'gitlab'} />
          <Divider titlePlacement="start">
            <KeyOutlined /> 一次性凭证输入
          </Divider>
          <CredentialFields type={selectedType ?? 'gitlab'} />
        </Form>
      </Modal>
    </Card>
  );
}

function IntegrationFields({ type }: { type: Integration['type'] }) {
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
      </>
    );
  if (type === 'dingtalk_robot')
    return (
      <div className="form-grid">
        <Form.Item name="robotName" label="机器人名称" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="groupId" label="群稳定标识" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
      </div>
    );
  if (type === 'ai')
    return (
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
          <Input />
        </Form.Item>
      </div>
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

function toIntegrationPayload(values: IntegrationFormValues) {
  const common = {
    type: values.type,
    name: values.name,
    baseUrl: values.type === 'dingtalk_robot' ? undefined : values.baseUrl,
  };
  if (values.type === 'gitlab')
    return { ...common, config: { projectIds: [] }, credential: { token: values.token } };
  if (values.type === 'jira')
    return {
      ...common,
      config: { authScheme: values.authScheme, accountName: values.accountName, maxResults: 100 },
      credential: { token: values.token },
    };
  if (values.type === 'dingtalk_log')
    return {
      ...common,
      config: { appKey: values.appKey, corpId: values.corpId, templateName: values.templateName },
      credential: {
        appSecret: values.appSecret,
        ...(values.accessToken ? { accessToken: values.accessToken } : {}),
      },
    };
  if (values.type === 'dingtalk_robot')
    return {
      ...common,
      config: { robotName: values.robotName, groupId: values.groupId, quietWindowMinutes: 30 },
      credential: { webhook: values.webhook, secret: values.secret },
    };
  return {
    ...common,
    config: {
      protocol: values.protocol,
      model: values.model,
      metadataOnly: true,
      timeoutMs: 60_000,
      maxInputTokens: 32_000,
      maxOutputTokens: 4_096,
      allowedPurposes: [
        'weekly_report',
        'evidence_suggestion',
        'quarterly_review',
        'score_suggestion',
      ],
    },
    credential: { apiKey: values.apiKey },
  };
}
