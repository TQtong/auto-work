import {
  ApartmentOutlined,
  BranchesOutlined,
  FileSearchOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  message,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';
import { apiRequest } from '../api/client.js';
import type { ProjectSummary, RepositoryView } from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';

interface OperationReference {
  operationId: string;
  status: string;
  statusUrl: string;
}

interface OperationDetail {
  id: string;
  status: string;
  progress: number;
  error?: { code: string; message: string };
}

interface ConfirmValues {
  displayName: string;
  alias?: string;
  projectId?: string;
  remoteName?: string;
  gitlabProjectRef?: string;
  baselineBranch: string;
}

export function RepositoriesPage() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<RepositoryView | null>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [confirmForm] = Form.useForm<ConfirmValues>();
  const [projectForm] = Form.useForm<{ name: string; alias?: string; description?: string }>();
  const repositories = useQuery({
    queryKey: ['repositories'],
    queryFn: () => apiRequest<RepositoryView[]>('/api/v1/repositories'),
    refetchInterval: 15_000,
  });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiRequest<ProjectSummary[]>('/api/v1/projects'),
  });

  const waitForOperation = async (operation: OperationReference) => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const current = await apiRequest<OperationDetail>(operation.statusUrl);
      if (!['queued', 'running'].includes(current.data.status)) {
        if (current.data.status !== 'succeeded') {
          throw new Error(current.data.error?.message ?? `作业结束状态：${current.data.status}`);
        }
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new Error('作业仍在后台运行，可到“作业与审计”继续查看');
  };

  const runOperation = useMutation({
    mutationFn: async (input: { path: string; label: string }) => {
      const operation = await apiRequest<OperationReference>(input.path, {
        method: 'POST',
        body: '{}',
      });
      message.loading({ content: `${input.label}已进入持久化队列`, key: 'repository-operation' });
      await waitForOperation(operation.data);
      return input.label;
    },
    onSuccess: async (label) => {
      await queryClient.invalidateQueries({ queryKey: ['repositories'] });
      message.success({ content: `${label}完成`, key: 'repository-operation' });
    },
    onError: (error) => {
      message.error({ content: error.message, key: 'repository-operation' });
    },
  });

  const confirmRepository = useMutation({
    mutationFn: async (values: ConfirmValues) => {
      if (!confirming) throw new Error('未选择仓库');
      return apiRequest<RepositoryView>(`/api/v1/repositories/${confirming.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          ...values,
          projectId: values.projectId || null,
          remoteName: values.remoteName || null,
          gitlabProjectRef: values.gitlabProjectRef || null,
          alias: values.alias || null,
          discoverySnapshotVersion: confirming.version,
        }),
      });
    },
    onSuccess: async () => {
      setConfirming(null);
      confirmForm.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['repositories'] });
      message.success('仓库已确认并加入白名单');
    },
    onError: (error) => message.error(error.message),
  });

  const createProject = useMutation({
    mutationFn: (values: { name: string; alias?: string; description?: string }) =>
      apiRequest<ProjectSummary>('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify(values),
      }),
    onSuccess: async () => {
      setProjectModalOpen(false);
      projectForm.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      message.success('业务项目已创建');
    },
    onError: (error) => message.error(error.message),
  });

  const disableRepository = useMutation({
    mutationFn: (repository: RepositoryView) =>
      apiRequest<RepositoryView>(`/api/v1/repositories/${repository.id}/disable`, {
        method: 'POST',
        body: JSON.stringify({ version: repository.version }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['repositories'] });
      message.success('仓库已移出可写白名单，历史快照仍保留');
    },
    onError: (error) => message.error(error.message),
  });

  const data = repositories.data?.data ?? [];
  const confirmedCount = data.filter((item) => item.whitelistStatus === 'confirmed').length;
  const changedCount = data.filter((item) => item.whitelistStatus === 'needs_review').length;

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>项目与仓库</Typography.Title>
          <Typography.Text type="secondary">
            一级目录发现只登记观测；确认路径、身份、远端和基线后才进入可写白名单。
          </Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<PlusOutlined />} onClick={() => setProjectModalOpen(true)}>
            新建业务项目
          </Button>
          <Button
            icon={<FileSearchOutlined />}
            loading={runOperation.isPending}
            onClick={() =>
              runOperation.mutate({ path: '/api/v1/projects/discover', label: '仓库发现' })
            }
          >
            扫描允许根目录
          </Button>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={runOperation.isPending}
            disabled={data.length === 0}
            onClick={() =>
              runOperation.mutate({ path: '/api/v1/repositories/sync', label: '本地状态刷新' })
            }
          >
            刷新全部
          </Button>
        </Space>
      </div>

      <div className="summary-grid">
        <Card>
          <Typography.Text type="secondary">已发现</Typography.Text>
          <Typography.Title level={3}>{data.length}</Typography.Title>
        </Card>
        <Card>
          <Typography.Text type="secondary">已确认白名单</Typography.Text>
          <Typography.Title level={3}>{confirmedCount}</Typography.Title>
        </Card>
        <Card>
          <Typography.Text type="secondary">身份待复核</Typography.Text>
          <Typography.Title level={3}>{changedCount}</Typography.Title>
        </Card>
      </div>

      <Alert
        showIcon
        icon={<SafetyCertificateOutlined />}
        type="info"
        message="白名单是写操作的硬边界"
        description="嵌套仓库、重解析点、bare 仓库和允许根目录以外的路径不会被登记；远端 URL 入库前会删除用户名和凭证。"
      />

      <Card>
        <Table<RepositoryView>
          rowKey="id"
          loading={repositories.isLoading}
          dataSource={data}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          expandable={{
            expandedRowRender: (record) => (
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="规范路径" span={2}>
                  {record.canonicalPath}
                </Descriptions.Item>
                <Descriptions.Item label="远端">
                  {record.remoteUrl ?? '未配置/不支持自动匹配'}
                </Descriptions.Item>
                <Descriptions.Item label="基线">
                  {record.baselineBranch ?? '待确认'}
                </Descriptions.Item>
                <Descriptions.Item label="Upstream">
                  {record.latestSnapshot?.upstreamRef ?? '无'}
                </Descriptions.Item>
                <Descriptions.Item label="Stash">
                  {record.latestSnapshot?.stashCount ?? 0}
                </Descriptions.Item>
                <Descriptions.Item label="最近提交" span={2}>
                  {record.latestSnapshot?.recentCommit.title ?? '无提交'}
                </Descriptions.Item>
                <Descriptions.Item label="GitLab 项目" span={2}>
                  {record.gitlabSummary ? (
                    <Typography.Link href={record.gitlabSummary.webUrl} target="_blank">
                      {record.gitlabSummary.pathWithNamespace}
                    </Typography.Link>
                  ) : record.gitlabMatchStatus === 'mismatch' ? (
                    <Typography.Text type="danger">远端已变化，必须重新确认匹配</Typography.Text>
                  ) : (
                    '尚未确认匹配'
                  )}
                </Descriptions.Item>
                {record.gitlabSummary && (
                  <>
                    <Descriptions.Item label="GitLab 默认分支">
                      {record.gitlabSummary.defaultBranch ?? '未返回'}
                    </Descriptions.Item>
                    <Descriptions.Item label="当前分支开放 MR">
                      {record.gitlabSummary.currentBranchMergeRequests.length > 0 ? (
                        <Space direction="vertical" size={0}>
                          {record.gitlabSummary.currentBranchMergeRequests.map((mergeRequest) => (
                            <Typography.Link
                              key={mergeRequest.iid}
                              href={mergeRequest.webUrl}
                              target="_blank"
                            >
                              !{mergeRequest.iid} {mergeRequest.title}
                            </Typography.Link>
                          ))}
                        </Space>
                      ) : (
                        0
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item label="最近远端提交" span={2}>
                      {record.gitlabSummary.latestCommit ? (
                        <Space direction="vertical" size={0}>
                          <Typography.Text>
                            {record.gitlabSummary.latestCommit.title}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {record.gitlabSummary.latestCommit.sha.slice(0, 8)} ·{' '}
                            {record.gitlabSummary.latestCommit.authorName}
                          </Typography.Text>
                        </Space>
                      ) : (
                        '当前同步窗口内无提交'
                      )}
                    </Descriptions.Item>
                  </>
                )}
                {record.gitlabSummary?.syncError && (
                  <Descriptions.Item label="GitLab 同步错误" span={2}>
                    <Typography.Text type="danger">
                      {record.gitlabSummary.syncError}
                    </Typography.Text>
                  </Descriptions.Item>
                )}
                {record.gitlabSummary && (
                  <Descriptions.Item label="GitLab 完整同步时间" span={2}>
                    {record.gitlabSummary.syncedAt
                      ? new Date(record.gitlabSummary.syncedAt).toLocaleString('zh-CN')
                      : '尚无完整成功快照'}
                  </Descriptions.Item>
                )}
              </Descriptions>
            ),
          }}
          columns={[
            {
              title: '项目 / 仓库',
              key: 'repository',
              render: (_, record) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>
                    <ApartmentOutlined /> {record.alias || record.displayName}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {record.project?.alias || record.project?.name || '未归属项目'}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '分支',
              key: 'branch',
              render: (_, record) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text>
                    <BranchesOutlined />{' '}
                    {record.latestSnapshot?.detached
                      ? 'detached HEAD'
                      : record.latestSnapshot?.branchName || 'unborn'}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    ↑{record.latestSnapshot?.aheadCount ?? 0} ↓
                    {record.latestSnapshot?.behindCount ?? 0}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '工作区',
              key: 'workspace',
              render: (_, record) => (
                <Space wrap size={[4, 4]}>
                  <Tag color={(record.latestSnapshot?.stagedCount ?? 0) > 0 ? 'blue' : 'default'}>
                    暂存 {record.latestSnapshot?.stagedCount ?? 0}
                  </Tag>
                  <Tag
                    color={(record.latestSnapshot?.unstagedCount ?? 0) > 0 ? 'orange' : 'default'}
                  >
                    修改 {record.latestSnapshot?.unstagedCount ?? 0}
                  </Tag>
                  <Tag>未跟踪 {record.latestSnapshot?.untrackedCount ?? 0}</Tag>
                  {(record.latestSnapshot?.conflictedCount ?? 0) > 0 && (
                    <Tag color="red">冲突 {record.latestSnapshot?.conflictedCount}</Tag>
                  )}
                </Space>
              ),
            },
            {
              title: 'GitLab',
              key: 'gitlab',
              render: (_, record) =>
                record.gitlabSummary ? (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>
                      MR {record.gitlabSummary.openMergeRequestCount} · 当前分支{' '}
                      {record.gitlabSummary.currentBranchMergeRequests.length}
                    </Typography.Text>
                    <StatusTag status={record.gitlabSummary.latestPipeline?.status ?? 'unknown'} />
                    <StatusTag status={record.gitlabSummary.syncStatus} />
                    {record.gitlabSummary.latestPipeline && (
                      <Tag
                        color={
                          record.gitlabSummary.latestPipeline.sha === record.latestSnapshot?.headSha
                            ? 'green'
                            : 'gold'
                        }
                      >
                        {record.gitlabSummary.latestPipeline.sha === record.latestSnapshot?.headSha
                          ? 'Pipeline 对应当前 HEAD'
                          : `Pipeline 对应 ${record.gitlabSummary.latestPipeline.ref ?? '其他 ref'} / ${record.gitlabSummary.latestPipeline.sha.slice(0, 8)}`}
                      </Tag>
                    )}
                  </Space>
                ) : record.gitlabMatchStatus === 'mismatch' ? (
                  <Tag color="red">远端变化，需复核</Tag>
                ) : record.gitlabCandidates.length > 0 ? (
                  <Tag color="gold">有精确候选待确认</Tag>
                ) : (
                  <Typography.Text type="secondary">无缓存匹配</Typography.Text>
                ),
            },
            {
              title: '状态 / 新鲜度',
              key: 'status',
              render: (_, record) => (
                <Space direction="vertical" size={2}>
                  <StatusTag status={record.whitelistStatus} />
                  <Tag color={record.freshness === 'fresh' ? 'green' : 'gold'}>
                    {record.freshness}
                  </Tag>
                  {record.statusReason && (
                    <Tooltip title={record.statusReason}>
                      <Typography.Text type="warning">查看原因</Typography.Text>
                    </Tooltip>
                  )}
                </Space>
              ),
            },
            {
              title: '操作',
              key: 'actions',
              render: (_, record) => (
                <Space wrap>
                  {record.whitelistStatus !== 'confirmed' &&
                    record.whitelistStatus !== 'disabled' && (
                      <Button
                        type="primary"
                        size="small"
                        onClick={() => {
                          setConfirming(record);
                          const values: ConfirmValues = {
                            displayName: record.displayName,
                            baselineBranch:
                              record.baselineBranch || record.latestSnapshot?.branchName || 'main',
                          };
                          if (record.alias) values.alias = record.alias;
                          if (record.project) values.projectId = record.project.id;
                          if (record.remoteName) values.remoteName = record.remoteName;
                          if (record.gitlabSummary)
                            values.gitlabProjectRef = record.gitlabSummary.id;
                          confirmForm.setFieldsValue(values);
                        }}
                      >
                        确认
                      </Button>
                    )}
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    onClick={() =>
                      runOperation.mutate({
                        path: `/api/v1/repositories/${record.id}/sync`,
                        label: `${record.displayName} 刷新`,
                      })
                    }
                  >
                    刷新
                  </Button>
                  {record.whitelistStatus === 'confirmed' && (
                    <Button
                      danger
                      size="small"
                      loading={disableRepository.isPending}
                      onClick={() => disableRepository.mutate(record)}
                    >
                      禁用
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="确认仓库白名单"
        open={Boolean(confirming)}
        onCancel={() => setConfirming(null)}
        okText="复核无误并确认"
        confirmLoading={confirmRepository.isPending}
        onOk={() =>
          void confirmForm.validateFields().then((values) => confirmRepository.mutate(values))
        }
      >
        <Form form={confirmForm} layout="vertical">
          <Form.Item label="显示名称" name="displayName" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="别名" name="alias">
            <Input />
          </Form.Item>
          <Form.Item label="业务项目" name="projectId">
            <Select
              allowClear
              options={(projects.data?.data ?? []).map((project) => ({
                value: project.id,
                label: project.alias || project.name,
              }))}
            />
          </Form.Item>
          <Form.Item label="默认远端" name="remoteName">
            <Select
              allowClear
              options={(confirming?.latestSnapshot?.remotes ?? []).map((remote) => ({
                value: remote.name,
                label: `${remote.name} · ${remote.sanitizedUrl ?? '本地/不支持匹配'}`,
              }))}
            />
          </Form.Item>
          <Form.Item
            label="GitLab 精确项目匹配"
            name="gitlabProjectRef"
            extra="只有主机和完整 namespace/project 路径完全一致的缓存项目可选。"
          >
            <Select
              allowClear
              options={(confirming?.gitlabCandidates ?? []).map((project) => ({
                value: project.id,
                label: `${project.pathWithNamespace} · #${project.externalId}`,
              }))}
              placeholder="可在 GitLab 同步后选择"
            />
          </Form.Item>
          <Form.Item label="基线分支" name="baselineBranch" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Alert
            type="warning"
            showIcon
            message="确认仅授权固定动作模型；不会开放 raw shell、任意 Git 参数或危险命令。"
          />
        </Form>
      </Modal>

      <Modal
        title="新建业务项目"
        open={projectModalOpen}
        onCancel={() => setProjectModalOpen(false)}
        confirmLoading={createProject.isPending}
        onOk={() =>
          void projectForm.validateFields().then((values) => createProject.mutate(values))
        }
      >
        <Form form={projectForm} layout="vertical">
          <Form.Item label="项目名称" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="项目别名" name="alias">
            <Input />
          </Form.Item>
          <Form.Item label="说明" name="description">
            <Input.TextArea rows={3} maxLength={2000} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
