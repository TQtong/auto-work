import {
  BranchesOutlined,
  CheckCircleOutlined,
  CloudOutlined,
  CodeOutlined,
  DeleteOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  message,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { apiRequest, type ApiEnvelope } from '../api/client.js';
import type {
  CreateBranchesResponse,
  DeleteBranchResponse,
  GitBranchView,
  RepositoryView,
} from '../api/types.js';

interface RepositoryPlan {
  repositoryId: string;
  baselineRef: string;
  branchNamesText: string;
}

interface DeleteBranchRequest {
  repositoryId: string;
  branch: GitBranchView;
}

export function GitBranchesPage() {
  const queryClient = useQueryClient();
  const [plans, setPlans] = useState<RepositoryPlan[]>([]);
  const [activeRepositoryId, setActiveRepositoryId] = useState<string>();
  const [lastResult, setLastResult] = useState<CreateBranchesResponse>();

  const repositories = useQuery({
    queryKey: ['repositories'],
    queryFn: () => apiRequest<RepositoryView[]>('/api/v1/repositories'),
    refetchInterval: 15_000,
  });
  const branchQueries = useQueries({
    queries: plans.map((plan) => ({
      queryKey: ['git-branches', plan.repositoryId],
      queryFn: () => apiRequest<GitBranchView[]>(`/api/v1/git/branches/${plan.repositoryId}`),
      staleTime: 15_000,
    })),
  });

  const confirmedRepositories = (repositories.data?.data ?? []).filter(
    (repository) => repository.whitelistStatus === 'confirmed',
  );
  const configuredIds = new Set(plans.map((plan) => plan.repositoryId));
  const repositoryById = new Map(
    confirmedRepositories.map((repository) => [repository.id, repository]),
  );
  const activePlanIndex = plans.findIndex((plan) => plan.repositoryId === activeRepositoryId);
  const activePlan = activePlanIndex >= 0 ? plans[activePlanIndex] : undefined;
  const activeRepository = activePlan ? repositoryById.get(activePlan.repositoryId) : undefined;
  const activeBranchQuery = activePlanIndex >= 0 ? branchQueries[activePlanIndex] : undefined;
  const allPlansValid =
    plans.length > 0 &&
    plans.every((plan, index) => {
      const branchCount = parseBranchNames(plan.branchNamesText).length;
      return (
        Boolean(plan.baselineRef) &&
        branchCount > 0 &&
        branchCount <= 50 &&
        branchQueries[index]?.isSuccess === true
      );
    });

  const createBranches = useMutation({
    mutationFn: () =>
      apiRequest<CreateBranchesResponse>('/api/v1/git/branches/batch', {
        method: 'POST',
        body: JSON.stringify({
          repositories: plans.map((plan) => ({
            repositoryId: plan.repositoryId,
            baselineRef: plan.baselineRef,
            branchNames: parseBranchNames(plan.branchNamesText),
          })),
        }),
      }),
    onSuccess: async (response) => {
      setLastResult(response.data);
      await Promise.all(
        plans.map((plan) =>
          queryClient.invalidateQueries({ queryKey: ['git-branches', plan.repositoryId] }),
        ),
      );
      const {
        repositories: repositoryCount,
        created,
        alreadyExists,
        failed,
      } = response.data.summary;
      if (failed > 0) {
        message.warning(`${repositoryCount} 个仓库执行完成：创建 ${created} 个，失败 ${failed} 个`);
      } else if (created > 0) {
        message.success(`${repositoryCount} 个仓库共创建 ${created} 个分支`);
      } else {
        message.info(`${alreadyExists} 个分支均已存在，无需重复创建`);
      }
    },
    onError: (error) => message.error(error.message),
  });

  const deleteBranch = useMutation({
    mutationFn: ({ repositoryId, branch }: DeleteBranchRequest) =>
      apiRequest<DeleteBranchResponse>('/api/v1/git/branches/delete', {
        method: 'POST',
        body: JSON.stringify({
          repositoryId,
          branchName: branch.name,
          expectedOid: branch.oid,
        }),
      }),
    onSuccess: async (response, request) => {
      setPlans((current) =>
        current.map((plan) => {
          if (plan.repositoryId !== request.repositoryId) return plan;
          return {
            ...plan,
            baselineRef: plan.baselineRef === request.branch.fullName ? '' : plan.baselineRef,
            branchNamesText: plan.branchNamesText
              .split(/\r?\n/u)
              .filter((name) => name.trim() !== request.branch.name)
              .join('\n'),
          };
        }),
      );
      setLastResult(undefined);
      await queryClient.invalidateQueries({
        queryKey: ['git-branches', request.repositoryId],
      });
      message.success(response.data.message);
    },
    onError: (error) => message.error(error.message),
  });

  const setRepositorySelected = (repositoryId: string, selected: boolean) => {
    if (selected) {
      setPlans((current) =>
        current.some((plan) => plan.repositoryId === repositoryId)
          ? current
          : [...current, { repositoryId, baselineRef: '', branchNamesText: '' }],
      );
      setActiveRepositoryId(repositoryId);
    } else {
      const remaining = plans.filter((plan) => plan.repositoryId !== repositoryId);
      setPlans(remaining);
      setActiveRepositoryId((current) =>
        current === repositoryId ? remaining[0]?.repositoryId : current,
      );
    }
    setLastResult(undefined);
  };

  const updatePlan = (repositoryId: string, patch: Partial<RepositoryPlan>) => {
    setPlans((current) =>
      current.map((plan) => (plan.repositoryId === repositoryId ? { ...plan, ...patch } : plan)),
    );
    setLastResult(undefined);
  };

  return (
    <Space direction="vertical" size="large" className="page-stack git-branches-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Git 分支管理</Typography.Title>
          <Typography.Text type="secondary">
            从左侧选择仓库，在右侧逐个配置；完成后可一次性创建所有选中仓库的本地分支。
          </Typography.Text>
        </div>
        <Tag icon={<BranchesOutlined />} color="blue">
          跨仓库批量创建
        </Tag>
      </div>

      <div className="git-branches-workbench">
        <Card
          className="repository-selector-card"
          title="配置好的仓库"
          loading={repositories.isLoading}
          extra={<Tag color="blue">已选 {plans.length}</Tag>}
        >
          <Typography.Paragraph type="secondary" className="repository-selector-help">
            勾选仓库加入批量任务，点击已选仓库可切换右侧内容。
          </Typography.Paragraph>
          {confirmedRepositories.length === 0 && !repositories.isLoading ? (
            <Alert
              showIcon
              type="warning"
              message="暂无已确认仓库"
              description="请先到“项目与仓库”中发现并确认仓库。"
            />
          ) : (
            <div className="repository-selector-list" aria-label="配置好的仓库">
              {confirmedRepositories.map((repository) => {
                const checked = configuredIds.has(repository.id);
                const active = activeRepositoryId === repository.id;
                const plan = plans.find((item) => item.repositoryId === repository.id);
                const branchCount = parseBranchNames(plan?.branchNamesText ?? '').length;
                const planReady =
                  Boolean(plan?.baselineRef) && branchCount > 0 && branchCount <= 50;
                return (
                  <div
                    key={repository.id}
                    role="button"
                    tabIndex={0}
                    className={`repository-selector-item${active ? ' is-active' : ''}`}
                    onClick={() => {
                      if (checked) setActiveRepositoryId(repository.id);
                      else setRepositorySelected(repository.id, true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      if (checked) setActiveRepositoryId(repository.id);
                      else setRepositorySelected(repository.id, true);
                    }}
                  >
                    <Checkbox
                      checked={checked}
                      aria-label={`选择仓库 ${repository.alias ?? repository.displayName}`}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        setRepositorySelected(repository.id, event.target.checked)
                      }
                    />
                    <div className="repository-selector-copy">
                      <Typography.Text strong ellipsis={{ tooltip: repository.displayName }}>
                        {repository.alias ?? repository.displayName}
                      </Typography.Text>
                      <Typography.Text
                        type="secondary"
                        ellipsis={{ tooltip: repository.canonicalPath }}
                      >
                        {repository.project?.alias ??
                          repository.project?.name ??
                          repository.canonicalPath}
                      </Typography.Text>
                    </div>
                    {checked && (
                      <Tag color={planReady ? 'success' : 'default'}>
                        {planReady ? `${branchCount} 个` : '待配置'}
                      </Tag>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <div className="git-branches-detail">
          {!activePlan ? (
            <Card className="repository-detail-empty">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="请从左侧勾选一个仓库查看并配置分支"
              />
            </Card>
          ) : (
            <RepositoryBranchPanel
              plan={activePlan}
              repository={activeRepository}
              query={activeBranchQuery}
              deletingBranch={
                deleteBranch.isPending &&
                deleteBranch.variables?.repositoryId === activePlan.repositoryId
                  ? deleteBranch.variables.branch.fullName
                  : null
              }
              onUpdate={(patch) => updatePlan(activePlan.repositoryId, patch)}
              onDelete={(branch) =>
                deleteBranch.mutate({ repositoryId: activePlan.repositoryId, branch })
              }
            />
          )}

          {plans.length > 0 && (
            <Card className="branch-submit-card">
              <Alert
                showIcon
                type="info"
                message={`已选择 ${plans.length} 个仓库。执行时只新增本地分支，不会切换当前分支、修改文件或推送远程。`}
              />
              <Button
                type="primary"
                size="large"
                icon={<BranchesOutlined />}
                loading={createBranches.isPending}
                disabled={!allPlansValid}
                onClick={() => createBranches.mutate()}
              >
                在全部 {plans.length} 个仓库中创建分支
              </Button>
            </Card>
          )}
        </div>
      </div>

      {lastResult && (
        <Card title="本次创建结果">
          <Alert
            showIcon
            type={lastResult.summary.failed > 0 ? 'warning' : 'success'}
            icon={lastResult.summary.failed === 0 ? <CheckCircleOutlined /> : undefined}
            message={`${lastResult.summary.repositories} 个仓库：创建 ${lastResult.summary.created} 个，已存在 ${lastResult.summary.alreadyExists} 个，失败 ${lastResult.summary.failed} 个`}
          />
          <Table<CreateBranchesResponse['repositories'][number]>
            className="branch-result-table"
            rowKey="repositoryId"
            pagination={false}
            dataSource={lastResult.repositories}
            expandable={{
              expandedRowRender: (result) => (
                <Table
                  size="small"
                  rowKey="branchName"
                  pagination={false}
                  dataSource={result.results}
                  columns={[
                    { title: '分支', dataIndex: 'branchName' },
                    {
                      title: '结果',
                      dataIndex: 'status',
                      width: 120,
                      render: branchResultTag,
                    },
                    { title: '说明', dataIndex: 'message' },
                  ]}
                />
              ),
            }}
            columns={[
              {
                title: '仓库',
                render: (_, result) =>
                  repositoryById.get(result.repositoryId)?.alias ??
                  repositoryById.get(result.repositoryId)?.displayName ??
                  result.repositoryId,
              },
              {
                title: '基准',
                render: (_, result) => result.baseline?.name ?? '未执行',
              },
              {
                title: '结果',
                render: (_, result) =>
                  `创建 ${result.summary.created} / 已存在 ${result.summary.alreadyExists} / 失败 ${result.summary.failed}`,
              },
              {
                title: '状态',
                width: 120,
                render: (_, result) => (
                  <Tag color={result.status === 'completed' ? 'success' : 'error'}>
                    {result.status === 'completed'
                      ? '完成'
                      : result.status === 'partial_failed'
                        ? '部分失败'
                        : '失败'}
                  </Tag>
                ),
              },
            ]}
          />
        </Card>
      )}
    </Space>
  );
}

function RepositoryBranchPanel(props: {
  plan: RepositoryPlan;
  repository: RepositoryView | undefined;
  query: UseQueryResult<ApiEnvelope<GitBranchView[]>, Error> | undefined;
  deletingBranch: string | null;
  onUpdate: (patch: Partial<RepositoryPlan>) => void;
  onDelete: (branch: GitBranchView) => void;
}) {
  const branches = props.query?.data?.data ?? [];
  const branchCount = parseBranchNames(props.plan.branchNamesText).length;
  return (
    <Card
      className="repository-branch-panel"
      title={
        <Space>
          <BranchesOutlined />
          <span>
            {props.repository?.alias ?? props.repository?.displayName ?? props.plan.repositoryId}
          </span>
          {props.repository?.project && (
            <Tag>{props.repository.project.alias ?? props.repository.project.name}</Tag>
          )}
        </Space>
      }
    >
      {props.query?.isError && (
        <Alert
          showIcon
          type="error"
          message="分支加载失败"
          description={props.query.error?.message}
          action={
            <Button size="small" onClick={() => void props.query?.refetch()}>
              重试
            </Button>
          }
        />
      )}
      <div className="form-grid repository-branch-fields">
        <div>
          <Typography.Text strong>基准分支</Typography.Text>
          <Select<string>
            showSearch
            {...(props.plan.baselineRef ? { value: props.plan.baselineRef } : {})}
            optionFilterProp="label"
            loading={props.query?.isLoading === true}
            placeholder="选择本地或远程分支"
            onChange={(baselineRef) => props.onUpdate({ baselineRef })}
            options={branches.map((branch) => ({
              value: branch.fullName,
              label: `${branch.name} · ${branch.scope === 'local' ? '本地' : '远程'} · ${formatTime(branch.updatedAt)}`,
            }))}
          />
          {!props.plan.baselineRef && (
            <Typography.Text type="danger" className="branch-field-error">
              请选择基准分支
            </Typography.Text>
          )}
        </div>
        <div>
          <Typography.Text strong>新分支名称（每行一个，最多 50 个）</Typography.Text>
          <Input.TextArea
            rows={5}
            value={props.plan.branchNamesText}
            maxLength={12_800}
            {...(branchCount === 0 || branchCount > 50 ? { status: 'error' as const } : {})}
            placeholder={'feature/task-101\nfeature/task-102\nfix/login-timeout'}
            onChange={(event) => props.onUpdate({ branchNamesText: event.target.value })}
          />
          <Typography.Text
            type={branchCount === 0 || branchCount > 50 ? 'danger' : 'secondary'}
            className="branch-field-error"
          >
            {branchCount === 0
              ? '请输入至少一个新分支名称'
              : branchCount > 50
                ? `已输入 ${branchCount} 个，一次最多 50 个`
                : `已配置 ${branchCount} 个新分支`}
          </Typography.Text>
        </div>
      </div>

      <div className="repository-branch-list-heading">
        <Typography.Text strong>全部分支（{branches.length}）</Typography.Text>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={props.query?.isFetching === true}
          onClick={() => void props.query?.refetch()}
        >
          刷新
        </Button>
      </div>
      <Table<GitBranchView>
        size="small"
        rowKey="fullName"
        loading={props.query?.isLoading === true}
        dataSource={branches}
        pagination={{ pageSize: 8, hideOnSinglePage: true }}
        locale={{ emptyText: '该仓库暂无分支' }}
        columns={branchColumns({
          deletingBranch: props.deletingBranch,
          onDelete: props.onDelete,
        })}
      />
    </Card>
  );
}

function branchColumns(input: {
  deletingBranch: string | null;
  onDelete: (branch: GitBranchView) => void;
}) {
  return [
    {
      title: '分支',
      render: (_: unknown, branch: GitBranchView) => (
        <Space>
          <Typography.Text strong>{branch.name}</Typography.Text>
          {branch.current && <Tag color="processing">当前</Tag>}
        </Space>
      ),
    },
    {
      title: '位置',
      width: 100,
      render: (_: unknown, branch: GitBranchView) =>
        branch.scope === 'local' ? (
          <Tag icon={<CodeOutlined />}>本地</Tag>
        ) : (
          <Tag icon={<CloudOutlined />} color="cyan">
            远程
          </Tag>
        ),
    },
    {
      title: '最近提交',
      render: (_: unknown, branch: GitBranchView) => (
        <Space direction="vertical" size={0}>
          <Typography.Text ellipsis={{ tooltip: branch.subject }}>
            {branch.subject || '无提交说明'}
          </Typography.Text>
          <Typography.Text type="secondary" code>
            {branch.oid.slice(0, 8)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '更新时间',
      width: 160,
      render: (_: unknown, branch: GitBranchView) => formatTime(branch.updatedAt),
    },
    {
      title: '操作',
      width: 120,
      render: (_: unknown, branch: GitBranchView) => {
        if (branch.scope === 'remote') return <Typography.Text type="secondary">—</Typography.Text>;
        if (branch.current)
          return <Typography.Text type="secondary">当前分支不可删</Typography.Text>;
        return (
          <Popconfirm
            title={`删除本地分支 ${branch.name}？`}
            description="将删除该本地分支引用，不会影响远程同名分支。"
            okText="确认删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => input.onDelete(branch)}
          >
            <Button
              type="link"
              danger
              size="small"
              icon={<DeleteOutlined />}
              loading={input.deletingBranch === branch.fullName}
            >
              删除
            </Button>
          </Popconfirm>
        );
      },
    },
  ];
}

function branchResultTag(status: string) {
  return (
    <Tag color={status === 'created' ? 'success' : status === 'failed' ? 'error' : 'default'}>
      {status === 'created' ? '已创建' : status === 'failed' ? '失败' : '已存在'}
    </Tag>
  );
}

function parseBranchNames(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((branch) => branch.trim())
        .filter(Boolean),
    ),
  ];
}

function formatTime(value: string): string {
  const time = dayjs(value);
  return time.isValid() ? time.format('YYYY-MM-DD HH:mm') : '未知';
}
