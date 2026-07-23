import {
  ApiOutlined,
  KeyOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { useMemo, useState, type CSSProperties } from 'react';
import { apiRequest } from '../api/client.js';
import type { Integration } from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';
import {
  aiProviderById,
  aiProviderCatalog,
  aiProviderIdFromIntegration,
  defaultAiProviderValues,
  toAiProviderPayload,
  type AiProviderDefinition,
  type AiProviderFormValues,
} from './ai-provider-catalog.js';

const purposeOptions = [
  { value: 'weekly_report', label: '周报表述' },
  { value: 'evidence_suggestion', label: '证据建议' },
  { value: 'quarterly_review', label: '季度自评' },
  { value: 'score_suggestion', label: '分数建议' },
];

interface OperationReference {
  operationId: string;
  status: string;
  statusUrl: string;
}

interface OperationDetail {
  status: string;
  error?: { message: string };
}

export function AiProviderSettings() {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<AiProviderFormValues>();
  const selectedProtocol = Form.useWatch('protocol', form);
  const selectedTemperaturePolicy = Form.useWatch('temperaturePolicy', form);
  const [selectedProvider, setSelectedProvider] = useState<AiProviderDefinition | null>(null);
  const [messageApi, holder] = message.useMessage();
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiRequest<Integration[]>('/api/v1/integrations'),
    refetchInterval: 5_000,
  });
  const configuredProviders = useMemo(
    () => (integrations.data?.data ?? []).filter((item) => item.type === 'ai'),
    [integrations.data?.data],
  );

  const create = useMutation({
    mutationFn: (values: AiProviderFormValues) =>
      apiRequest<Integration>('/api/v1/integrations', {
        method: 'POST',
        body: JSON.stringify(toAiProviderPayload(values)),
      }),
    onSuccess: async () => {
      setSelectedProvider(null);
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
      void messageApi.success('模型供应商已添加，请执行连接测试');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const action = useMutation({
    mutationFn: async ({
      row,
      kind,
    }: {
      row: Integration;
      kind: 'test' | 'disable' | 'revoke';
    }) => {
      if (kind === 'test') {
        const operation = await apiRequest<OperationReference>(
          `/api/v1/integrations/${row.id}/test`,
          { method: 'POST' },
        );
        for (let attempt = 0; attempt < 240; attempt += 1) {
          const current = await apiRequest<OperationDetail>(operation.data.statusUrl);
          if (!['queued', 'running'].includes(current.data.status)) {
            if (current.data.status !== 'succeeded') {
              throw new Error(
                current.data.error?.message ?? `连接测试失败：${current.data.status}`,
              );
            }
            return current;
          }
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        }
        throw new Error('连接测试仍在后台运行，请稍后刷新状态');
      }
      if (kind === 'disable') {
        return apiRequest(`/api/v1/integrations/${row.id}/disable`, {
          method: 'POST',
          body: JSON.stringify({ version: row.version }),
        });
      }
      return apiRequest(`/api/v1/integrations/${row.id}/credential`, {
        method: 'DELETE',
        body: JSON.stringify({ version: row.version }),
      });
    },
    onSuccess: async (_, input) => {
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
      void messageApi.success(input.kind === 'test' ? '连接测试成功' : '操作已受理');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const openProvider = (provider: AiProviderDefinition) => {
    setSelectedProvider(provider);
    form.setFieldsValue(defaultAiProviderValues(provider));
  };

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      {holder}
      <div className="ai-provider-heading">
        <div>
          <Typography.Title level={4}>模型供应商</Typography.Title>
          <Typography.Text type="secondary">
            配置模型服务的凭证和调用参数。一个供应商可以添加多个模型配置。
          </Typography.Text>
        </div>
        <Tag color="blue">{configuredProviders.length} 个已配置模型</Tag>
      </div>

      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        message="模型只接收经过白名单筛选的数据"
        description="系统不会向模型提供工具、源码、diff、附件或本机文件读取能力。API Key 进入本机凭证保险箱，保存后不再回显。"
      />

      <div className="ai-provider-catalog">
        {aiProviderCatalog.map((provider) => {
          const configuredCount = configuredProviders.filter(
            (item) => aiProviderIdFromIntegration(item) === provider.id,
          ).length;
          return (
            <button
              key={provider.id}
              type="button"
              className="ai-provider-option"
              onClick={() => openProvider(provider)}
            >
              <span
                className="ai-provider-mark"
                style={{ '--provider-color': provider.color } as CSSProperties}
              >
                {provider.mark}
              </span>
              <span className="ai-provider-option-copy">
                <span className="ai-provider-option-title">
                  {provider.name}
                  {configuredCount > 0 && <Tag color="green">已配置 {configuredCount}</Tag>}
                </span>
                <span className="ai-provider-description">{provider.description}</span>
              </span>
              <PlusOutlined className="ai-provider-add-icon" />
            </button>
          );
        })}
      </div>

      <Card title="已配置的模型" loading={integrations.isLoading}>
        {configuredProviders.length === 0 ? (
          <Empty description="尚未配置模型供应商，请从上方选择一个供应商" />
        ) : (
          <div className="ai-configured-grid">
            {configuredProviders.map((connection) => {
              const provider = aiProviderById(aiProviderIdFromIntegration(connection));
              const model =
                typeof connection.config.model === 'string' ? connection.config.model : '—';
              const protocol =
                typeof connection.config.protocol === 'string' ? connection.config.protocol : '—';
              return (
                <div className="ai-configured-card" key={connection.id}>
                  <div className="ai-configured-card-main">
                    <span
                      className="ai-provider-mark"
                      style={{ '--provider-color': provider.color } as CSSProperties}
                    >
                      {provider.mark}
                    </span>
                    <div className="ai-configured-copy">
                      <Space wrap size={8}>
                        <Typography.Text strong>{connection.name}</Typography.Text>
                        <StatusTag status={connection.status} />
                        {!connection.enabled && <Tag>已禁用</Tag>}
                      </Space>
                      <Typography.Text className="ai-model-name">{model}</Typography.Text>
                      <Typography.Text type="secondary" ellipsis={{ tooltip: connection.baseUrl }}>
                        {provider.name} · {protocol} · {connection.baseUrl}
                      </Typography.Text>
                    </div>
                  </div>
                  <div className="ai-configured-actions">
                    <Button
                      size="small"
                      icon={<ApiOutlined />}
                      disabled={!connection.enabled || !connection.credentialMask}
                      loading={action.isPending}
                      onClick={() => action.mutate({ row: connection, kind: 'test' })}
                    >
                      测试连接
                    </Button>
                    <Popconfirm
                      title="禁用后，所有使用该模型的 AI 生成都会停止。"
                      onConfirm={() => action.mutate({ row: connection, kind: 'disable' })}
                    >
                      <Button size="small" disabled={!connection.enabled}>
                        禁用
                      </Button>
                    </Popconfirm>
                    <Popconfirm
                      title="确认从本机凭证保险箱撤销此 API Key？"
                      onConfirm={() => action.mutate({ row: connection, kind: 'revoke' })}
                    >
                      <Button size="small" danger disabled={!connection.credentialMask}>
                        撤销凭证
                      </Button>
                    </Popconfirm>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal
        title={selectedProvider ? `配置 ${selectedProvider.name}` : '配置模型供应商'}
        width={780}
        open={Boolean(selectedProvider)}
        onCancel={() => setSelectedProvider(null)}
        onOk={() => form.submit()}
        okText="保存供应商"
        confirmLoading={create.isPending}
        destroyOnHidden
      >
        {selectedProvider && (
          <Form form={form} layout="vertical" onFinish={(values) => create.mutate(values)}>
            <div className="ai-provider-modal-intro">
              <span
                className="ai-provider-mark ai-provider-mark-large"
                style={{ '--provider-color': selectedProvider.color } as CSSProperties}
              >
                {selectedProvider.mark}
              </span>
              <div>
                <Typography.Text strong>{selectedProvider.name}</Typography.Text>
                <br />
                <Typography.Text type="secondary">{selectedProvider.description}</Typography.Text>
              </div>
            </div>

            <Form.Item name="provider" hidden>
              <Input />
            </Form.Item>
            <div className="form-grid">
              <Form.Item name="name" label="配置名称" rules={[{ required: true }]}>
                <Input placeholder="例如：周报主模型" maxLength={100} />
              </Form.Item>
              <Form.Item name="model" label="模型" rules={[{ required: true }]}>
                {selectedProvider.custom ? (
                  <Input placeholder="输入模型 ID" />
                ) : (
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={selectedProvider.models}
                    placeholder="请选择模型"
                  />
                )}
              </Form.Item>
            </div>
            <div className="form-grid">
              <Form.Item
                name="baseUrl"
                label="API 基础地址"
                rules={[{ required: true }, { type: 'url' }]}
                extra={
                  selectedProvider.custom
                    ? '填写服务根地址或带版本号的基础地址，系统会补充协议对应的调用路径。'
                    : '已填入官方地址；使用企业网关或其他区域时可以修改。'
                }
              >
                <Input placeholder="https://api.example.com/v1" />
              </Form.Item>
              <Form.Item name="protocol" label="接口协议" rules={[{ required: true }]}>
                <Select
                  disabled={!selectedProvider.custom}
                  options={[
                    { value: 'openai_compatible', label: 'OpenAI-compatible' },
                    { value: 'anthropic', label: 'Anthropic Messages' },
                    { value: 'gemini', label: 'Google Gemini' },
                  ]}
                />
              </Form.Item>
            </div>

            <Divider titlePlacement="start">
              <KeyOutlined /> 凭证
            </Divider>
            <Form.Item name="apiKey" label="API Key" rules={[{ required: true, min: 8 }]}>
              <Input.Password autoComplete="new-password" placeholder="只在本次保存时输入" />
            </Form.Item>

            <Collapse
              ghost
              items={[
                {
                  key: 'advanced',
                  label: '调用设置',
                  children: (
                    <>
                      <div className="form-grid">
                        <Form.Item
                          name="timeoutMs"
                          label="请求超时（毫秒）"
                          rules={[{ required: true }]}
                        >
                          <InputNumber
                            min={1_000}
                            max={300_000}
                            precision={0}
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                        <Form.Item
                          name="maxInputTokens"
                          label="最大输入 Token"
                          rules={[{ required: true }]}
                        >
                          <InputNumber
                            min={256}
                            max={1_000_000}
                            precision={0}
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                        <Form.Item
                          name="maxOutputTokens"
                          label="最大输出 Token"
                          rules={[{ required: true }]}
                        >
                          <InputNumber
                            min={128}
                            max={100_000}
                            precision={0}
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                        <Form.Item
                          name="temperaturePolicy"
                          label="温度策略"
                          rules={[{ required: true }]}
                        >
                          <Select
                            options={[
                              { value: 'deterministic', label: '固定温度（推荐）' },
                              { value: 'provider_default', label: '供应商默认' },
                            ]}
                          />
                        </Form.Item>
                        <Form.Item
                          name="temperature"
                          label="固定温度"
                          rules={
                            selectedTemperaturePolicy === 'deterministic'
                              ? [{ required: true }]
                              : []
                          }
                        >
                          <InputNumber
                            min={0}
                            max={1}
                            step={0.1}
                            disabled={selectedTemperaturePolicy !== 'deterministic'}
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                      </div>
                      <Form.Item
                        name="allowedPurposes"
                        label="允许用途"
                        rules={[{ required: true, message: '至少选择一个允许用途' }]}
                      >
                        <Checkbox.Group options={purposeOptions} />
                      </Form.Item>
                      <Alert
                        type="info"
                        showIcon
                        message={`将使用 ${selectedProtocol ?? selectedProvider.protocol} 协议执行真实模型连接测试。`}
                      />
                    </>
                  ),
                },
              ]}
            />
          </Form>
        )}
      </Modal>
    </Space>
  );
}
