import {
  ApartmentOutlined,
  BranchesOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Form,
  Input,
  List,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';
import { apiRequest } from '../api/client.js';
import type {
  ProjectSummary,
  RepositoryDiscoveryConfiguration,
  RepositoryDiscoveryResult,
  RepositoryDirectorySelection,
  RepositoryView,
} from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';
import {
  isRepositoryDiscoveryResult,
  repositoryPathEnvironmentLine,
  summarizeRepositoryDiscovery,
} from './repository-discovery-view-model.js';
import {
  type BrowserDirectoryPickerWindow,
  selectBrowserDirectory,
} from './repository-directory-picker.js';

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
  result?: unknown;
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
  const [discoveryModalOpen, setDiscoveryModalOpen] = useState(false);
  const [desiredHostRoot, setDesiredHostRoot] = useState('');
  const [browserSelectedDirectoryName, setBrowserSelectedDirectoryName] = useState<string | null>(
    null,
  );
  const [discoveryResult, setDiscoveryResult] = useState<RepositoryDiscoveryResult | null>(null);
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
  const discoveryConfig = useQuery({
    queryKey: ['repository-discovery-config'],
    queryFn: () =>
      apiRequest<RepositoryDiscoveryConfiguration>('/api/v1/repositories/discovery-config'),
    refetchInterval: discoveryModalOpen ? 5_000 : 30_000,
  });

  const waitForOperation = async (operation: OperationReference) => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const current = await apiRequest<OperationDetail>(operation.statusUrl);
      if (!['queued', 'running'].includes(current.data.status)) {
        if (current.data.status !== 'succeeded') {
          throw new Error(current.data.error?.message ?? `作业结束状态：${current.data.status}`);
        }
        return current.data.result;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new Error('作业仍在后台运行，可到“作业与审计”继续查看');
  };

  const runOperation = useMutation({
    mutationFn: async (input: { path: string; label: string; kind?: 'discover' | 'sync' }) => {
      const operation = await apiRequest<OperationReference>(input.path, {
        method: 'POST',
        body: '{}',
      });
      message.loading({ content: `${input.label}已进入持久化队列`, key: 'repository-operation' });
      const result = await waitForOperation(operation.data);
      return { label: input.label, result };
    },
    onSuccess: async ({ label, result }, input) => {
      await queryClient.invalidateQueries({ queryKey: ['repositories'] });
      if (input.kind === 'discover' && isRepositoryDiscoveryResult(result)) {
        setDiscoveryResult(result);
        message.success({
          content: summarizeRepositoryDiscovery(result),
          key: 'repository-operation',
        });
      } else {
        message.success({ content: `${label}完成`, key: 'repository-operation' });
      }
      await discoveryConfig.refetch();
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
      message.success('仓库配置已保存并启用');
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

  const nativeDirectoryPicker = useMutation({
    mutationFn: () =>
      apiRequest<RepositoryDirectorySelection>('/api/v1/repositories/directory-picker', {
        method: 'POST',
        body: JSON.stringify({ initialPath: desiredHostRoot || undefined }),
      }),
    onSuccess: ({ data: selection }) => {
      if (selection.status === 'selected') {
        setDesiredHostRoot(selection.path);
        setBrowserSelectedDirectoryName(null);
        message.success('已回填所选目录的完整路径');
      }
    },
    onError: (error) => message.error(error.message),
  });

  const data = repositories.data?.data ?? [];
  const confirmedCount = data.filter((item) => item.whitelistStatus === 'confirmed').length;
  const changedCount = data.filter((item) => item.whitelistStatus === 'needs_review').length;
  const configuredDiscovery = discoveryConfig.data?.data;
  const environmentLine = configuredDiscovery
    ? repositoryPathEnvironmentLine(configuredDiscovery.configurationKey, desiredHostRoot)
    : null;

  const openDiscoveryConfiguration = () => {
    setDesiredHostRoot(configuredDiscovery?.hostRoot ?? 'D:/company');
    setBrowserSelectedDirectoryName(null);
    setDiscoveryModalOpen(true);
  };

  const openRepositoryConfiguration = (repository: RepositoryView) => {
    confirmForm.resetFields();
    setConfirming(repository);
    const values: ConfirmValues = {
      displayName: repository.displayName,
      baselineBranch: repository.baselineBranch || repository.latestSnapshot?.branchName || 'main',
    };
    if (repository.alias) values.alias = repository.alias;
    if (repository.project) values.projectId = repository.project.id;
    if (repository.remoteName) values.remoteName = repository.remoteName;
    if (repository.gitlabSummary) values.gitlabProjectRef = repository.gitlabSummary.id;
    confirmForm.setFieldsValue(values);
  };

  const chooseHostDirectory = async () => {
    if (configuredDiscovery?.directoryPickerMode === 'native') {
      nativeDirectoryPicker.mutate();
      return;
    }
    try {
      const selection = await selectBrowserDirectory(
        window as unknown as BrowserDirectoryPickerWindow,
      );
      if (selection.status === 'cancelled') return;
      if (selection.status === 'unsupported') {
        Modal.info({
          title: '当前浏览器不支持目录选择',
          content:
            '请使用最新版 Edge 或 Chrome，或者从资源管理器地址栏复制完整目录并粘贴到输入框。',
        });
        return;
      }
      setBrowserSelectedDirectoryName(selection.displayName);
      if (selection.absolutePath) {
        setDesiredHostRoot(selection.absolutePath);
        message.success('已回填所选目录的完整路径');
        return;
      }
      Modal.info({
        title: `已选择目录“${selection.displayName}”`,
        content:
          '浏览器安全策略不允许网页读取该目录的绝对路径。请从资源管理器地址栏复制完整路径并粘贴到输入框；系统不会猜测磁盘位置。',
      });
    } catch {
      message.error('目录选择器打开失败，请手工粘贴完整路径');
    }
  };

  const copyConfiguration = async () => {
    if (!environmentLine) {
      message.error('路径不能为空，也不能包含换行或控制字符');
      return;
    }
    try {
      await navigator.clipboard.writeText(environmentLine);
      message.success('环境变量配置已复制');
    } catch {
      message.error('浏览器无法写入剪贴板，请手动复制配置内容');
    }
  };

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
          <Button icon={<SettingOutlined />} onClick={openDiscoveryConfiguration}>
            配置并扫描
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

      <Alert
        showIcon
        type={configuredDiscovery?.status === 'ready' ? 'success' : 'warning'}
        icon={<FolderOpenOutlined />}
        message={
          configuredDiscovery ? `扫描目录：${configuredDiscovery.hostRoot}` : '正在读取仓库扫描目录'
        }
        description={
          configuredDiscovery
            ? `${configuredDiscovery.statusMessage}；仅扫描一级子目录。容器内路径：${configuredDiscovery.configuredRoot}`
            : '请稍候，系统正在检查目录挂载和访问权限。'
        }
        action={
          <Button size="small" onClick={openDiscoveryConfiguration}>
            查看配置
          </Button>
        }
      />

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
                <Descriptions.Item label="任务摘要" span={2}>
                  {record.taskSummary.sourceStatus === 'unmapped'
                    ? '仓库尚未归属业务项目'
                    : record.taskSummary.sourceStatus === 'not_configured'
                      ? '业务项目尚未配置 Jira Key'
                      : record.taskSummary.sourceStatus === 'empty'
                        ? '当前项目尚无同步任务'
                        : `可见 ${record.taskSummary.visibleCount} · 进行中 ${record.taskSummary.counts.in_progress} · 阻塞 ${record.taskSummary.counts.blocked} · 完成 ${record.taskSummary.counts.done} · 逾期 ${record.taskSummary.overdueCount} · 本次查询不可见 ${record.taskSummary.notVisibleCount}`}
                </Descriptions.Item>
                {record.taskSummary.lastObservedAt && (
                  <Descriptions.Item label="任务最近观测" span={2}>
                    {new Date(record.taskSummary.lastObservedAt).toLocaleString('zh-CN')}
                  </Descriptions.Item>
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
                      : record.latestSnapshot?.branchName || record.baselineBranch || '待首次刷新'}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {record.latestSnapshot
                      ? `↑${record.latestSnapshot.aheadCount} ↓${record.latestSnapshot.behindCount}`
                      : '完整状态待刷新'}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '工作区',
              key: 'workspace',
              render: (_, record) =>
                record.latestSnapshot ? (
                  <Space wrap size={[4, 4]}>
                    <Tag color={record.latestSnapshot.stagedCount > 0 ? 'blue' : 'default'}>
                      暂存 {record.latestSnapshot.stagedCount}
                    </Tag>
                    <Tag color={record.latestSnapshot.unstagedCount > 0 ? 'orange' : 'default'}>
                      修改 {record.latestSnapshot.unstagedCount}
                    </Tag>
                    <Tag>未跟踪 {record.latestSnapshot.untrackedCount}</Tag>
                    {record.latestSnapshot.conflictedCount > 0 && (
                      <Tag color="red">冲突 {record.latestSnapshot.conflictedCount}</Tag>
                    )}
                  </Space>
                ) : (
                  <Tag color="gold">状态待刷新</Tag>
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
              title: '任务摘要',
              key: 'tasks',
              render: (_, record) => {
                if (record.taskSummary.sourceStatus === 'unmapped') {
                  return <Typography.Text type="secondary">未归属项目</Typography.Text>;
                }
                if (record.taskSummary.sourceStatus === 'not_configured') {
                  return <Typography.Text type="secondary">未配置 Jira Key</Typography.Text>;
                }
                if (record.taskSummary.sourceStatus === 'empty') {
                  return <Typography.Text type="secondary">暂无同步任务</Typography.Text>;
                }
                return (
                  <Space direction="vertical" size={2}>
                    <Typography.Text>
                      可见 {record.taskSummary.visibleCount} · 进行中{' '}
                      {record.taskSummary.counts.in_progress} · 完成{' '}
                      {record.taskSummary.counts.done}
                    </Typography.Text>
                    <Space wrap size={[4, 4]}>
                      {record.taskSummary.overdueCount > 0 && (
                        <Tag color="red">逾期 {record.taskSummary.overdueCount}</Tag>
                      )}
                      {record.taskSummary.counts.blocked > 0 && (
                        <Tag color="orange">阻塞 {record.taskSummary.counts.blocked}</Tag>
                      )}
                      <Tag color={record.taskSummary.sourceStatus === 'fresh' ? 'green' : 'gold'}>
                        {record.taskSummary.sourceStatus}
                      </Tag>
                    </Space>
                  </Space>
                );
              },
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
                  {record.whitelistStatus !== 'missing' && (
                    <Button
                      type={
                        ['discovered', 'needs_review'].includes(record.whitelistStatus)
                          ? 'primary'
                          : 'default'
                      }
                      size="small"
                      onClick={() => openRepositoryConfiguration(record)}
                    >
                      {record.whitelistStatus === 'disabled'
                        ? '重新启用'
                        : record.whitelistStatus === 'confirmed'
                          ? '配置'
                          : '确认'}
                    </Button>
                  )}
                  {!['disabled', 'missing'].includes(record.whitelistStatus) && (
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
                  )}
                  {record.whitelistStatus === 'confirmed' && (
                    <Popconfirm
                      title="确认禁用这个仓库？"
                      description="禁用后将移出可写白名单，但可以稍后重新启用并修改归属。"
                      okText="禁用"
                      cancelText="取消"
                      onConfirm={() => disableRepository.mutate(record)}
                    >
                      <Button danger size="small" loading={disableRepository.isPending}>
                        禁用
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="配置仓库扫描目录"
        open={discoveryModalOpen}
        width={760}
        onCancel={() => setDiscoveryModalOpen(false)}
        okText="开始扫描"
        cancelText="关闭"
        confirmLoading={runOperation.isPending}
        okButtonProps={{ disabled: configuredDiscovery?.status !== 'ready' }}
        onOk={() =>
          runOperation.mutate({
            path: '/api/v1/projects/discover',
            label: '仓库发现',
            kind: 'discover',
          })
        }
      >
        {configuredDiscovery ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Alert
              showIcon
              type={configuredDiscovery.status === 'ready' ? 'success' : 'warning'}
              message={configuredDiscovery.statusMessage}
              description={
                configuredDiscovery.status === 'ready'
                  ? '目录已经挂载且存在 Git 仓库候选，可以开始扫描。'
                  : '请按下方配置修改路径并重建容器，然后点击“重新检查”。'
              }
            />
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="部署方式">
                {configuredDiscovery.deploymentMode === 'docker' ? 'Docker' : '本机进程'}
              </Descriptions.Item>
              <Descriptions.Item label="扫描深度">仅一级子目录</Descriptions.Item>
              <Descriptions.Item label="宿主机目录" span={2}>
                <Typography.Text copyable>{configuredDiscovery.hostRoot}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="运行时目录" span={2}>
                <Typography.Text code>{configuredDiscovery.configuredRoot}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="一级目录">
                {configuredDiscovery.directoryCount}
              </Descriptions.Item>
              <Descriptions.Item label="Git 候选">
                {configuredDiscovery.gitCandidateCount}
              </Descriptions.Item>
            </Descriptions>

            <Divider plain>修改扫描目录</Divider>
            <Typography.Text strong>新的宿主机仓库根目录</Typography.Text>
            <Space.Compact block>
              <Input
                value={desiredHostRoot}
                onChange={(event) => {
                  setDesiredHostRoot(event.target.value);
                  setBrowserSelectedDirectoryName(null);
                }}
                placeholder="例如 D:/company"
              />
              <Button
                icon={<FolderOpenOutlined />}
                loading={nativeDirectoryPicker.isPending}
                onClick={() => void chooseHostDirectory()}
              >
                选择目录
              </Button>
            </Space.Compact>
            {browserSelectedDirectoryName && (
              <Alert
                type="warning"
                showIcon
                message={`浏览器已选择：${browserSelectedDirectoryName}`}
                description="浏览器未提供绝对路径，请从资源管理器地址栏复制完整路径到上方输入框。"
              />
            )}
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              扫描根目录同时是 Git 写操作白名单。Docker bind mount
              必须在容器启动前确定，网页不会挂载整块磁盘或访问任意目录。Docker
              模式的目录按钮由浏览器打开系统选择器，标准浏览器可能不会返回绝对路径。
            </Typography.Paragraph>
            {environmentLine && (
              <Typography.Paragraph code copyable={{ text: environmentLine }}>
                {environmentLine}
              </Typography.Paragraph>
            )}
            <Space wrap>
              <Button onClick={() => void copyConfiguration()}>复制环境变量</Button>
              <Button
                icon={<ReloadOutlined />}
                loading={discoveryConfig.isFetching}
                onClick={() => void discoveryConfig.refetch()}
              >
                重新检查
              </Button>
            </Space>
            <Alert
              type="info"
              showIcon
              message="保存到项目根目录 .env 后重建容器"
              description={
                <Typography.Text code>docker compose up -d --force-recreate</Typography.Text>
              }
            />

            {discoveryResult && (
              <>
                <Divider plain>最近一次扫描结果</Divider>
                <Alert
                  type={discoveryResult.warnings.length > 0 ? 'warning' : 'success'}
                  showIcon
                  message={summarizeRepositoryDiscovery(discoveryResult)}
                  description={`实际扫描根目录：${discoveryResult.root}`}
                />
                {discoveryResult.warnings.length > 0 && (
                  <List
                    size="small"
                    bordered
                    dataSource={discoveryResult.warnings.slice(0, 50)}
                    renderItem={(warning) => (
                      <List.Item>
                        <Space direction="vertical" size={0}>
                          <Typography.Text strong>{warning.directory}</Typography.Text>
                          <Typography.Text type="secondary">
                            {warning.code}：{warning.message}
                          </Typography.Text>
                        </Space>
                      </List.Item>
                    )}
                  />
                )}
              </>
            )}
          </Space>
        ) : (
          <Typography.Text type="secondary">正在读取扫描目录配置……</Typography.Text>
        )}
      </Modal>

      <Modal
        title={
          confirming?.whitelistStatus === 'disabled'
            ? '重新启用并配置仓库'
            : confirming?.whitelistStatus === 'confirmed'
              ? '配置仓库'
              : '确认仓库白名单'
        }
        open={Boolean(confirming)}
        onCancel={() => {
          setConfirming(null);
          confirmForm.resetFields();
        }}
        okText={confirming?.whitelistStatus === 'disabled' ? '保存并重新启用' : '保存配置'}
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
