import {
  CheckOutlined,
  CloseOutlined,
  ExportOutlined,
  PlusOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import { useMemo, useState } from 'react';
import type { Key } from 'react';
import { apiRequest } from '../api/client.js';
import type {
  EvidenceCatalogView,
  EvidenceLinkStatus,
  EvidenceLinkView,
  TaskEvidenceView,
  TaskSummary,
} from '../api/types.js';
import { batchSelection, evidenceMethodLabel, isBatchConfirmable } from './evidence-view-model.js';

interface WriteRequest {
  path: string;
  method?: 'POST' | 'DELETE';
  body: unknown;
  successMessage: string;
}

interface DecisionState {
  link: EvidenceLinkView;
  mode: 'reject' | 'revoke';
}

const statusOptions: Array<{ value: EvidenceLinkStatus; label: string }> = [
  { value: 'suggested', label: '待确认' },
  { value: 'confirmed', label: '已确认' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'expired', label: '已失效' },
];

export function TaskEvidencePanel({ task }: { task: TaskSummary }) {
  const queryClient = useQueryClient();
  const [messageApi, holder] = message.useMessage();
  const [status, setStatus] = useState<EvidenceLinkStatus>();
  const [selectedIds, setSelectedIds] = useState<Key[]>([]);
  const [decision, setDecision] = useState<DecisionState | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [decisionForm] = Form.useForm<{ reason: string }>();
  const [manualForm] = Form.useForm<{
    evidenceId: string;
    explanation: string;
    expiresAt?: string;
  }>();
  const evidence = useQuery({
    queryKey: ['task-evidence', task.id],
    queryFn: () => apiRequest<TaskEvidenceView>(`/api/v1/tasks/${task.id}/evidence`),
  });
  const catalog = useQuery({
    queryKey: ['evidence-catalog', task.project?.id],
    queryFn: () => {
      const query = new URLSearchParams({
        limit: '100',
        availability: 'available',
        ...(task.project?.id ? { projectId: task.project.id } : {}),
      });
      return apiRequest<EvidenceCatalogView>(`/api/v1/evidence?${query.toString()}`);
    },
    enabled: manualOpen,
  });
  const write = useMutation({
    mutationFn: (input: WriteRequest) =>
      apiRequest(input.path, {
        method: input.method ?? 'POST',
        headers: { 'Idempotency-Key': `evidence-${globalThis.crypto.randomUUID()}` },
        body: JSON.stringify(input.body),
      }),
    onSuccess: async (_, input) => {
      setSelectedIds([]);
      setDecision(null);
      setManualOpen(false);
      decisionForm.resetFields();
      manualForm.resetFields();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['task-evidence', task.id] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['task-detail', task.id] }),
        queryClient.invalidateQueries({ queryKey: ['evidence-catalog'] }),
      ]);
      void messageApi.success(input.successMessage);
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });
  const allItems = evidence.data?.data.items ?? [];
  const visibleItems = status ? allItems.filter((link) => link.status === status) : allItems;
  const selection = useMemo(
    () => batchSelection(allItems, selectedIds.map(String)),
    [allItems, selectedIds],
  );
  const selectedMethod = allItems.find((link) => selectedIds.includes(link.id))?.method;
  const alreadyLinked = new Set(allItems.map((link) => link.evidenceId));

  const confirm = (link: EvidenceLinkView) => {
    write.mutate({
      path: `/api/v1/evidence-links/${link.id}/confirm`,
      body: { version: link.version },
      successMessage:
        link.revalidationState === 'needs_revalidation' ? '证据关系已重新确认' : '证据关系已确认',
    });
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {holder}
      <Alert
        type="info"
        showIcon
        message={`${task.issueKey ?? '本地任务'} · ${task.title}`}
        description="左侧任务事实不因证据决定而改变；右侧关系只影响周报/绩效候选。关键词和 AI 建议必须逐条确认，系统不会写 Jira。"
      />
      <Space wrap>
        <Tag color="processing">待确认 {evidence.data?.data.counts.suggested ?? 0}</Tag>
        <Tag color="success">已确认 {evidence.data?.data.counts.confirmed ?? 0}</Tag>
        <Tag color="error">已拒绝 {evidence.data?.data.counts.rejected ?? 0}</Tag>
        <Tag>已失效 {evidence.data?.data.counts.expired ?? 0}</Tag>
        <Select
          allowClear
          placeholder="关系状态"
          value={status}
          onChange={setStatus}
          options={statusOptions}
          style={{ width: 140 }}
        />
        <Button icon={<PlusOutlined />} onClick={() => setManualOpen(true)}>
          手工绑定证据
        </Button>
      </Space>
      <Alert
        type={selection.enabled ? 'success' : 'info'}
        showIcon
        message="批量确认门禁"
        description={`${selection.reason}。只有同一种分支/Commit/MR/Pipeline 高确定规则可批量确认，服务端会再次校验。`}
        action={
          <Button
            type="primary"
            size="small"
            disabled={!selection.enabled}
            loading={write.isPending}
            onClick={() =>
              write.mutate({
                path: '/api/v1/evidence-links/batch-confirm',
                body: {
                  items: allItems
                    .filter((link) => selectedIds.includes(link.id))
                    .map((link) => ({ id: link.id, version: link.version })),
                },
                successMessage: `已批量确认 ${selectedIds.length} 条高确定性证据`,
              })
            }
          >
            批量确认 {selectedIds.length > 0 ? selectedIds.length : ''}
          </Button>
        }
      />
      <Table<EvidenceLinkView>
        rowKey="id"
        size="small"
        loading={evidence.isLoading}
        dataSource={visibleItems}
        scroll={{ x: 1_250 }}
        pagination={{ pageSize: 8, showSizeChanger: true }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: setSelectedIds,
          getCheckboxProps: (link) => ({
            disabled:
              !isBatchConfirmable(link) ||
              Boolean(selectedMethod && selectedMethod !== link.method),
          }),
        }}
        expandable={{ expandedRowRender: (link) => <EvidenceHistory link={link} /> }}
        columns={[
          {
            title: '证据事实',
            width: 280,
            fixed: 'left',
            render: (_, link) => (
              <Space direction="vertical" size={2}>
                <Space wrap>
                  <Tag color={sourceColor(link.evidence.sourceType)}>
                    {sourceLabel(link.evidence.sourceType)}
                  </Tag>
                  <AvailabilityTag value={link.evidence.availabilityState} />
                </Space>
                {link.evidence.url ? (
                  <Typography.Link href={link.evidence.url} target="_blank" rel="noreferrer" strong>
                    {link.evidence.title} <ExportOutlined />
                  </Typography.Link>
                ) : (
                  <Typography.Text strong>{link.evidence.title}</Typography.Text>
                )}
                <Typography.Text type="secondary" copyable>
                  {link.evidence.sourceExternalKey}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: '项目 / 时间',
            width: 220,
            render: (_, link) => (
              <Space direction="vertical" size={0}>
                <Typography.Text>
                  {link.evidence.project?.name ??
                    link.evidence.gitlabProject?.pathWithNamespace ??
                    '未映射项目'}
                </Typography.Text>
                <Typography.Text type="secondary">
                  事件 {formatTime(link.evidence.eventAt)}
                </Typography.Text>
                <Typography.Text type="secondary">
                  同步 {formatTime(link.evidence.sourceSyncedAt)}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: '匹配依据 / 置信度',
            width: 320,
            render: (_, link) => (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Space wrap>
                  <Tag color={methodColor(link.method)}>{evidenceMethodLabel(link.method)}</Tag>
                  {link.matchedValue && <Tag>{link.matchedValue}</Tag>}
                </Space>
                <Progress
                  percent={Math.round(link.confidence * 100)}
                  size="small"
                  status={link.confidence >= 0.95 ? 'success' : 'normal'}
                />
                <Typography.Text type="secondary">{link.explanation}</Typography.Text>
              </Space>
            ),
          },
          {
            title: '关系状态',
            width: 170,
            render: (_, link) => (
              <Space direction="vertical" size={2}>
                <RelationStatus link={link} />
                {link.decisionReason && (
                  <Typography.Text type="secondary">{link.decisionReason}</Typography.Text>
                )}
                {link.expiresAt && (
                  <Typography.Text type="secondary">
                    有效期至 {formatTime(link.expiresAt)}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: '人工决定',
            width: 230,
            fixed: 'right',
            render: (_, link) => (
              <Space wrap>
                {(link.status === 'suggested' ||
                  link.revalidationState === 'needs_revalidation') && (
                  <Button
                    size="small"
                    type="primary"
                    icon={<CheckOutlined />}
                    loading={write.isPending}
                    onClick={() => confirm(link)}
                  >
                    {link.revalidationState === 'needs_revalidation' ? '重新确认' : '确认'}
                  </Button>
                )}
                {['suggested', 'confirmed'].includes(link.status) && (
                  <Button
                    size="small"
                    danger
                    icon={<CloseOutlined />}
                    disabled={write.isPending}
                    onClick={() => {
                      decisionForm.resetFields();
                      setDecision({ link, mode: 'reject' });
                    }}
                  >
                    拒绝
                  </Button>
                )}
                {['confirmed', 'rejected'].includes(link.status) && (
                  <Button
                    size="small"
                    icon={<UndoOutlined />}
                    disabled={write.isPending}
                    onClick={() => {
                      decisionForm.resetFields();
                      setDecision({ link, mode: 'revoke' });
                    }}
                  >
                    撤销决定
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={decision?.mode === 'reject' ? '拒绝证据关系' : '撤销人工决定'}
        open={Boolean(decision)}
        onCancel={() => setDecision(null)}
        onOk={() => decisionForm.submit()}
        confirmLoading={write.isPending}
        okButtonProps={{ danger: decision?.mode === 'reject' }}
        okText={decision?.mode === 'reject' ? '确认拒绝' : '确认撤销'}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          message={
            decision?.mode === 'reject'
              ? '相同内容哈希与规则版本下不会重复建议'
              : '关系和全部历史事件仍会保留'
          }
          style={{ marginBottom: 16 }}
        />
        <Form
          form={decisionForm}
          layout="vertical"
          onFinish={(values: { reason: string }) => {
            if (!decision) return;
            write.mutate({
              path:
                decision.mode === 'reject'
                  ? `/api/v1/evidence-links/${decision.link.id}/reject`
                  : `/api/v1/evidence-links/${decision.link.id}/confirmation`,
              method: decision.mode === 'revoke' ? 'DELETE' : 'POST',
              body: { version: decision.link.version, reason: values.reason },
              successMessage: decision.mode === 'reject' ? '证据关系已拒绝' : '人工决定已撤销',
            });
          }}
        >
          <Form.Item name="reason" label="原因" rules={[{ required: true, min: 2, max: 500 }]}>
            <Input.TextArea rows={4} placeholder="说明判断依据，便于周报和绩效复核" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="手工绑定已有证据"
        open={manualOpen}
        onCancel={() => setManualOpen(false)}
        onOk={() => manualForm.submit()}
        confirmLoading={write.isPending}
        okText="确认绑定"
        width={720}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          message="人工绑定置信度记为 1.00，但不会修改任务或外部系统"
          description="撤销后关系转为已失效并保留历史；若任务与证据已有建议，请在原关系上确认。"
          style={{ marginBottom: 16 }}
        />
        <Form
          form={manualForm}
          layout="vertical"
          onFinish={(values: { evidenceId: string; explanation: string; expiresAt?: string }) =>
            write.mutate({
              path: '/api/v1/evidence-links',
              body: {
                taskId: task.id,
                evidenceId: values.evidenceId,
                explanation: values.explanation,
                ...(values.expiresAt?.trim() ? { expiresAt: values.expiresAt.trim() } : {}),
              },
              successMessage: '手工证据关系已创建并确认',
            })
          }
        >
          <Form.Item name="evidenceId" label="证据" rules={[{ required: true }]}>
            <Select
              showSearch
              loading={catalog.isLoading}
              optionFilterProp="label"
              placeholder="选择同项目可用证据"
              options={(catalog.data?.data.items ?? [])
                .filter((item) => !alreadyLinked.has(item.id))
                .map((item) => ({
                  value: item.id,
                  label: `${sourceLabel(item.sourceType)} · ${item.title} · ${formatTime(item.eventAt)}`,
                }))}
            />
          </Form.Item>
          <Form.Item
            name="explanation"
            label="绑定说明"
            rules={[{ required: true, min: 2, max: 1_000 }]}
          >
            <Input.TextArea rows={4} placeholder="说明该证据如何支撑当前任务" />
          </Form.Item>
          <Form.Item
            name="expiresAt"
            label="有效期（可选）"
            extra="ISO 8601，例如 2026-09-30T18:00:00+08:00；留空表示长期有效"
          >
            <Input placeholder="2026-09-30T18:00:00+08:00" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

function EvidenceHistory({ link }: { link: EvidenceLinkView }) {
  if (link.events.length === 0) return <Typography.Text type="secondary">暂无事件</Typography.Text>;
  return (
    <Timeline
      items={link.events.map((event) => ({
        color: event.actorType === 'system' ? 'gray' : 'blue',
        children: (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>
              #{event.sequence} {event.action} · {event.fromStatus ?? '无'} → {event.toStatus}
            </Typography.Text>
            <Typography.Text>{event.reason ?? '无补充原因'}</Typography.Text>
            <Typography.Text type="secondary">
              {event.actorType} / {event.actorId} · {formatTime(event.occurredAt)} · 规则{' '}
              {event.ruleVersion} · 哈希 {event.sourceContentHash.slice(0, 12)}
            </Typography.Text>
          </Space>
        ),
      }))}
    />
  );
}

function RelationStatus({ link }: { link: EvidenceLinkView }) {
  const view = {
    suggested: { color: 'processing', text: '待确认' },
    confirmed: { color: 'success', text: '已确认' },
    rejected: { color: 'error', text: '已拒绝' },
    expired: { color: 'default', text: '已失效' },
  }[link.status];
  return (
    <Space wrap>
      <Tag color={view.color}>{view.text}</Tag>
      {link.revalidationState === 'needs_revalidation' && <Tag color="warning">需要复核</Tag>}
    </Space>
  );
}

function AvailabilityTag({ value }: { value: EvidenceLinkView['evidence']['availabilityState'] }) {
  const view = {
    available: { color: 'success', text: '可用' },
    stale: { color: 'warning', text: '数据过期' },
    unavailable: { color: 'error', text: '来源不可用' },
  }[value];
  return <Tag color={view.color}>{view.text}</Tag>;
}

function sourceLabel(value: EvidenceLinkView['evidence']['sourceType']): string {
  return {
    branch: '分支',
    commit: 'Commit',
    merge_request: 'MR',
    pipeline: 'Pipeline',
    tag: 'Tag',
    release: 'Release',
    manual: '人工材料',
  }[value];
}

function sourceColor(value: EvidenceLinkView['evidence']['sourceType']): string {
  return {
    branch: 'geekblue',
    commit: 'blue',
    merge_request: 'purple',
    pipeline: 'cyan',
    tag: 'gold',
    release: 'green',
    manual: 'default',
  }[value];
}

function methodColor(method: EvidenceLinkView['method']): string {
  if (method === 'ai') return 'purple';
  if (method === 'keyword') return 'gold';
  if (method === 'manual') return 'cyan';
  return 'blue';
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}
