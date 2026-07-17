import {
  BranchesOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Divider,
  Form,
  Input,
  message,
  Progress,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { apiRequest } from '../api/client.js';
import type {
  GitBatch,
  GitBatchAction,
  GitBatchItem,
  GitBatchSummary,
  RepositoryView,
} from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';

interface GitFormValues {
  action: GitBatchAction;
  repositoryIds: string[];
  remote?: string;
  branch?: string;
  baseline?: string;
  targetBranch?: string;
  message?: string;
  includeUntracked?: boolean;
  stashOid?: string;
  pathsText?: string;
}

interface OperationReference {
  batchId: string;
  operationId: string;
  status: string;
  batchUrl: string;
  statusUrl: string;
}

const actionOptions: Array<{ value: GitBatchAction; label: string; description: string }> = [
  {
    value: 'fetch_prune',
    label: '获取并清理远端引用',
    description: '固定执行 fetch <remote> --prune',
  },
  { value: 'pull_ff_only', label: '仅快进拉取', description: '只允许 --ff-only，不合并、不变基' },
  {
    value: 'create_branch',
    label: '从基线创建分支',
    description: '基线先解析为提交，创建后安全切换且绝不覆盖同名分支',
  },
  { value: 'checkout', label: '切换本地分支', description: '工作区不干净时阻断，不自动 stash' },
  {
    value: 'push_set_upstream',
    label: '首次推送并设置上游',
    description: '只允许普通受限 refspec 推送',
  },
  { value: 'push', label: '普通推送', description: '远端前进或未知时阻断，永不 force' },
  { value: 'stash_create', label: '创建 stash', description: '可明确选择是否包含未跟踪文件' },
  {
    value: 'stash_apply',
    label: '应用 stash',
    description: '按 OID 应用，不自动 drop，冲突转人工复核',
  },
  { value: 'stage_paths', label: '暂存明确路径', description: '只暂存预览中逐条展示并批准的路径' },
  { value: 'commit', label: '创建提交', description: '绑定 HEAD 与 Index 哈希，正常运行 hooks' },
];

const terminalStatuses = new Set([
  'completed',
  'partial_failed',
  'failed',
  'needs_review',
  'cancelled',
  'expired',
  'preview_failed',
]);

export function GitBatchesPage() {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<GitFormValues>();
  const action = Form.useWatch('action', form) ?? 'fetch_prune';
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<boolean | string>(false);
  const [now, setNow] = useState(Date.now());

  const repositories = useQuery({
    queryKey: ['repositories'],
    queryFn: () => apiRequest<RepositoryView[]>('/api/v1/repositories'),
    refetchInterval: 15_000,
  });
  const recent = useQuery({
    queryKey: ['git-batches'],
    queryFn: () => apiRequest<GitBatchSummary[]>('/api/v1/git/batches?limit=20'),
    refetchInterval: 5_000,
  });
  const active = useQuery({
    queryKey: ['git-batch', activeBatchId],
    queryFn: () => apiRequest<GitBatch>(`/api/v1/git/batches/${activeBatchId}`),
    enabled: Boolean(activeBatchId),
    refetchInterval: (query) => {
      const status = query.state.data?.data.status;
      return status && terminalStatuses.has(status) ? false : 750;
    },
  });
  const batch = active.data?.data;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!batch || batch.status !== 'previewed') return;
    setSelectedItemIds(batch.items.filter((item) => item.executable).map((item) => item.id));
    setAcknowledgedWarnings([]);
    setConfirmation(false);
  }, [batch?.id, batch?.status]);

  const createPreview = useMutation({
    mutationFn: (values: GitFormValues) =>
      apiRequest<OperationReference>('/api/v1/git/batches/preview', {
        method: 'POST',
        body: JSON.stringify({
          action: values.action,
          repositoryIds: values.repositoryIds,
          parameters: parametersFor(values),
          clientContext: { sourcePage: 'git-batches' },
        }),
      }),
    onSuccess: async (response) => {
      setActiveBatchId(response.data.batchId);
      await queryClient.invalidateQueries({ queryKey: ['git-batches'] });
      message.success('预览已进入持久化队列，期间不会执行 Git 写操作');
    },
    onError: (error) => message.error(error.message),
  });

  const approve = useMutation({
    mutationFn: async () => {
      if (!batch) throw new Error('没有可批准的批次');
      return apiRequest<OperationReference>(`/api/v1/git/batches/${batch.id}/approve`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          batchVersion: batch.version,
          selectedItemIds,
          acknowledgedWarningIds: acknowledgedWarnings,
          confirmation,
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['git-batch', activeBatchId] });
      await queryClient.invalidateQueries({ queryKey: ['git-batches'] });
      message.success('批准已持久化，Worker 将逐仓复核后串行执行');
    },
    onError: (error) => message.error(error.message),
  });

  const cancel = useMutation({
    mutationFn: () =>
      apiRequest<GitBatch>(`/api/v1/git/batches/${activeBatchId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: '用户从 Git 批次操作台取消' }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['git-batch', activeBatchId] });
      await queryClient.invalidateQueries({ queryKey: ['git-batches'] });
      message.info('未开始的批次已取消');
    },
    onError: (error) => message.error(error.message),
  });

  const confirmedRepositories = (repositories.data?.data ?? []).filter(
    (item) => item.whitelistStatus === 'confirmed',
  );
  const selectedItems = batch?.items.filter((item) => selectedItemIds.includes(item.id)) ?? [];
  const requiredWarnings = selectedItems.flatMap((item) =>
    item.warnings.filter((warning) => warning.severity === 'warning'),
  );
  const allWarningsAcknowledged = requiredWarnings.every((warning) =>
    acknowledgedWarnings.includes(warning.id),
  );
  const sensitive = batch ? ['commit', 'push', 'push_set_upstream'].includes(batch.action) : false;
  const confirmed = sensitive ? confirmation === '确认执行' : confirmation === true;
  const secondsRemaining = batch?.expiresAt
    ? Math.max(0, Math.ceil((dayjs(batch.expiresAt).valueOf() - now) / 1_000))
    : 0;
  const canApprove =
    batch?.status === 'previewed' &&
    secondsRemaining > 0 &&
    selectedItemIds.length > 0 &&
    allWarningsAcknowledged &&
    confirmed;

  const step = batch
    ? ['previewing', 'draft'].includes(batch.status)
      ? 0
      : batch.status === 'previewed'
        ? 1
        : ['approved', 'running'].includes(batch.status)
          ? 2
          : 3
    : 0;

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>受限 Git 批次</Typography.Title>
          <Typography.Text type="secondary">
            固定动作参数化、只读预览、人工批准、执行前复核、逐仓结果与恢复建议完整留痕。
          </Typography.Text>
        </div>
        <Tag icon={<SafetyCertificateOutlined />} color="blue">
          无 Shell · 无 Force · 无任意参数
        </Tag>
      </div>

      <Alert
        showIcon
        type="info"
        message="两阶段写入边界"
        description="预览只读取仓库；批准绑定 10 分钟快照版本。Worker 获取仓库锁后再次比较身份、HEAD、分支、上游、工作区和 Index，任何变化都会只把该仓标记为 stale_preview。"
      />

      <Card
        title={
          <Space>
            <BranchesOutlined />
            新建预览
          </Space>
        }
      >
        <Form<GitFormValues>
          form={form}
          layout="vertical"
          initialValues={{ action: 'fetch_prune', includeUntracked: false }}
          onFinish={(values) => createPreview.mutate(values)}
        >
          <div className="form-grid">
            <Form.Item name="action" label="受限动作" rules={[{ required: true }]}>
              <Select
                options={actionOptions.map((item) => ({
                  value: item.value,
                  label: `${item.label}｜${item.description}`,
                }))}
              />
            </Form.Item>
            <Form.Item
              name="repositoryIds"
              label="目标仓库（最多 50 个）"
              rules={[{ required: true, message: '至少选择一个已确认仓库' }]}
            >
              <Select
                mode="multiple"
                maxCount={50}
                optionFilterProp="label"
                options={confirmedRepositories.map((repository) => {
                  const snapshot = repository.latestSnapshot;
                  const dirty =
                    (snapshot?.stagedCount ?? 0) +
                    (snapshot?.unstagedCount ?? 0) +
                    (snapshot?.untrackedCount ?? 0);
                  return {
                    value: repository.id,
                    label: `${repository.alias ?? repository.displayName}｜${snapshot?.branchName ?? '分离 HEAD'}｜变更 ${dirty}｜落后 ${snapshot?.behindCount ?? 0}`,
                  };
                })}
              />
            </Form.Item>
          </div>
          <ActionFields action={action} />
          <Button
            type="primary"
            htmlType="submit"
            loading={createPreview.isPending}
            disabled={confirmedRepositories.length === 0}
          >
            生成只读预览
          </Button>
        </Form>
      </Card>

      {batch && (
        <Card
          title={`批次 ${batch.id.slice(0, 8)}`}
          extra={
            !batch.executionStartedAt &&
            !['completed', 'cancelled', 'expired'].includes(batch.status) ? (
              <Button danger loading={cancel.isPending} onClick={() => cancel.mutate()}>
                取消未开始批次
              </Button>
            ) : null
          }
        >
          <Steps
            current={step}
            status={
              ['failed', 'partial_failed', 'needs_review', 'preview_failed'].includes(batch.status)
                ? 'error'
                : 'process'
            }
            items={[
              { title: '只读预览' },
              { title: '人工批准' },
              { title: '逐仓复核执行' },
              { title: '结果与恢复' },
            ]}
          />
          <Divider />
          <Descriptions size="small" column={4}>
            <Descriptions.Item label="动作">
              {actionOptions.find((item) => item.value === batch.action)?.label}
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              <StatusTag status={batch.status} />
            </Descriptions.Item>
            <Descriptions.Item label="版本">v{batch.version}</Descriptions.Item>
            <Descriptions.Item label="快照剩余">
              <Space>
                <ClockCircleOutlined />
                {batch.status === 'previewed' ? `${secondsRemaining} 秒` : '—'}
              </Space>
            </Descriptions.Item>
          </Descriptions>
          {batch.status === 'previewing' && (
            <Progress
              percent={Math.round(
                ((batch.summary.previewed ?? 0) / Math.max(batch.items.length, 1)) * 100,
              )}
              status="active"
            />
          )}

          <Table<GitBatchItem>
            className="git-preview-table"
            rowKey="id"
            pagination={false}
            dataSource={batch.items}
            {...(batch.status === 'previewed'
              ? {
                  rowSelection: {
                    selectedRowKeys: selectedItemIds,
                    getCheckboxProps: (item) => ({ disabled: !item.executable }),
                    onChange: (keys) => setSelectedItemIds(keys.map(String)),
                  },
                }
              : {})}
            expandable={{
              expandedRowRender: (item) => <ItemDetail item={item} />,
            }}
            columns={[
              {
                title: '仓库',
                render: (_, item) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text strong>
                      {item.repositoryAlias ?? item.repositoryName}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {item.previewSnapshot.branchName ?? '分离 HEAD / 未出生'}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                title: 'HEAD',
                render: (_, item) => item.previewSnapshot.headSha?.slice(0, 8) ?? '无提交',
              },
              {
                title: '风险',
                render: (_, item) => (
                  <Tag
                    color={
                      item.riskLevel === 'sensitive'
                        ? 'red'
                        : item.riskLevel === 'warning'
                          ? 'orange'
                          : 'blue'
                    }
                  >
                    {item.riskLevel}
                  </Tag>
                ),
              },
              {
                title: '预览',
                render: (_, item) =>
                  item.executable ? (
                    <Tag color="success">可执行</Tag>
                  ) : (
                    <Tag color="error">已阻断</Tag>
                  ),
              },
              {
                title: '结果',
                render: (_, item) =>
                  item.resultCode ? (
                    <StatusTag status={item.resultCode} />
                  ) : (
                    <StatusTag status={item.status} />
                  ),
              },
              {
                title: '耗时',
                render: (_, item) => (item.durationMs === null ? '—' : `${item.durationMs} ms`),
              },
            ]}
          />

          {batch.status === 'previewed' && (
            <div className="approval-panel">
              <Typography.Title level={4}>
                批准 {selectedItemIds.length} 个目标仓库
              </Typography.Title>
              {requiredWarnings.length > 0 && (
                <Space direction="vertical">
                  {requiredWarnings.map((warning) => (
                    <Checkbox
                      key={warning.id}
                      checked={acknowledgedWarnings.includes(warning.id)}
                      onChange={(event) =>
                        setAcknowledgedWarnings((current) =>
                          event.target.checked
                            ? [...current, warning.id]
                            : current.filter((id) => id !== warning.id),
                        )
                      }
                    >
                      {warning.message}
                    </Checkbox>
                  ))}
                </Space>
              )}
              <Divider />
              {sensitive ? (
                <Input
                  value={typeof confirmation === 'string' ? confirmation : ''}
                  onChange={(event) => setConfirmation(event.target.value)}
                  placeholder="敏感动作请输入：确认执行"
                  maxLength={20}
                />
              ) : (
                <Checkbox
                  checked={confirmation === true}
                  onChange={(event) => setConfirmation(event.target.checked)}
                >
                  我已核对每个仓库的命令、影响和阻断信息
                </Checkbox>
              )}
              <Button
                type="primary"
                danger={sensitive}
                disabled={!canApprove}
                loading={approve.isPending}
                onClick={() => approve.mutate()}
              >
                批准并执行 {selectedItemIds.length} 个仓库
              </Button>
            </div>
          )}
        </Card>
      )}

      <Card title="最近批次">
        <Table<GitBatchSummary>
          rowKey="id"
          loading={recent.isLoading}
          dataSource={recent.data?.data ?? []}
          pagination={false}
          onRow={(record) => ({
            onClick: () => setActiveBatchId(record.id),
            className: 'clickable-row',
          })}
          columns={[
            {
              title: '创建时间',
              dataIndex: 'createdAt',
              render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss'),
            },
            {
              title: '动作',
              dataIndex: 'action',
              render: (value: GitBatchAction) =>
                actionOptions.find((item) => item.value === value)?.label ?? value,
            },
            {
              title: '状态',
              dataIndex: 'status',
              render: (value: string) => <StatusTag status={value} />,
            },
            { title: '总数', render: (_, record) => record.summary.total ?? 0 },
            {
              title: '成功',
              render: (_, record) =>
                (record.summary.succeeded ?? 0) + (record.summary.already_satisfied ?? 0),
            },
            {
              title: '需处理',
              render: (_, record) =>
                (record.summary.failed ?? 0) +
                (record.summary.stale_preview ?? 0) +
                (record.summary.needs_review ?? 0),
            },
          ]}
        />
      </Card>
    </Space>
  );
}

function ActionFields({ action }: { action: GitBatchAction }) {
  if (action === 'fetch_prune')
    return (
      <Form.Item name="remote" label="远端" initialValue="origin" rules={[{ required: true }]}>
        <Input maxLength={101} />
      </Form.Item>
    );
  if (action === 'pull_ff_only')
    return (
      <div className="form-grid">
        <Form.Item name="remote" label="远端（留空则使用当前上游）">
          <Input maxLength={101} />
        </Form.Item>
        <Form.Item name="branch" label="远端分支（与远端同时填写）">
          <Input maxLength={255} />
        </Form.Item>
      </div>
    );
  if (action === 'create_branch')
    return (
      <div className="form-grid">
        <Form.Item name="branch" label="新分支" rules={[{ required: true }]}>
          <Input maxLength={255} />
        </Form.Item>
        <Form.Item name="baseline" label="现有基线" rules={[{ required: true }]}>
          <Input maxLength={255} />
        </Form.Item>
      </div>
    );
  if (action === 'checkout')
    return (
      <Form.Item name="targetBranch" label="目标本地分支" rules={[{ required: true }]}>
        <Input maxLength={255} />
      </Form.Item>
    );
  if (action === 'push' || action === 'push_set_upstream')
    return (
      <div className="form-grid">
        <Form.Item name="remote" label="远端" initialValue="origin" rules={[{ required: true }]}>
          <Input maxLength={101} />
        </Form.Item>
        <Form.Item name="branch" label="本地分支" rules={[{ required: true }]}>
          <Input maxLength={255} />
        </Form.Item>
      </div>
    );
  if (action === 'stash_create')
    return (
      <div className="form-grid">
        <Form.Item name="message" label="stash 说明" rules={[{ required: true }]}>
          <Input maxLength={200} />
        </Form.Item>
        <Form.Item name="includeUntracked" valuePropName="checked" label="范围">
          <Checkbox>明确包含未跟踪文件</Checkbox>
        </Form.Item>
      </div>
    );
  if (action === 'stash_apply')
    return (
      <Form.Item
        name="stashOid"
        label="stash 完整 OID"
        rules={[{ required: true, pattern: /^[0-9a-f]{40,64}$/u }]}
      >
        <Input maxLength={64} />
      </Form.Item>
    );
  if (action === 'stage_paths')
    return (
      <Form.Item name="pathsText" label="明确相对路径（每行一个）" rules={[{ required: true }]}>
        <Input.TextArea rows={5} maxLength={20_000} placeholder={'src/功能.ts\ndocs/说明.md'} />
      </Form.Item>
    );
  return (
    <Form.Item name="message" label="提交说明" rules={[{ required: true }]}>
      <Input.TextArea rows={4} maxLength={5_000} />
    </Form.Item>
  );
}

function ItemDetail({ item }: { item: GitBatchItem }) {
  return (
    <Space direction="vertical" className="item-detail">
      <Descriptions size="small" column={3}>
        <Descriptions.Item label="上游">
          {item.previewSnapshot.upstreamRef ?? '未设置'}
        </Descriptions.Item>
        <Descriptions.Item label="暂存/修改/未跟踪">
          {item.previewSnapshot.stagedCount ?? 0} / {item.previewSnapshot.unstagedCount ?? 0} /{' '}
          {item.previewSnapshot.untrackedCount ?? 0}
        </Descriptions.Item>
        <Descriptions.Item label="冲突">
          {item.previewSnapshot.conflictedCount ?? 0}
        </Descriptions.Item>
      </Descriptions>
      {item.displayCommand && (
        <Typography.Text code copyable>
          {item.displayCommand}
        </Typography.Text>
      )}
      {item.expectedChanges.length > 0 && (
        <Collapse
          size="small"
          items={[
            {
              key: 'changes',
              label: `预期影响（${item.expectedChanges.length}）`,
              children: (
                <ul>
                  {item.expectedChanges.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
      )}
      {item.blockingReasons.map((reason) => (
        <Alert
          key={reason.code}
          showIcon
          type="error"
          icon={<ExclamationCircleOutlined />}
          message={`${reason.code}｜${reason.message}`}
          description={`恢复建议：${reason.recovery}`}
        />
      ))}
      {item.resultSummary && (
        <Alert
          showIcon
          type={
            item.resultCode === 'succeeded' || item.resultCode === 'already_satisfied'
              ? 'success'
              : 'warning'
          }
          icon={item.resultCode === 'succeeded' ? <CheckCircleOutlined /> : undefined}
          message={item.resultSummary}
          description={item.postHeadSha ? `执行后 HEAD：${item.postHeadSha}` : undefined}
        />
      )}
      {item.outputSummary && <pre className="safe-json">{item.outputSummary}</pre>}
    </Space>
  );
}

function parametersFor(values: GitFormValues): Record<string, unknown> {
  switch (values.action) {
    case 'fetch_prune':
      return { remote: values.remote };
    case 'pull_ff_only':
      return {
        ...(values.remote ? { remote: values.remote } : {}),
        ...(values.branch ? { branch: values.branch } : {}),
      };
    case 'create_branch':
      return { branch: values.branch, baseline: values.baseline };
    case 'checkout':
      return { targetBranch: values.targetBranch };
    case 'push':
    case 'push_set_upstream':
      return { remote: values.remote, branch: values.branch };
    case 'stash_create':
      return { message: values.message, includeUntracked: values.includeUntracked === true };
    case 'stash_apply':
      return { stashOid: values.stashOid };
    case 'stage_paths':
      return {
        paths: [
          ...new Set(
            (values.pathsText ?? '')
              .split(/\r?\n/u)
              .map((path) => path.trim())
              .filter(Boolean),
          ),
        ],
      };
    case 'commit':
      return { message: values.message };
  }
}
