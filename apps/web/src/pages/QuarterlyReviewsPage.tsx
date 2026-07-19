import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  DownloadOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FileAddOutlined,
  HistoryOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Progress,
  Radio,
  Result,
  Segmented,
  Select,
  Space,
  Statistic,
  Steps,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiDownload, apiRequest } from '../api/client.js';
import type {
  Integration,
  Job,
  ProjectSummary,
  QuarterlyAchievement,
  QuarterlyAchievementStatus,
  QuarterlyAiGeneration,
  QuarterlyAiGenerationList,
  QuarterlyCollectionSnapshot,
  QuarterlyCompleteness,
  QuarterlyConfirmationPreflight,
  QuarterlyExportArtifact,
  QuarterlyFormulaType,
  QuarterlyMetric,
  QuarterlyMetricTemplateListItem,
  QuarterlyNarrativeContent,
  QuarterlyNarrativeVersion,
  QuarterlyReview,
  QuarterlyReviewConfirmation,
  QuarterlyReviewList,
  QuarterlyReviewSummary,
  QuarterlyRoundingRule,
  QuarterlyScoreItem,
} from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';
import {
  achievementCoverage,
  buildQuarterlyScorePreview,
  canDownloadQuarterlyExport,
  confirmationReadiness,
  formatFileSize,
  quarterlyWorkflowItems,
  quarterlyWorkflowStep,
} from './quarterly-review-view-model.js';

interface CreateReviewValues {
  periodType: 'natural_quarter' | 'custom';
  year: number;
  quarter: 1 | 2 | 3 | 4;
  name?: string;
  period?: [Dayjs, Dayjs];
}

interface CollectValues {
  sources: Array<'tasks' | 'evidence' | 'confirmedWeeklyReports'>;
  freshnessMode: 'require_fresh' | 'allow_stale';
  maximumAgeHours: number;
}

interface AchievementValues {
  projectId?: string;
  title: string;
  situation: string;
  action: string;
  result: string;
  impact: string;
  contributionBoundary: string;
  period: [Dayjs, Dayjs];
  changeReason?: string;
}

interface EvidenceValues {
  title: string;
  externalKey?: string;
  url?: string;
  eventAt?: Dayjs;
  availabilityState: 'available' | 'unavailable' | 'unknown';
  summary?: string;
  contributionAngle: string;
  primaryEvidence: boolean;
}

interface MappingValues {
  links: Array<{ metricId: string; contribution: string }>;
}

interface TemplateValues {
  name: string;
  formulaType: QuarterlyFormulaType;
  roundingRule: QuarterlyRoundingRule;
  metrics: Array<{
    code: string;
    name: string;
    definition: string;
    weight: number;
    minimum: number;
    maximum: number;
    step: number;
    required: boolean;
    enabled: boolean;
    minimumEvidence: number;
  }>;
}

interface ScoreValues {
  scores: Array<{ metricId: string; userScore: number | null; userReason: string | null }>;
}

interface NarrativeValues extends QuarterlyNarrativeContent {
  changeReason: string;
}

interface SelectionValues {
  status: QuarterlyAchievementStatus;
  reason: string;
}

interface DecisionValues {
  reason: string;
}

type NarrativeDecision =
  | { kind: 'restore'; version: QuarterlyNarrativeVersion }
  | { kind: 'adopt'; generation: QuarterlyAiGeneration }
  | { kind: 'reject'; generation: QuarterlyAiGeneration };

const formulaLabels: Record<QuarterlyFormulaType, string> = {
  weighted_average_100: '加权平均（权重合计 100%）',
  weighted_sum: '加权求和',
  simple_sum: '简单求和',
};

const roundingLabels: Record<QuarterlyRoundingRule, string> = {
  none: '不取整',
  half_up_integer: '四舍五入到整数',
  half_up_1_decimal: '四舍五入到 1 位小数',
  floor_integer: '向下取整',
  ceil_integer: '向上取整',
};

const selectionLabels: Record<QuarterlyAchievementStatus, string> = {
  candidate: '待处理',
  selected: '已选',
  excluded: '已排除',
  needs_evidence: '证据不足',
};

const narrativeOriginLabels: Record<string, string> = {
  rule: '规则生成',
  manual: '人工版本',
  ai: 'AI 候选',
};

export function QuarterlyReviewsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const requestedReviewId = searchParams.get('reviewId');
  const [messageApi, holder] = message.useMessage();
  const [createForm] = Form.useForm<CreateReviewValues>();
  const [collectForm] = Form.useForm<CollectValues>();
  const [achievementForm] = Form.useForm<AchievementValues>();
  const [evidenceForm] = Form.useForm<EvidenceValues>();
  const [mappingForm] = Form.useForm<MappingValues>();
  const [templateForm] = Form.useForm<TemplateValues>();
  const [scoreForm] = Form.useForm<ScoreValues>();
  const [narrativeForm] = Form.useForm<NarrativeValues>();
  const [selectionForm] = Form.useForm<SelectionValues>();
  const [decisionForm] = Form.useForm<DecisionValues>();
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(requestedReviewId);
  const [activeStep, setActiveStep] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const [achievementOpen, setAchievementOpen] = useState(false);
  const [editingAchievement, setEditingAchievement] = useState<QuarterlyAchievement | null>(null);
  const [evidenceAchievement, setEvidenceAchievement] = useState<QuarterlyAchievement | null>(null);
  const [mappingAchievement, setMappingAchievement] = useState<QuarterlyAchievement | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [narrativeOpen, setNarrativeOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [selectedAchievementIds, setSelectedAchievementIds] = useState<React.Key[]>([]);
  const [narrativeDecision, setNarrativeDecision] = useState<NarrativeDecision | null>(null);
  const [selectedAiGenerationId, setSelectedAiGenerationId] = useState<string | null>(null);
  const [selectedExportId, setSelectedExportId] = useState<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [acknowledgementReasons, setAcknowledgementReasons] = useState<Record<string, string>>({});
  const [achievementStatusFilter, setAchievementStatusFilter] = useState<
    QuarterlyAchievementStatus | 'all'
  >('all');
  const [evidenceFilter, setEvidenceFilter] = useState<
    'all' | 'complete' | 'partial' | 'needs_evidence'
  >('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [achievementSourceFilter, setAchievementSourceFilter] = useState<
    'all' | 'collected' | 'manual'
  >('all');
  const [evidenceSourceFilter, setEvidenceSourceFilter] = useState('all');
  const [metricFilter, setMetricFilter] = useState('all');
  const [monthFilter, setMonthFilter] = useState<Dayjs | null>(null);
  const [draggedAchievementId, setDraggedAchievementId] = useState<string | null>(null);

  const reviews = useQuery({
    queryKey: ['quarterly-reviews'],
    queryFn: () => apiRequest<QuarterlyReviewList>('/api/v1/quarterly-reviews?limit=100'),
  });
  const templates = useQuery({
    queryKey: ['quarterly-metric-templates'],
    queryFn: () =>
      apiRequest<QuarterlyMetricTemplateListItem[]>('/api/v1/quarterly-reviews/metric-templates'),
  });
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiRequest<Integration[]>('/api/v1/integrations'),
  });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiRequest<ProjectSummary[]>('/api/v1/projects'),
  });
  const detail = useQuery({
    queryKey: ['quarterly-review', selectedReviewId],
    queryFn: () => apiRequest<QuarterlyReview>(`/api/v1/quarterly-reviews/${selectedReviewId}`),
    enabled: Boolean(selectedReviewId),
    refetchInterval: 3_000,
  });
  const achievementQuery = useInfiniteQuery({
    queryKey: [
      'quarterly-achievements',
      selectedReviewId,
      achievementStatusFilter,
      evidenceFilter,
      projectFilter,
      achievementSourceFilter,
      evidenceSourceFilter,
      metricFilter,
      monthFilter?.format('YYYY-MM') ?? null,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ limit: '200' });
      if (achievementStatusFilter !== 'all') search.set('status', achievementStatusFilter);
      if (evidenceFilter !== 'all') search.set('evidenceStatus', evidenceFilter);
      if (projectFilter !== 'all') search.set('projectId', projectFilter);
      if (achievementSourceFilter !== 'all') search.set('sourceType', achievementSourceFilter);
      if (evidenceSourceFilter !== 'all') search.set('evidenceSourceType', evidenceSourceFilter);
      if (metricFilter !== 'all') search.set('metricId', metricFilter);
      if (monthFilter) search.set('month', monthFilter.format('YYYY-MM'));
      if (pageParam) search.set('cursor', pageParam);
      return apiRequest<QuarterlyAchievement[]>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/achievements?${search.toString()}`,
      );
    },
    getNextPageParam: (lastPage) =>
      lastPage.page?.hasMore ? (lastPage.page.nextCursor ?? null) : undefined,
    enabled: Boolean(selectedReviewId),
  });
  const allAchievementsQuery = useInfiniteQuery({
    queryKey: ['quarterly-achievements-all', selectedReviewId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ limit: '200' });
      if (pageParam) search.set('cursor', pageParam);
      return apiRequest<QuarterlyAchievement[]>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/achievements?${search.toString()}`,
      );
    },
    getNextPageParam: (lastPage) =>
      lastPage.page?.hasMore ? (lastPage.page.nextCursor ?? null) : undefined,
    enabled: Boolean(selectedReviewId),
  });
  const snapshots = useQuery({
    queryKey: ['quarterly-collection-snapshots', selectedReviewId],
    queryFn: () =>
      apiRequest<QuarterlyCollectionSnapshot[]>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/collection-snapshots?limit=20`,
      ),
    enabled: Boolean(selectedReviewId),
    refetchInterval: detail.data?.data.status === 'collecting' ? 2_000 : false,
  });
  const narratives = useQuery({
    queryKey: ['quarterly-narratives', selectedReviewId],
    queryFn: () =>
      apiRequest<QuarterlyNarrativeVersion[]>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/narratives`,
      ),
    enabled: Boolean(selectedReviewId),
  });
  const currentNarrative = useQuery({
    queryKey: [
      'quarterly-narrative',
      selectedReviewId,
      detail.data?.data.currentNarrativeVersionId,
    ],
    queryFn: () =>
      apiRequest<QuarterlyNarrativeVersion>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/narratives/${detail.data?.data.currentNarrativeVersionId}`,
      ),
    enabled: Boolean(selectedReviewId && detail.data?.data.currentNarrativeVersionId),
  });
  const aiGenerations = useQuery({
    queryKey: ['quarterly-ai-generations', selectedReviewId],
    queryFn: () =>
      apiRequest<QuarterlyAiGenerationList>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/ai-generations`,
      ),
    enabled: Boolean(selectedReviewId),
  });
  const selectedAiGeneration = useQuery({
    queryKey: ['quarterly-ai-generation', selectedReviewId, selectedAiGenerationId],
    queryFn: () =>
      apiRequest<QuarterlyAiGeneration>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/ai-generations/${selectedAiGenerationId}`,
      ),
    enabled: Boolean(selectedReviewId && selectedAiGenerationId),
  });
  const preflight = useQuery({
    queryKey: [
      'quarterly-confirmation-preflight',
      selectedReviewId,
      detail.data?.data.currentNarrativeVersionId,
    ],
    queryFn: () => {
      const narrativeId = detail.data?.data.currentNarrativeVersionId;
      const search = narrativeId ? `?narrativeVersionId=${encodeURIComponent(narrativeId)}` : '';
      return apiRequest<QuarterlyConfirmationPreflight>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/confirmation-preflight${search}`,
      );
    },
    enabled: Boolean(selectedReviewId && detail.data?.data.currentNarrativeVersionId),
  });
  const confirmations = useQuery({
    queryKey: ['quarterly-confirmations', selectedReviewId],
    queryFn: () =>
      apiRequest<QuarterlyReviewConfirmation[]>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/confirmations`,
      ),
    enabled: Boolean(selectedReviewId),
  });
  const exportsQuery = useQuery({
    queryKey: ['quarterly-exports', selectedReviewId],
    queryFn: () =>
      apiRequest<QuarterlyExportArtifact[]>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/exports`,
      ),
    enabled: Boolean(selectedReviewId),
    refetchInterval: 2_000,
  });
  const selectedExport = useQuery({
    queryKey: ['quarterly-export', selectedReviewId, selectedExportId],
    queryFn: () =>
      apiRequest<QuarterlyExportArtifact>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/exports/${selectedExportId}`,
      ),
    enabled: Boolean(selectedReviewId && selectedExportId),
  });
  const collectionJobs = useQuery({
    queryKey: ['quarterly-collection-jobs', selectedReviewId],
    queryFn: () => apiRequest<Job[]>('/api/v1/operations?type=quarterly-review.collect&limit=100'),
    enabled: Boolean(selectedReviewId),
    refetchInterval: 2_000,
  });

  useEffect(() => {
    const items = reviews.data?.data.items ?? [];
    const requested = requestedReviewId
      ? items.find((review) => review.id === requestedReviewId)
      : undefined;
    if (requested && selectedReviewId !== requested.id) {
      setSelectedReviewId(requested.id);
      setActiveStep(quarterlyWorkflowStep(requested));
      return;
    }
    const selectedExists = selectedReviewId
      ? items.some((review) => review.id === selectedReviewId)
      : false;
    const first = items[0];
    if ((!selectedReviewId || !selectedExists) && first) {
      setSelectedReviewId(first.id);
      setActiveStep(quarterlyWorkflowStep(first));
    }
  }, [requestedReviewId, reviews.data, selectedReviewId]);

  useEffect(() => {
    // 切换筛选后清除隐藏行选择，避免用户误以为未显示的旧行仍会进入批量动作。
    setSelectedAchievementIds([]);
  }, [
    achievementSourceFilter,
    achievementStatusFilter,
    evidenceFilter,
    evidenceSourceFilter,
    metricFilter,
    monthFilter,
    projectFilter,
  ]);

  useEffect(() => {
    const review = detail.data?.data;
    if (!review?.metricTemplate) return;
    const scoreByMetric = new Map(review.scores.map((score) => [score.metricId, score]));
    scoreForm.setFieldsValue({
      scores: review.metricTemplate.metrics.map((metric) => ({
        metricId: metric.id,
        userScore: scoreByMetric.get(metric.id)?.userScore ?? null,
        userReason: scoreByMetric.get(metric.id)?.userReason ?? null,
      })),
    });
  }, [detail.data?.data.id, detail.data?.data.version, scoreForm]);

  const review = detail.data?.data;
  const achievements = achievementQuery.data?.pages.flatMap((page) => page.data) ?? [];
  const allReviewAchievements = useMemo(
    () => allAchievementsQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [allAchievementsQuery.data],
  );
  const selectedAchievements = allReviewAchievements.filter(
    (achievement) => achievement.selectionStatus === 'selected',
  );
  const aiProviders = (integrations.data?.data ?? []).filter(
    (integration) =>
      integration.type === 'ai' && integration.enabled && integration.status === 'healthy',
  );
  const coverage = achievementCoverage(
    allReviewAchievements,
    review?.metricTemplate?.metrics ?? [],
  );
  const watchedScores = Form.useWatch('scores', scoreForm) ?? [];
  const liveScores = useMemo(() => {
    if (!review?.metricTemplate) return [];
    const persisted = new Map(review.scores.map((score) => [score.metricId, score]));
    return review.metricTemplate.metrics.map((metric, index) => ({
      ...(persisted.get(metric.id) ?? emptyScore(metric.id)),
      metricId: metric.id,
      userScore: watchedScores[index]?.userScore ?? null,
      userReason: watchedScores[index]?.userReason ?? null,
    }));
  }, [review, watchedScores]);
  const scorePreview = review?.metricTemplate
    ? buildQuarterlyScorePreview(review.metricTemplate, liveScores)
    : null;
  const latestCollectionJob = (collectionJobs.data?.data ?? []).find(
    (job) => job.payloadSummary.reviewId === selectedReviewId,
  );

  useEffect(() => {
    // 映射、评分和自评必须看到完整成果集；无筛选查询按游标自动续页，不能静默只取前 200 项。
    if (allAchievementsQuery.hasNextPage && !allAchievementsQuery.isFetchingNextPage) {
      void allAchievementsQuery.fetchNextPage();
    }
  }, [
    allAchievementsQuery.dataUpdatedAt,
    allAchievementsQuery.fetchNextPage,
    allAchievementsQuery.hasNextPage,
    allAchievementsQuery.isFetchingNextPage,
  ]);

  async function refreshReview(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['quarterly-reviews'] }),
      queryClient.invalidateQueries({ queryKey: ['quarterly-review', selectedReviewId] }),
      queryClient.invalidateQueries({ queryKey: ['quarterly-achievements'] }),
      queryClient.invalidateQueries({ queryKey: ['quarterly-achievements-all'] }),
      queryClient.invalidateQueries({ queryKey: ['quarterly-collection-snapshots'] }),
      queryClient.invalidateQueries({ queryKey: ['quarterly-narratives'] }),
      queryClient.invalidateQueries({ queryKey: ['quarterly-narrative'] }),
      queryClient.invalidateQueries({ queryKey: ['quarterly-ai-generations'] }),
      queryClient.invalidateQueries({ queryKey: ['quarterly-confirmation-preflight'] }),
      queryClient.invalidateQueries({ queryKey: ['quarterly-confirmations'] }),
      queryClient.invalidateQueries({ queryKey: ['quarterly-exports'] }),
    ]);
  }

  function showError(error: unknown): void {
    void messageApi.error(error instanceof Error ? error.message : '操作失败，请刷新后重试');
  }

  const createReview = useMutation({
    mutationFn: async (values: CreateReviewValues) => {
      const body =
        values.periodType === 'natural_quarter'
          ? { periodType: values.periodType, year: values.year, quarter: values.quarter }
          : {
              periodType: values.periodType,
              name: values.name,
              periodStart: values.period?.[0].format('YYYY-MM-DD'),
              periodEnd: values.period?.[1].format('YYYY-MM-DD'),
            };
      return apiRequest<QuarterlyReviewSummary>('/api/v1/quarterly-reviews', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: async (response) => {
      setCreateOpen(false);
      setSelectedReviewId(response.data.id);
      setActiveStep(0);
      await refreshReview();
      void messageApi.success('考核周期已创建，周期定义已冻结');
    },
    onError: showError,
  });

  const collectReview = useMutation({
    mutationFn: async (values: CollectValues) =>
      apiRequest<unknown>(`/api/v1/quarterly-reviews/${selectedReviewId}/collect`, {
        method: 'POST',
        body: JSON.stringify({
          reviewVersion: review?.version,
          sources: {
            tasks: values.sources.includes('tasks'),
            evidence: values.sources.includes('evidence'),
            confirmedWeeklyReports: values.sources.includes('confirmedWeeklyReports'),
          },
          freshnessPolicy: {
            mode: values.freshnessMode,
            maximumAgeHours: values.maximumAgeHours,
          },
        }),
      }),
    onSuccess: async () => {
      setCollectOpen(false);
      await refreshReview();
      await queryClient.invalidateQueries({ queryKey: ['quarterly-collection-jobs'] });
      void messageApi.success('季度数据收集已进入后台队列，关闭页面也会继续');
    },
    onError: showError,
  });

  const cancelJob = useMutation({
    mutationFn: (jobId: string) =>
      apiRequest<unknown>(`/api/v1/operations/${jobId}/cancel`, { method: 'POST' }),
    onSuccess: async () => {
      await refreshReview();
      await queryClient.invalidateQueries({ queryKey: ['quarterly-collection-jobs'] });
      void messageApi.success('已请求取消后台作业');
    },
    onError: showError,
  });

  const saveAchievement = useMutation({
    mutationFn: async (values: AchievementValues) => {
      const body = {
        reviewVersion: review?.version,
        projectId: values.projectId ?? null,
        title: values.title,
        situation: values.situation,
        action: values.action,
        result: values.result,
        impact: values.impact,
        contributionBoundary: values.contributionBoundary,
        periodStart: values.period[0].format('YYYY-MM-DD'),
        periodEnd: values.period[1].format('YYYY-MM-DD'),
        ...(editingAchievement
          ? { version: editingAchievement.version, changeReason: values.changeReason }
          : {}),
      };
      return apiRequest<unknown>(
        editingAchievement
          ? `/api/v1/achievements/${editingAchievement.id}`
          : `/api/v1/quarterly-reviews/${selectedReviewId}/achievements`,
        { method: editingAchievement ? 'PUT' : 'POST', body: JSON.stringify(body) },
      );
    },
    onSuccess: async () => {
      setAchievementOpen(false);
      setEditingAchievement(null);
      await refreshReview();
      void messageApi.success('成果结构化内容已保存为新事实版本');
    },
    onError: showError,
  });

  const updateSelection = useMutation({
    mutationFn: async (values: SelectionValues) => {
      const selected = achievements.filter((achievement) =>
        selectedAchievementIds.includes(achievement.id),
      );
      return apiRequest<unknown>(`/api/v1/quarterly-reviews/${selectedReviewId}/achievements`, {
        method: 'PUT',
        body: JSON.stringify({
          reviewVersion: review?.version,
          actions: selected.map((achievement, index) => ({
            achievementId: achievement.id,
            version: achievement.version,
            status: values.status,
            reason: values.reason,
            sortOrder: values.status === 'selected' ? index + 1 : achievement.sortOrder,
          })),
        }),
      });
    },
    onSuccess: async () => {
      setSelectionOpen(false);
      setSelectedAchievementIds([]);
      await refreshReview();
      void messageApi.success('候选决策已保存；AI 不会替代本次人工选择');
    },
    onError: showError,
  });

  const addEvidence = useMutation({
    mutationFn: async (values: EvidenceValues) =>
      apiRequest<unknown>(`/api/v1/achievements/${evidenceAchievement?.id}/evidence`, {
        method: 'POST',
        body: JSON.stringify({
          reviewVersion: review?.version,
          achievementVersion: evidenceAchievement?.version,
          sourceType: 'manual_link',
          title: values.title,
          externalKey: values.externalKey?.trim() || null,
          url: values.url?.trim() || null,
          eventAt: values.eventAt?.toISOString() ?? null,
          availabilityState: values.availabilityState,
          summary: values.summary?.trim() ? { note: values.summary.trim() } : {},
          contributionAngle: values.contributionAngle,
          primaryEvidence: values.primaryEvidence,
        }),
      }),
    onSuccess: async () => {
      setEvidenceAchievement(null);
      await refreshReview();
      void messageApi.success('人工证据已添加并写入内容哈希');
    },
    onError: showError,
  });

  const createTemplate = useMutation({
    mutationFn: async (values: TemplateValues) =>
      apiRequest<unknown>('/api/v1/quarterly-reviews/metric-templates', {
        method: 'POST',
        body: JSON.stringify({
          name: values.name,
          formulaType: values.formulaType,
          roundingRule: values.roundingRule,
          metrics: values.metrics.map((metric) => ({
            code: metric.code,
            name: metric.name,
            definition: metric.definition,
            weight: metric.weight,
            minimum: metric.minimum,
            maximum: metric.maximum,
            step: metric.step,
            required: metric.required,
            enabled: metric.enabled,
            evidenceRequirement: { minimumEvidence: metric.minimumEvidence },
          })),
        }),
      }),
    onSuccess: async () => {
      setTemplateOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['quarterly-metric-templates'] });
      void messageApi.success('指标模板 v1 已创建并冻结，可绑定到考核周期');
    },
    onError: showError,
  });

  const bindTemplate = useMutation({
    mutationFn: (templateVersionId: string) =>
      apiRequest<unknown>(`/api/v1/quarterly-reviews/${selectedReviewId}/metric-template`, {
        method: 'PUT',
        body: JSON.stringify({ templateVersionId, reviewVersion: review?.version }),
      }),
    onSuccess: async () => {
      await refreshReview();
      setActiveStep(3);
      void messageApi.success('指标模板版本已绑定；旧模板映射不会被静默沿用');
    },
    onError: showError,
  });

  const updateMappings = useMutation({
    mutationFn: (values: MappingValues) =>
      apiRequest<unknown>(`/api/v1/achievements/${mappingAchievement?.id}/metrics`, {
        method: 'PUT',
        body: JSON.stringify({
          reviewVersion: review?.version,
          achievementVersion: mappingAchievement?.version,
          links: values.links,
        }),
      }),
    onSuccess: async () => {
      setMappingAchievement(null);
      await refreshReview();
      void messageApi.success('成果指标映射已建立新版本');
    },
    onError: showError,
  });

  const saveScores = useMutation({
    mutationFn: (values: ScoreValues) =>
      apiRequest<unknown>(`/api/v1/quarterly-reviews/${selectedReviewId}/scores`, {
        method: 'PUT',
        body: JSON.stringify({ reviewVersion: review?.version, scores: values.scores }),
      }),
    onSuccess: async () => {
      await refreshReview();
      void messageApi.success('用户分与理由已保存，服务端已重新计算未舍入贡献和总分');
    },
    onError: showError,
  });

  const generateAi = useMutation({
    mutationFn: (purpose: 'score_suggestion' | 'quarterly_review') =>
      apiRequest<unknown>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/ai/${
          purpose === 'score_suggestion' ? 'score-suggestion' : 'narrative'
        }`,
        {
          method: 'POST',
          body: JSON.stringify({
            reviewVersion: review?.version,
            providerConnectionId: selectedProviderId,
          }),
        },
      ),
    onSuccess: async () => {
      await refreshReview();
      void messageApi.success('AI 建议已保存；建议不会自动写入用户分或当前自评');
    },
    onError: showError,
  });

  const createRuleNarrative = useMutation({
    mutationFn: () =>
      apiRequest<unknown>(`/api/v1/quarterly-reviews/${selectedReviewId}/narratives/rule`, {
        method: 'POST',
        body: JSON.stringify({ reviewVersion: review?.version }),
      }),
    onSuccess: async () => {
      await refreshReview();
      setActiveStep(5);
      void messageApi.success('已从已选成果生成确定性规则自评版本');
    },
    onError: showError,
  });

  const saveNarrative = useMutation({
    mutationFn: (values: NarrativeValues) => {
      const { changeReason, ...content } = values;
      return apiRequest<unknown>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/narratives/manual`,
        {
          method: 'POST',
          body: JSON.stringify({
            reviewVersion: review?.version,
            parentVersionId: review?.currentNarrativeVersionId,
            content,
            changeReason,
          }),
        },
      );
    },
    onSuccess: async () => {
      setNarrativeOpen(false);
      await refreshReview();
      void messageApi.success('人工自评已创建新版本，历史版本保持不可变');
    },
    onError: showError,
  });

  const decideNarrative = useMutation({
    mutationFn: async (values: DecisionValues) => {
      if (!narrativeDecision) throw new Error('未选择自评决策对象');
      if (narrativeDecision.kind === 'restore') {
        return apiRequest<unknown>(
          `/api/v1/quarterly-reviews/${selectedReviewId}/narratives/${narrativeDecision.version.id}/restore`,
          {
            method: 'POST',
            body: JSON.stringify({ reviewVersion: review?.version, changeReason: values.reason }),
          },
        );
      }
      return apiRequest<unknown>(
        `/api/v1/quarterly-reviews/${selectedReviewId}/ai-generations/${narrativeDecision.generation.id}/${narrativeDecision.kind}`,
        {
          method: 'POST',
          body: JSON.stringify({ reviewVersion: review?.version, decisionReason: values.reason }),
        },
      );
    },
    onSuccess: async () => {
      setNarrativeDecision(null);
      await refreshReview();
      void messageApi.success('自评版本决策已保存并可审计');
    },
    onError: showError,
  });

  const confirmReview = useMutation({
    mutationFn: () => {
      if (!review?.currentNarrativeVersionId) throw new Error('当前没有可确认的自评版本');
      const required = preflight.data?.data.requiredAcknowledgements ?? [];
      return apiRequest<unknown>(`/api/v1/quarterly-reviews/${selectedReviewId}/confirmations`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `quarterly-confirm-${crypto.randomUUID()}` },
        body: JSON.stringify({
          reviewVersion: review.version,
          narrativeVersionId: review.currentNarrativeVersionId,
          acknowledgements: required.map((item) => ({
            code: item.code,
            reason: acknowledgementReasons[item.code],
          })),
        }),
      });
    },
    onSuccess: async () => {
      setConfirmOpen(false);
      await refreshReview();
      setActiveStep(6);
      void messageApi.success('季度绩效已确认并冻结完整快照');
    },
    onError: showError,
  });

  const queueExport = useMutation({
    mutationFn: (format: 'xlsx' | 'docx') => {
      if (!review?.currentConfirmationId) throw new Error('只有当前有效确认可以导出');
      return apiRequest<unknown>(`/api/v1/quarterly-reviews/${selectedReviewId}/exports`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `quarterly-export-${crypto.randomUUID()}` },
        body: JSON.stringify({ confirmationId: review.currentConfirmationId, format }),
      });
    },
    onSuccess: async () => {
      await refreshReview();
      void messageApi.success('本地文件生成作业已排队；不会上传或提交到公司系统');
    },
    onError: showError,
  });

  const downloadExport = useMutation({
    mutationFn: async (artifact: QuarterlyExportArtifact) => {
      const file = await apiDownload(
        `/api/v1/quarterly-reviews/${selectedReviewId}/exports/${artifact.id}/download`,
      );
      const url = URL.createObjectURL(file.blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.fileName;
        anchor.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      return file;
    },
    onSuccess: (file) => {
      void messageApi.success(`已下载 ${file.fileName}（${formatFileSize(file.sizeBytes)}）`);
    },
    onError: showError,
  });

  function openAchievementEditor(achievement?: QuarterlyAchievement): void {
    setEditingAchievement(achievement ?? null);
    achievementForm.setFieldsValue(
      achievement
        ? {
            ...(achievement.project ? { projectId: achievement.project.id } : {}),
            title: achievement.title,
            situation: achievement.situation,
            action: achievement.action,
            result: achievement.result,
            impact: achievement.impact,
            contributionBoundary: achievement.contributionBoundary,
            period: [dayjs(achievement.periodStart), dayjs(achievement.periodEnd)] as [
              Dayjs,
              Dayjs,
            ],
            changeReason: '',
          }
        : {
            title: '',
            situation: '',
            action: '',
            result: '',
            impact: '',
            contributionBoundary: '',
            ...(review
              ? {
                  period: [dayjs(review.periodStart), dayjs(review.periodEnd)] as [Dayjs, Dayjs],
                }
              : {}),
          },
    );
    setAchievementOpen(true);
  }

  function openMapping(achievement: QuarterlyAchievement): void {
    setMappingAchievement(achievement);
    mappingForm.setFieldsValue({
      links: achievement.metricLinks.map((link) => ({
        metricId: link.metricId,
        contribution: link.contribution,
      })),
    });
  }

  function openNarrativeEditor(): void {
    const content = currentNarrative.data?.data.content;
    const first = selectedAchievements[0];
    narrativeForm.setFieldsValue({
      overallOverview: content?.overallOverview ?? '',
      coreAchievements:
        content?.coreAchievements ??
        (first
          ? [
              {
                heading: first.title,
                body: `${first.action}\n${first.result}\n${first.impact}`,
                achievementIds: [first.id],
                metricIds: first.metricLinks.map((link) => link.metricId),
                evidenceIds: first.evidences.map((evidence) => evidence.id),
              },
            ]
          : []),
      collaborationAndGrowth: content?.collaborationAndGrowth ?? '',
      problemsAndImprovements: content?.problemsAndImprovements ?? '',
      nextPeriodPlan: content?.nextPeriodPlan ?? '',
      changeReason: '',
    });
    setNarrativeOpen(true);
  }

  function selectReview(id: string): void {
    setSelectedReviewId(id);
    setSelectedAchievementIds([]);
    const selected = reviews.data?.data.items.find((item) => item.id === id);
    setActiveStep(selected ? quarterlyWorkflowStep(selected) : 0);
  }

  if (reviews.isLoading) {
    return <Card loading />;
  }

  return (
    <Space direction="vertical" size={20} className="page-stack quarterly-workbench">
      {holder}
      {renderHeading()}
      {review ? (
        <>
          {renderReviewSummary(review)}
          <Card>
            <Steps
              current={activeStep}
              onChange={setActiveStep}
              responsive={false}
              items={quarterlyWorkflowItems.map((title) => ({ title }))}
            />
          </Card>
          {renderActiveStep()}
        </>
      ) : (
        <Empty description="尚未创建季度考核周期" image={Empty.PRESENTED_IMAGE_SIMPLE}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            创建第一个周期
          </Button>
        </Empty>
      )}
      {renderModalsAndDrawers()}
    </Space>
  );

  function renderHeading() {
    return (
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>季度绩效工作台</Typography.Title>
          <Typography.Text type="secondary">
            从多来源候选到确认快照和本地文件，全程保留人工选择、版本、证据与公式。
          </Typography.Text>
        </div>
        <Space wrap>
          <Select<string>
            style={{ width: 260 }}
            value={selectedReviewId}
            placeholder="选择考核周期"
            options={(reviews.data?.data.items ?? []).map((item) => ({
              value: item.id,
              label: `${item.name} · ${item.status}`,
            }))}
            onChange={selectReview}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void refreshReview()}>
            刷新事实
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建周期
          </Button>
        </Space>
      </div>
    );
  }

  function renderReviewSummary(item: QuarterlyReview) {
    return (
      <Card>
        <div className="quarterly-summary-grid">
          <div>
            <Typography.Text type="secondary">当前周期</Typography.Text>
            <Typography.Title level={4}>{item.name}</Typography.Title>
            <Typography.Text>
              {item.periodStart} 至 {item.periodEnd} · {item.timezone}
            </Typography.Text>
          </div>
          <Statistic title="成果总数" value={item.achievementCount} suffix="项" />
          <Statistic title="导出记录" value={item.exportCount} suffix="份" />
          <div>
            <Typography.Text type="secondary">聚合状态 / 版本</Typography.Text>
            <div style={{ marginTop: 8 }}>
              <StatusTag status={item.status} /> <Tag>v{item.version}</Tag>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  function renderActiveStep() {
    if (!review) return null;
    if (activeStep === 0) return renderDataStep();
    if (activeStep === 1) return renderCandidateStep();
    if (activeStep === 2) return renderAchievementStep();
    if (activeStep === 3) return renderMetricStep();
    if (activeStep === 4) return renderScoreStep();
    if (activeStep === 5) return renderNarrativeStep();
    return renderConfirmationStep();
  }

  function renderDataStep() {
    const completeness = review?.completeness ?? {};
    return (
      <div className="quarterly-two-column">
        <Space direction="vertical" size={16}>
          <Card
            title="周期定义与数据收集"
            extra={
              <Space>
                {latestCollectionJob &&
                ['queued', 'running'].includes(latestCollectionJob.status) ? (
                  <Button
                    danger
                    icon={<StopOutlined />}
                    loading={cancelJob.isPending}
                    onClick={() => cancelJob.mutate(latestCollectionJob.id)}
                  >
                    取消收集
                  </Button>
                ) : null}
                <Button
                  type="primary"
                  icon={<CloudSyncOutlined />}
                  onClick={() => {
                    collectForm.setFieldsValue({
                      sources: ['tasks', 'evidence', 'confirmedWeeklyReports'],
                      freshnessMode: 'allow_stale',
                      maximumAgeHours: 168,
                    });
                    setCollectOpen(true);
                  }}
                >
                  收集/重建候选
                </Button>
              </Space>
            }
          >
            <Descriptions column={2} bordered size="small">
              <Descriptions.Item label="周期起点">{review?.periodStart}</Descriptions.Item>
              <Descriptions.Item label="闭区间终点">{review?.periodEnd}</Descriptions.Item>
              <Descriptions.Item label="下一周期起点">{review?.nextPeriodStart}</Descriptions.Item>
              <Descriptions.Item label="边界语义">[起点 00:00, 下一周期 00:00)</Descriptions.Item>
              <Descriptions.Item label="自然季度">
                {review?.naturalQuarter ? '是' : '否'}
              </Descriptions.Item>
              <Descriptions.Item label="定义可变性">创建后不可原地修改</Descriptions.Item>
            </Descriptions>
            {latestCollectionJob ? (
              <div style={{ marginTop: 18 }}>
                <Space>
                  <StatusTag status={latestCollectionJob.status} />
                  <Typography.Text>最近收集作业</Typography.Text>
                </Space>
                <Progress
                  percent={latestCollectionJob.progress}
                  status={latestCollectionJob.status === 'failed' ? 'exception' : 'active'}
                  style={{ marginTop: 8 }}
                />
                {latestCollectionJob.lastError ? (
                  <Alert type="error" showIcon message={latestCollectionJob.lastError} />
                ) : null}
              </div>
            ) : null}
          </Card>
          <Card title="不可变来源快照">
            <Table
              rowKey="id"
              size="small"
              loading={snapshots.isLoading}
              dataSource={snapshots.data?.data ?? []}
              pagination={false}
              columns={[
                { title: '序号', dataIndex: 'sequenceNo', width: 70 },
                {
                  title: '来源计数',
                  render: (_: unknown, row: QuarterlyCollectionSnapshot) =>
                    `任务 ${row.taskCount} / 证据 ${row.evidenceCount} / 周报 ${row.weeklyReportCount}`,
                },
                {
                  title: '警告',
                  dataIndex: 'warnings',
                  render: (value: unknown[]) =>
                    value.length > 0 ? <Tag color="orange">{value.length}</Tag> : '0',
                },
                {
                  title: '快照时间',
                  dataIndex: 'createdAt',
                  render: (value: string) => new Date(value).toLocaleString(),
                },
              ]}
              expandable={{
                expandedRowRender: (row) => (
                  <pre className="safe-json">
                    {JSON.stringify(
                      {
                        sources: row.sources,
                        freshnessPolicy: row.freshnessPolicy,
                        warnings: row.warnings,
                        sourceContentHash: row.sourceContentHash,
                        generationHash: row.generationHash,
                      },
                      null,
                      2,
                    )}
                  </pre>
                ),
              }}
            />
          </Card>
        </Space>
        <Card title="材料完整性（不计入绩效分）" className="quarterly-sticky-card">
          <CompletenessFacts completeness={completeness} />
          <Divider />
          <Alert
            type={completeness.sourceFreshness === 'fresh' ? 'success' : 'warning'}
            showIcon
            message="完整性与绩效分严格隔离"
            description="来源新鲜度、证据覆盖和冲突只用于材料检查；任何值都不会进入指标公式。"
          />
        </Card>
      </div>
    );
  }

  function renderCandidateStep() {
    return (
      <Card
        title="成果候选池"
        extra={
          <Space>
            <Button icon={<FileAddOutlined />} onClick={() => openAchievementEditor()}>
              新增人工成果
            </Button>
            <Button
              type="primary"
              disabled={selectedAchievementIds.length === 0}
              onClick={() => {
                selectionForm.setFieldsValue({
                  status: 'selected',
                  reason: '人工核对后纳入本期材料',
                });
                setSelectionOpen(true);
              }}
            >
              批量决策（{selectedAchievementIds.length}）
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          message="候选不会自动进入最终材料"
          description="批量动作只修改人工选择状态，不自动映射指标、填分或删除被排除候选。"
          style={{ marginBottom: 16 }}
        />
        <Space wrap style={{ marginBottom: 16 }}>
          <Segmented
            value={achievementStatusFilter}
            options={[
              { label: '全部', value: 'all' },
              ...Object.entries(selectionLabels).map(([value, label]) => ({ label, value })),
            ]}
            onChange={(value) =>
              setAchievementStatusFilter(value as typeof achievementStatusFilter)
            }
          />
          <Select
            value={evidenceFilter}
            style={{ width: 160 }}
            options={[
              { value: 'all', label: '全部证据状态' },
              { value: 'complete', label: '证据完整' },
              { value: 'partial', label: '部分证据' },
              { value: 'needs_evidence', label: '需要证据' },
            ]}
            onChange={setEvidenceFilter}
          />
          <Select
            value={projectFilter}
            style={{ width: 180 }}
            showSearch
            options={[
              { value: 'all', label: '全部项目' },
              ...(projects.data?.data ?? []).map((project) => ({
                value: project.id,
                label: project.name,
              })),
            ]}
            onChange={setProjectFilter}
          />
          <Select
            value={achievementSourceFilter}
            style={{ width: 150 }}
            options={[
              { value: 'all', label: '全部成果来源' },
              { value: 'collected', label: '自动收集' },
              { value: 'manual', label: '人工成果' },
            ]}
            onChange={setAchievementSourceFilter}
          />
          <Select
            value={evidenceSourceFilter}
            style={{ width: 180 }}
            options={[
              { value: 'all', label: '全部证据来源' },
              { value: 'task', label: '任务' },
              { value: 'branch', label: '分支' },
              { value: 'commit', label: 'Commit' },
              { value: 'merge_request', label: 'Merge Request' },
              { value: 'pipeline', label: 'Pipeline' },
              { value: 'tag', label: 'Tag' },
              { value: 'release', label: 'Release' },
              { value: 'weekly_report', label: '已确认周报' },
              { value: 'manual_link', label: '人工链接' },
            ]}
            onChange={setEvidenceSourceFilter}
          />
          <Select
            value={metricFilter}
            style={{ width: 180 }}
            options={[
              { value: 'all', label: '全部指标' },
              ...(review?.metricTemplate?.metrics ?? []).map((metric) => ({
                value: metric.id,
                label: metric.name,
              })),
            ]}
            onChange={setMetricFilter}
          />
          <DatePicker
            picker="month"
            value={monthFilter}
            placeholder="成果月份"
            allowClear
            onChange={setMonthFilter}
          />
        </Space>
        <div
          className="quarterly-selected-drop-zone"
          role="button"
          tabIndex={0}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (!draggedAchievementId) return;
            setSelectedAchievementIds([draggedAchievementId]);
            selectionForm.setFieldsValue({
              status: 'selected',
              reason: '拖入已选区并经人工核对后纳入本期材料',
            });
            setSelectionOpen(true);
            setDraggedAchievementId(null);
          }}
          onKeyDown={(event) => {
            if ((event.key === 'Enter' || event.key === ' ') && selectedAchievementIds.length > 0) {
              event.preventDefault();
              selectionForm.setFieldsValue({
                status: 'selected',
                reason: '通过键盘操作纳入本期材料',
              });
              setSelectionOpen(true);
            }
          }}
        >
          <CheckCircleOutlined />
          <div>
            <Typography.Text strong>拖入已选区</Typography.Text>
            <br />
            <Typography.Text type="secondary">
              拖入候选后仍会打开人工原因确认；键盘用户可勾选行后按 Enter。
            </Typography.Text>
          </div>
        </div>
        {renderAchievementTable(true)}
      </Card>
    );
  }

  function renderAchievementStep() {
    return (
      <div className="quarterly-two-column">
        <Card
          title="结构化成果编辑"
          extra={
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openAchievementEditor()}>
              人工成果
            </Button>
          }
        >
          {renderAchievementTable(false)}
        </Card>
        <Card title="编辑要求" className="quarterly-sticky-card">
          <Timeline
            items={[
              { children: '背景/目标：说明为什么做，避免只列任务标题' },
              { children: '个人行动：明确职责与团队边界' },
              { children: '结果：只写可由事实支持的完成状态' },
              { children: '影响：无量化证据时使用定性表述，不虚构数字' },
              { children: '证据：标记主/辅助证据和本成果的贡献角度' },
            ]}
          />
          <Alert
            type="warning"
            showIcon
            message="确认后编辑会使当前确认失效"
            description="旧确认和历史导出仍保留，不会被新编辑覆盖。"
          />
        </Card>
      </div>
    );
  }

  function renderMetricStep() {
    const current = review?.metricTemplate;
    return (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card
          title="版本化指标模板"
          extra={
            <Button icon={<PlusOutlined />} onClick={() => openTemplateCreator()}>
              创建模板
            </Button>
          }
        >
          <div className="quarterly-template-grid">
            {(templates.data?.data ?? []).map((template) => (
              <Card
                size="small"
                key={template.id}
                title={template.name}
                extra={
                  template.currentVersion?.id === current?.versionId ? (
                    <Tag color="green">当前绑定</Tag>
                  ) : (
                    <Button
                      size="small"
                      disabled={!template.currentVersion}
                      loading={bindTemplate.isPending}
                      onClick={() =>
                        template.currentVersion && bindTemplate.mutate(template.currentVersion.id)
                      }
                    >
                      绑定此版本
                    </Button>
                  )
                }
              >
                {template.currentVersion ? (
                  <Space direction="vertical" size={4}>
                    <Typography.Text>v{template.currentVersion.versionNo}</Typography.Text>
                    <Typography.Text type="secondary">
                      {formulaLabels[template.currentVersion.formulaType]} ·{' '}
                      {roundingLabels[template.currentVersion.roundingRule]}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {template.currentVersion.metrics.length} 项指标 · 哈希{' '}
                      {template.currentVersion.contentHash.slice(0, 12)}…
                    </Typography.Text>
                  </Space>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可用版本" />
                )}
              </Card>
            ))}
          </div>
        </Card>
        {current ? (
          <div className="quarterly-two-column">
            <Card title={`成果到指标映射 · ${current.name} v${current.versionNo}`}>
              <List
                dataSource={selectedAchievements}
                locale={{ emptyText: '请先在候选池选择成果' }}
                renderItem={(achievement) => (
                  <List.Item
                    actions={[
                      <Button key="mapping" size="small" onClick={() => openMapping(achievement)}>
                        编辑映射
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      title={achievement.title}
                      description={
                        achievement.metricLinks.length > 0 ? (
                          <Space wrap>
                            {achievement.metricLinks.map((link) => (
                              <Tooltip key={link.id} title={link.contribution}>
                                <Tag color="blue">{link.metricName}</Tag>
                              </Tooltip>
                            ))}
                          </Space>
                        ) : (
                          <Typography.Text type="warning">尚未映射任何指标</Typography.Text>
                        )
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
            <Card title="覆盖检查" className="quarterly-sticky-card">
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="已选成果">{coverage.selectedCount}</Descriptions.Item>
                <Descriptions.Item label="成果无证据">
                  {coverage.selectedWithoutEvidence}
                </Descriptions.Item>
                <Descriptions.Item label="成果无指标">
                  {coverage.selectedWithoutMetric}
                </Descriptions.Item>
                <Descriptions.Item label="必填指标未覆盖">
                  {coverage.requiredMetricUncovered}
                </Descriptions.Item>
                <Descriptions.Item label="重复证据来源">
                  {coverage.duplicateEvidenceReferences}
                </Descriptions.Item>
              </Descriptions>
              <Divider />
              <Collapse
                items={current.metrics.map((metric) => ({
                  key: metric.id,
                  label: (
                    <Space>
                      <Tag color={metric.required ? 'red' : 'default'}>
                        {metric.required ? '必填' : '可选'}
                      </Tag>
                      <Typography.Text strong>{metric.name}</Typography.Text>
                      <Typography.Text type="secondary">{metric.weight}%</Typography.Text>
                    </Space>
                  ),
                  children: (
                    <>
                      <Typography.Paragraph>{metric.definition}</Typography.Paragraph>
                      <pre className="safe-json">
                        {JSON.stringify(metric.evidenceRequirement, null, 2)}
                      </pre>
                    </>
                  ),
                }))}
              />
            </Card>
          </div>
        ) : (
          <Result
            status="info"
            title="尚未绑定指标模板"
            subTitle="没有版本化指标、权重、范围、步长和取整规则时，系统不会生成最终总分。"
          />
        )}
      </Space>
    );
  }

  function renderScoreStep() {
    const template = review?.metricTemplate;
    if (!template)
      return (
        <Result
          status="warning"
          title="请先绑定指标模板"
          extra={<Button onClick={() => setActiveStep(3)}>前往指标映射</Button>}
        />
      );
    const scoreByMetric = new Map(review.scores.map((score) => [score.metricId, score]));
    return (
      <div className="quarterly-score-layout">
        <Card
          title="逐指标用户评分"
          extra={
            <Space>
              <Select<string>
                placeholder="选择健康 AI 连接"
                value={selectedProviderId}
                style={{ width: 220 }}
                options={aiProviders.map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                }))}
                onChange={(value) => setSelectedProviderId(value)}
              />
              <Button
                icon={<RobotOutlined />}
                disabled={!selectedProviderId}
                loading={generateAi.isPending}
                onClick={() => generateAi.mutate('score_suggestion')}
              >
                生成 AI 分项建议
              </Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saveScores.isPending}
                onClick={() =>
                  void scoreForm.validateFields().then((values) => saveScores.mutate(values))
                }
              >
                保存用户评分
              </Button>
            </Space>
          }
        >
          <Alert
            type="warning"
            showIcon
            message="AI 建议与用户分是两个独立事实"
            description="建议仅显示在黄色区域，绝不自动填入用户分；最终公式只读取本表的用户输入。"
            style={{ marginBottom: 16 }}
          />
          <Form form={scoreForm} layout="vertical">
            <Table
              rowKey="id"
              pagination={false}
              dataSource={template.metrics}
              columns={scoreColumns(template.metrics, scoreByMetric)}
            />
          </Form>
        </Card>
        <Card title="确定性总分展开" className="quarterly-sticky-card">
          {scorePreview ? (
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Statistic
                title="最终总分"
                value={scorePreview.finalTotal ?? '—'}
                suffix={scorePreview.complete ? '分' : undefined}
              />
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="公式">{scorePreview.formulaText}</Descriptions.Item>
                <Descriptions.Item label="权重合计">{scorePreview.weightTotal}%</Descriptions.Item>
                <Descriptions.Item label="未舍入合计">
                  {scorePreview.rawTotal.toFixed(6)}
                </Descriptions.Item>
                <Descriptions.Item label="取整规则">{scorePreview.roundingText}</Descriptions.Item>
              </Descriptions>
              {scorePreview.warnings.length > 0 ? (
                <Alert
                  type="error"
                  showIcon
                  message="当前不能形成最终总分"
                  description={scorePreview.warnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                />
              ) : (
                <Alert type="success" showIcon message="范围、步长、理由和权重预检通过" />
              )}
            </Space>
          ) : null}
        </Card>
      </div>
    );
  }

  function scoreColumns(
    metrics: QuarterlyMetric[],
    scoreByMetric: Map<string, QuarterlyScoreItem>,
  ): ColumnsType<QuarterlyMetric> {
    return [
      {
        title: '指标与定义',
        width: 260,
        render: (_value, metric) => (
          <Space direction="vertical" size={2}>
            <Space>
              <Typography.Text strong>{metric.name}</Typography.Text>
              {metric.required ? <Tag color="red">必填</Tag> : <Tag>可选</Tag>}
            </Space>
            <Typography.Text type="secondary">{metric.definition}</Typography.Text>
            <Typography.Text type="secondary">
              范围 {metric.minimum}～{metric.maximum} · 步长 {metric.step} · 权重 {metric.weight}%
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: 'AI 建议（不自动采用）',
        width: 260,
        render: (_value, metric) => {
          const score = scoreByMetric.get(metric.id);
          return score?.aiSuggestedScore == null ? (
            <Typography.Text type="secondary">尚无建议</Typography.Text>
          ) : (
            <div className="quarterly-ai-suggestion">
              <Typography.Text strong>
                {score.aiSuggestedScore}（{score.aiSuggestedMinimum}～{score.aiSuggestedMaximum}）
              </Typography.Text>
              <Typography.Paragraph
                ellipsis={{ rows: 3 }}
                {...(score.aiReason ? { title: score.aiReason } : {})}
              >
                {score.aiReason}
              </Typography.Paragraph>
              <Tag color="gold">不确定性 {score.aiUncertainty ?? '未知'}</Tag>
              {score.aiEvidenceGaps.length > 0 ? (
                <Typography.Text type="warning">
                  缺口：{score.aiEvidenceGaps.join('；')}
                </Typography.Text>
              ) : null}
            </div>
          );
        },
      },
      {
        title: '用户分',
        width: 150,
        render: (_value, metric, index) => (
          <>
            <Form.Item name={['scores', index, 'metricId']} hidden>
              <Input />
            </Form.Item>
            <Form.Item
              name={['scores', index, 'userScore']}
              rules={[{ required: metric.required, message: '请输入用户分' }]}
              style={{ margin: 0 }}
            >
              <InputNumber
                min={metric.minimum}
                max={metric.maximum}
                step={metric.step}
                style={{ width: '100%' }}
                placeholder="人工填写"
              />
            </Form.Item>
          </>
        ),
      },
      {
        title: '用户理由',
        render: (_value, metric, index) => (
          <Form.Item
            name={['scores', index, 'userReason']}
            dependencies={[['scores', index, 'userScore']]}
            rules={[
              {
                validator: (_rule, value: string | null | undefined) => {
                  const userScore = scoreForm.getFieldValue(['scores', index, 'userScore']) as
                    number | null | undefined;
                  return userScore == null || value?.trim()
                    ? Promise.resolve()
                    : Promise.reject(new Error('录入用户分后必须填写评分理由'));
                },
              },
            ]}
            style={{ margin: 0 }}
          >
            <Input.TextArea
              rows={3}
              maxLength={2000}
              showCount
              placeholder="引用成果与证据说明评分边界"
            />
          </Form.Item>
        ),
      },
    ];
  }

  function renderNarrativeStep() {
    const current = currentNarrative.data?.data;
    const generations = aiGenerations.data?.data.items ?? [];
    return (
      <div className="quarterly-two-column">
        <Space direction="vertical" size={16}>
          <Card
            title="当前自评正文"
            extra={
              <Space wrap>
                <Button icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>
                  版本历史
                </Button>
                <Button
                  loading={createRuleNarrative.isPending}
                  onClick={() => createRuleNarrative.mutate()}
                >
                  规则生成
                </Button>
                <Button
                  icon={<EditOutlined />}
                  disabled={!current && selectedAchievements.length === 0}
                  onClick={openNarrativeEditor}
                >
                  人工编辑新版本
                </Button>
              </Space>
            }
          >
            {current?.content ? (
              <NarrativePreview content={current.content} achievements={allReviewAchievements} />
            ) : (
              <Empty description="尚无当前自评版本；可先规则生成或人工创建" />
            )}
          </Card>
          <Card title="AI 自评候选与决策">
            <Space wrap style={{ marginBottom: 16 }}>
              <Select<string>
                placeholder="选择健康 AI 连接"
                value={selectedProviderId}
                style={{ width: 240 }}
                options={aiProviders.map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                }))}
                onChange={(value) => setSelectedProviderId(value)}
              />
              <Button
                icon={<RobotOutlined />}
                disabled={!selectedProviderId}
                loading={generateAi.isPending}
                onClick={() => generateAi.mutate('quarterly_review')}
              >
                生成 AI 自评候选
              </Button>
            </Space>
            <List
              dataSource={generations}
              locale={{ emptyText: '暂无 AI 生成记录；AI 不可用时仍可使用规则和人工版本' }}
              renderItem={(generation) => (
                <List.Item
                  actions={[
                    <Button
                      key="detail"
                      size="small"
                      onClick={() => setSelectedAiGenerationId(generation.id)}
                    >
                      查看输入边界
                    </Button>,
                    ...(generation.purpose === 'quarterly_review' &&
                    generation.adoptionStatus === 'pending' &&
                    !generation.stale
                      ? [
                          <Button
                            key="adopt"
                            size="small"
                            type="primary"
                            onClick={() => openDecision({ kind: 'adopt', generation })}
                          >
                            采纳为人工版本
                          </Button>,
                          <Button
                            key="reject"
                            size="small"
                            danger
                            onClick={() => openDecision({ kind: 'reject', generation })}
                          >
                            拒绝
                          </Button>,
                        ]
                      : []),
                  ]}
                >
                  <List.Item.Meta
                    avatar={<RobotOutlined />}
                    title={
                      <Space>
                        <Tag color={generation.purpose === 'quarterly_review' ? 'purple' : 'gold'}>
                          {generation.purpose === 'quarterly_review' ? '自评建议' : '分数建议'}
                        </Tag>
                        <StatusTag status={generation.status} />
                        <Tag>{generation.adoptionStatus}</Tag>
                        {generation.stale ? <Tag color="orange">基线已过期</Tag> : null}
                      </Space>
                    }
                    description={`${generation.model} · 基线 v${generation.baseReviewVersion ?? '—'} · ${new Date(generation.createdAt).toLocaleString()}`}
                  />
                </List.Item>
              )}
            />
          </Card>
        </Space>
        <Card title="版本与事实边界" className="quarterly-sticky-card">
          {current ? (
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="当前版本">v{current.versionNo}</Descriptions.Item>
              <Descriptions.Item label="来源">
                {narrativeOriginLabels[current.origin]}
              </Descriptions.Item>
              <Descriptions.Item label="内容哈希">{current.contentHash}</Descriptions.Item>
              <Descriptions.Item label="来源快照">{current.sourceSnapshotHash}</Descriptions.Item>
              <Descriptions.Item label="创建时间">
                {new Date(current.createdAt).toLocaleString()}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
          <Divider />
          <Alert
            type="info"
            showIcon
            message="AI 版本不是当前正文"
            description="AI 生成只保存候选；明确采纳后才创建人工版本。选择成果或分数变化不会覆盖已有人工作品。"
          />
        </Card>
      </div>
    );
  }

  function renderConfirmationStep() {
    const gate = preflight.data?.data;
    const readiness = gate ? confirmationReadiness(gate, acknowledgementReasons) : null;
    const artifacts = exportsQuery.data?.data ?? [];
    return (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          icon={<SafetyCertificateOutlined />}
          message="确认冻结，导出仅生成本地文件"
          description="此页面不会向公司系统、邮件或钉钉提交绩效材料。确认后编辑会失效当前确认，但不会改写历史导出。"
        />
        <div className="quarterly-two-column">
          <Card
            title="确认前置检查"
            extra={
              <Button
                type="primary"
                icon={<CheckCircleOutlined />}
                disabled={!readiness?.ready || Boolean(review?.currentConfirmationId)}
                onClick={() => setConfirmOpen(true)}
              >
                {review?.currentConfirmationId ? '当前快照已确认' : '确认并冻结快照'}
              </Button>
            }
          >
            {!gate ? (
              <Empty description="请先准备当前自评正文" />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {gate.blockers.map((blocker) => (
                  <Alert
                    key={blocker.code}
                    type="error"
                    showIcon
                    message={blocker.message}
                    description={blocker.code}
                  />
                ))}
                {gate.requiredAcknowledgements.map((item) => (
                  <div className="quarterly-ack-row" key={item.code}>
                    <div>
                      <Typography.Text strong>{item.message}</Typography.Text>
                      <br />
                      <Typography.Text type="secondary">
                        {item.code} · {item.count} 项
                      </Typography.Text>
                    </div>
                    <Input.TextArea
                      rows={2}
                      value={acknowledgementReasons[item.code] ?? ''}
                      placeholder="说明已如何人工核对并知悉此风险"
                      onChange={(event) =>
                        setAcknowledgementReasons((current) => ({
                          ...current,
                          [item.code]: event.target.value,
                        }))
                      }
                    />
                  </div>
                ))}
                {gate.blockers.length === 0 && gate.requiredAcknowledgements.length === 0 ? (
                  <Alert type="success" showIcon message="确认前置检查全部通过" />
                ) : null}
                {readiness && readiness.missingAcknowledgements.length > 0 ? (
                  <Typography.Text type="warning">
                    尚有 {readiness.missingAcknowledgements.length} 项知悉原因未填写
                  </Typography.Text>
                ) : null}
              </Space>
            )}
          </Card>
          <Card title="确认历史" className="quarterly-sticky-card">
            <Timeline
              items={(confirmations.data?.data ?? []).map((confirmation) => ({
                color: confirmation.status === 'active' ? 'green' : 'gray',
                children: (
                  <Space direction="vertical" size={2}>
                    <Space>
                      <StatusTag status={confirmation.status} />
                      <Typography.Text>评审 v{confirmation.reviewVersion}</Typography.Text>
                    </Space>
                    <Typography.Text type="secondary">
                      {new Date(confirmation.confirmedAt).toLocaleString()}
                    </Typography.Text>
                    <Typography.Text code>
                      {confirmation.snapshotHash.slice(0, 16)}…
                    </Typography.Text>
                    {confirmation.invalidationReason ? (
                      <Typography.Text type="warning">
                        {confirmation.invalidationReason}
                      </Typography.Text>
                    ) : null}
                  </Space>
                ),
              }))}
            />
          </Card>
        </div>
        <Card
          title="Excel / Word 本地制品"
          extra={
            <Space>
              <Button
                icon={<FileAddOutlined />}
                disabled={!review?.currentConfirmationId}
                loading={queueExport.isPending}
                onClick={() => queueExport.mutate('xlsx')}
              >
                生成 Excel
              </Button>
              <Button
                icon={<FileAddOutlined />}
                disabled={!review?.currentConfirmationId}
                loading={queueExport.isPending}
                onClick={() => queueExport.mutate('docx')}
              >
                生成 Word
              </Button>
            </Space>
          }
        >
          <Table
            rowKey="id"
            pagination={false}
            dataSource={artifacts}
            columns={[
              {
                title: '格式',
                dataIndex: 'format',
                render: (value: string) => <Tag>{value.toUpperCase()}</Tag>,
              },
              {
                title: '状态',
                dataIndex: 'status',
                render: (value: string) => <StatusTag status={value} />,
              },
              {
                title: '结构 QA',
                dataIndex: 'qaStatus',
                render: (value: string) => <StatusTag status={value} />,
              },
              { title: '尝试', dataIndex: 'attemptCount' },
              {
                title: '文件',
                dataIndex: 'fileName',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: '大小',
                dataIndex: 'sizeBytes',
                render: (value: number | null) => formatFileSize(value),
              },
              {
                title: '完成时间',
                dataIndex: 'completedAt',
                render: (value: string | null) => (value ? new Date(value).toLocaleString() : '—'),
              },
              {
                title: '操作',
                render: (_value: unknown, artifact: QuarterlyExportArtifact) => (
                  <Space>
                    <Button size="small" onClick={() => setSelectedExportId(artifact.id)}>
                      验收事实
                    </Button>
                    {artifact.jobId && ['queued', 'running'].includes(artifact.status) ? (
                      <Button size="small" danger onClick={() => cancelJob.mutate(artifact.jobId!)}>
                        取消
                      </Button>
                    ) : null}
                    <Button
                      size="small"
                      type="primary"
                      icon={<DownloadOutlined />}
                      disabled={!canDownloadQuarterlyExport(artifact)}
                      loading={downloadExport.isPending}
                      onClick={() => downloadExport.mutate(artifact)}
                    >
                      下载
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </Space>
    );
  }

  function renderAchievementTable(withSelection: boolean) {
    return (
      <Table
        rowKey="id"
        loading={achievementQuery.isLoading}
        dataSource={achievements}
        {...(withSelection
          ? {
              rowSelection: {
                selectedRowKeys: selectedAchievementIds,
                onChange: setSelectedAchievementIds,
              },
            }
          : {})}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        columns={achievementColumns()}
        expandable={{
          expandedRowRender: (achievement) => <AchievementDetail achievement={achievement} />,
        }}
        footer={() =>
          achievementQuery.hasNextPage ? (
            <Button
              block
              loading={achievementQuery.isFetchingNextPage}
              onClick={() => void achievementQuery.fetchNextPage()}
            >
              加载下一页候选
            </Button>
          ) : (
            <Typography.Text type="secondary">
              已加载当前筛选下全部 {achievements.length} 项
            </Typography.Text>
          )
        }
        onRow={(achievement) => ({
          draggable: withSelection,
          onDragStart: () => setDraggedAchievementId(achievement.id),
          onDragEnd: () => setDraggedAchievementId(null),
        })}
      />
    );
  }

  function achievementColumns(): ColumnsType<QuarterlyAchievement> {
    return [
      {
        title: '成果',
        width: 300,
        render: (_value, achievement) => (
          <Space direction="vertical" size={2}>
            <Typography.Text strong>{achievement.title}</Typography.Text>
            <Typography.Text type="secondary">
              {achievement.project?.name ?? '未关联项目'} ·{' '}
              {achievement.sourceType === 'manual' ? '人工' : '收集'}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: '选择状态',
        dataIndex: 'selectionStatus',
        render: (value: QuarterlyAchievementStatus) => (
          <Tag color={value === 'selected' ? 'green' : value === 'excluded' ? 'default' : 'orange'}>
            {selectionLabels[value]}
          </Tag>
        ),
      },
      {
        title: '证据',
        render: (_value, achievement) => (
          <Space>
            <Tag color={achievement.evidences.length > 0 ? 'blue' : 'orange'}>
              {achievement.evidences.length} 条
            </Tag>
            {achievement.warnings.length > 0 ? (
              <Tooltip title={achievement.warnings.join('；')}>
                <ExclamationCircleOutlined style={{ color: '#fa8c16' }} />
              </Tooltip>
            ) : null}
          </Space>
        ),
      },
      {
        title: '指标',
        render: (_value, achievement) =>
          achievement.metricLinks.length > 0
            ? achievement.metricLinks.map((link) => <Tag key={link.id}>{link.metricName}</Tag>)
            : '—',
      },
      {
        title: '周期',
        render: (_value, achievement) => `${achievement.periodStart}～${achievement.periodEnd}`,
      },
      {
        title: '操作',
        width: 250,
        render: (_value, achievement) => (
          <Space wrap>
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => openAchievementEditor(achievement)}
            >
              编辑
            </Button>
            <Button
              size="small"
              icon={<LinkOutlined />}
              onClick={() => {
                setEvidenceAchievement(achievement);
                evidenceForm.setFieldsValue({
                  availabilityState: 'available',
                  primaryEvidence: achievement.evidences.length === 0,
                });
              }}
            >
              添加证据
            </Button>
            {achievement.selectionStatus === 'selected' && review?.metricTemplate ? (
              <Button size="small" onClick={() => openMapping(achievement)}>
                指标映射
              </Button>
            ) : null}
          </Space>
        ),
      },
    ];
  }

  function openTemplateCreator(): void {
    templateForm.setFieldsValue({
      name: '',
      formulaType: 'weighted_average_100',
      roundingRule: 'half_up_1_decimal',
      metrics: [
        {
          code: 'delivery',
          name: '业务交付',
          definition: '依据已选成果和证据评价本周期业务交付质量',
          weight: 100,
          minimum: 1,
          maximum: 5,
          step: 0.5,
          required: true,
          enabled: true,
          minimumEvidence: 1,
        },
      ],
    });
    setTemplateOpen(true);
  }

  function openDecision(decision: NarrativeDecision): void {
    decisionForm.setFieldsValue({ reason: '' });
    setNarrativeDecision(decision);
  }

  function renderModalsAndDrawers() {
    return (
      <>
        <Modal
          title="创建考核周期"
          open={createOpen}
          onCancel={() => setCreateOpen(false)}
          onOk={() =>
            void createForm.validateFields().then((values) => createReview.mutate(values))
          }
          confirmLoading={createReview.isPending}
          width={680}
          destroyOnHidden
        >
          <Form
            form={createForm}
            layout="vertical"
            initialValues={{
              periodType: 'natural_quarter',
              year: dayjs().year(),
              quarter: Math.floor(dayjs().month() / 3) + 1,
            }}
          >
            <Form.Item name="periodType" label="周期类型">
              <Radio.Group
                optionType="button"
                options={[
                  { value: 'natural_quarter', label: '自然季度' },
                  { value: 'custom', label: '自定义周期' },
                ]}
              />
            </Form.Item>
            <Form.Item
              noStyle
              shouldUpdate={(
                before: Partial<CreateReviewValues>,
                after: Partial<CreateReviewValues>,
              ) => before.periodType !== after.periodType}
            >
              {({ getFieldValue }) =>
                getFieldValue('periodType') === 'natural_quarter' ? (
                  <div className="form-grid">
                    <Form.Item name="year" label="年份" rules={[{ required: true }]}>
                      <InputNumber min={2000} max={2100} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item name="quarter" label="季度" rules={[{ required: true }]}>
                      <Select
                        options={[1, 2, 3, 4].map((value) => ({ value, label: `Q${value}` }))}
                      />
                    </Form.Item>
                  </div>
                ) : (
                  <>
                    <Form.Item
                      name="name"
                      label="周期名称"
                      rules={[{ required: true, min: 2, max: 100 }]}
                    >
                      <Input maxLength={100} />
                    </Form.Item>
                    <Form.Item name="period" label="起止日期" rules={[{ required: true }]}>
                      <DatePicker.RangePicker style={{ width: '100%' }} />
                    </Form.Item>
                  </>
                )
              }
            </Form.Item>
          </Form>
          <Alert
            type="info"
            showIcon
            message="周期定义创建后冻结；日期变化需新建周期并保留旧版。"
          />
        </Modal>

        <Modal
          title="收集季度来源"
          open={collectOpen}
          onCancel={() => setCollectOpen(false)}
          onOk={() =>
            void collectForm.validateFields().then((values) => collectReview.mutate(values))
          }
          confirmLoading={collectReview.isPending}
          width={680}
        >
          <Form form={collectForm} layout="vertical">
            <Form.Item
              name="sources"
              label="纳入来源"
              rules={[{ required: true, message: '至少选择一种来源' }]}
            >
              <Checkbox.Group
                options={[
                  { value: 'tasks', label: '期间明确完成任务' },
                  { value: 'evidence', label: 'Git/GitLab/人工证据' },
                  { value: 'confirmedWeeklyReports', label: '已确认周报' },
                ]}
              />
            </Form.Item>
            <div className="form-grid">
              <Form.Item name="freshnessMode" label="新鲜度策略">
                <Select
                  options={[
                    { value: 'require_fresh', label: '严格：过期则阻断' },
                    { value: 'allow_stale', label: '允许过期但要求知悉' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="maximumAgeHours" label="最大来源年龄（小时）">
                <InputNumber min={1} max={2160} style={{ width: '100%' }} />
              </Form.Item>
            </div>
          </Form>
          <Alert
            type="warning"
            showIcon
            message="updated 时间不等于完成；Commit 数量、代码行数和工时不会推导绩效价值。"
          />
        </Modal>

        <Drawer
          title={editingAchievement ? '编辑成果并创建新版本' : '新增人工成果'}
          open={achievementOpen}
          onClose={() => setAchievementOpen(false)}
          width={760}
          extra={
            <Button
              type="primary"
              loading={saveAchievement.isPending}
              onClick={() =>
                void achievementForm
                  .validateFields()
                  .then((values) => saveAchievement.mutate(values))
              }
            >
              保存成果
            </Button>
          }
          destroyOnHidden
        >
          <Form form={achievementForm} layout="vertical">
            <Form.Item name="projectId" label="项目/业务域">
              <Select
                allowClear
                showSearch
                options={(projects.data?.data ?? [])
                  .filter((project) => project.enabled && !project.archivedAt)
                  .map((project) => ({ value: project.id, label: project.name }))}
              />
            </Form.Item>
            <Form.Item name="title" label="成果标题" rules={[{ required: true, max: 500 }]}>
              <Input maxLength={500} showCount />
            </Form.Item>
            <Form.Item name="period" label="成果发生周期" rules={[{ required: true }]}>
              <DatePicker.RangePicker
                {...(review
                  ? { minDate: dayjs(review.periodStart), maxDate: dayjs(review.periodEnd) }
                  : {})}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item
              name="situation"
              label="背景/目标（Situation / Objective）"
              rules={[{ required: true }]}
            >
              <Input.TextArea rows={4} maxLength={10000} showCount />
            </Form.Item>
            <Form.Item
              name="action"
              label="个人行动与职责边界（Action）"
              rules={[{ required: true }]}
            >
              <Input.TextArea rows={5} maxLength={20000} showCount />
            </Form.Item>
            <Form.Item name="result" label="可验证结果（Result）" rules={[{ required: true }]}>
              <Input.TextArea rows={5} maxLength={20000} showCount />
            </Form.Item>
            <Form.Item
              name="impact"
              label="业务/质量/效率影响（Impact）"
              rules={[{ required: true }]}
            >
              <Input.TextArea rows={5} maxLength={20000} showCount />
            </Form.Item>
            <Form.Item
              name="contributionBoundary"
              label="个人贡献边界"
              rules={[{ required: true }]}
            >
              <Input.TextArea rows={3} maxLength={5000} showCount />
            </Form.Item>
            {editingAchievement ? (
              <Form.Item
                name="changeReason"
                label="本次修改原因"
                rules={[{ required: true, min: 2, max: 500 }]}
              >
                <Input maxLength={500} showCount />
              </Form.Item>
            ) : null}
          </Form>
        </Drawer>

        <Modal
          title="批量候选决策"
          open={selectionOpen}
          onCancel={() => setSelectionOpen(false)}
          onOk={() =>
            void selectionForm.validateFields().then((values) => updateSelection.mutate(values))
          }
          confirmLoading={updateSelection.isPending}
        >
          <Alert
            type="info"
            showIcon
            message={`将更新 ${selectedAchievementIds.length} 项候选；被排除项仍保留。`}
            style={{ marginBottom: 16 }}
          />
          <Form form={selectionForm} layout="vertical">
            <Form.Item name="status" label="目标状态" rules={[{ required: true }]}>
              <Select
                options={Object.entries(selectionLabels).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </Form.Item>
            <Form.Item
              name="reason"
              label="人工决策原因"
              rules={[{ required: true, min: 2, max: 500 }]}
            >
              <Input.TextArea rows={3} maxLength={500} showCount />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          title={`添加人工证据 · ${evidenceAchievement?.title ?? ''}`}
          open={Boolean(evidenceAchievement)}
          onCancel={() => setEvidenceAchievement(null)}
          onOk={() =>
            void evidenceForm.validateFields().then((values) => addEvidence.mutate(values))
          }
          confirmLoading={addEvidence.isPending}
          width={680}
          destroyOnHidden
        >
          <Form form={evidenceForm} layout="vertical">
            <Form.Item name="title" label="证据标题" rules={[{ required: true, max: 500 }]}>
              <Input maxLength={500} />
            </Form.Item>
            <div className="form-grid">
              <Form.Item name="externalKey" label="外部 ID">
                <Input maxLength={500} />
              </Form.Item>
              <Form.Item name="eventAt" label="发生时间">
                <DatePicker showTime style={{ width: '100%' }} />
              </Form.Item>
            </div>
            <Form.Item name="url" label="可点击 URL" rules={[{ type: 'url' }]}>
              <Input maxLength={2000} />
            </Form.Item>
            <Form.Item name="summary" label="当时摘要（不会抓取链接正文）">
              <Input.TextArea rows={3} />
            </Form.Item>
            <Form.Item
              name="contributionAngle"
              label="对本成果的贡献角度"
              rules={[{ required: true, min: 2, max: 2000 }]}
            >
              <Input.TextArea rows={3} maxLength={2000} showCount />
            </Form.Item>
            <div className="form-grid">
              <Form.Item name="availabilityState" label="可用状态">
                <Select
                  options={[
                    { value: 'available', label: '可用' },
                    { value: 'unavailable', label: '不可用' },
                    { value: 'unknown', label: '未知' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="primaryEvidence" valuePropName="checked" label="证据角色">
                <Checkbox>设为主证据</Checkbox>
              </Form.Item>
            </div>
          </Form>
        </Modal>

        <Modal
          title={`指标映射 · ${mappingAchievement?.title ?? ''}`}
          open={Boolean(mappingAchievement)}
          onCancel={() => setMappingAchievement(null)}
          onOk={() =>
            void mappingForm.validateFields().then((values) => updateMappings.mutate(values))
          }
          confirmLoading={updateMappings.isPending}
          width={760}
          destroyOnHidden
        >
          <Alert
            type="info"
            showIcon
            message="同一成果可映射多个指标，但每条都必须说明不同贡献角度。"
            style={{ marginBottom: 16 }}
          />
          <Form form={mappingForm} layout="vertical">
            <Form.List name="links">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {fields.map((field) => (
                    <Card
                      key={field.key}
                      size="small"
                      extra={
                        <Button danger size="small" onClick={() => remove(field.name)}>
                          移除
                        </Button>
                      }
                    >
                      <Form.Item
                        name={[field.name, 'metricId']}
                        label="指标"
                        rules={[{ required: true }]}
                      >
                        <Select
                          options={(review?.metricTemplate?.metrics ?? [])
                            .filter((metric) => metric.enabled)
                            .map((metric) => ({
                              value: metric.id,
                              label: `${metric.name}（${metric.weight}%）`,
                            }))}
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'contribution']}
                        label="贡献说明"
                        rules={[{ required: true, min: 2, max: 2000 }]}
                      >
                        <Input.TextArea rows={3} maxLength={2000} showCount />
                      </Form.Item>
                    </Card>
                  ))}
                  <Button
                    block
                    icon={<PlusOutlined />}
                    onClick={() => add({ metricId: undefined, contribution: '' })}
                  >
                    添加指标映射
                  </Button>
                </Space>
              )}
            </Form.List>
          </Form>
        </Modal>

        <Drawer
          title="创建版本化指标模板"
          open={templateOpen}
          onClose={() => setTemplateOpen(false)}
          width={900}
          extra={
            <Button
              type="primary"
              loading={createTemplate.isPending}
              onClick={() =>
                void templateForm.validateFields().then((values) => createTemplate.mutate(values))
              }
            >
              创建并冻结 v1
            </Button>
          }
          destroyOnHidden
        >
          <Form form={templateForm} layout="vertical">
            <Form.Item name="name" label="模板名称" rules={[{ required: true, min: 2, max: 100 }]}>
              <Input />
            </Form.Item>
            <div className="form-grid">
              <Form.Item name="formulaType" label="总分公式">
                <Select
                  options={Object.entries(formulaLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </Form.Item>
              <Form.Item name="roundingRule" label="取整规则">
                <Select
                  options={Object.entries(roundingLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </Form.Item>
            </div>
            <Form.List name="metrics">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {fields.map((field, index) => (
                    <Card
                      key={field.key}
                      title={`指标 ${index + 1}`}
                      size="small"
                      extra={
                        fields.length > 1 ? (
                          <Button danger size="small" onClick={() => remove(field.name)}>
                            删除
                          </Button>
                        ) : null
                      }
                    >
                      <div className="form-grid">
                        <Form.Item
                          name={[field.name, 'code']}
                          label="稳定代码"
                          rules={[{ required: true, pattern: /^[A-Za-z0-9._-]+$/u }]}
                        >
                          <Input />
                        </Form.Item>
                        <Form.Item
                          name={[field.name, 'name']}
                          label="名称"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </div>
                      <Form.Item
                        name={[field.name, 'definition']}
                        label="定义"
                        rules={[{ required: true }]}
                      >
                        <Input.TextArea rows={3} />
                      </Form.Item>
                      <div className="quarterly-metric-number-grid">
                        <Form.Item name={[field.name, 'weight']} label="权重">
                          <InputNumber min={0} max={10000} />
                        </Form.Item>
                        <Form.Item name={[field.name, 'minimum']} label="最小分">
                          <InputNumber />
                        </Form.Item>
                        <Form.Item name={[field.name, 'maximum']} label="最大分">
                          <InputNumber />
                        </Form.Item>
                        <Form.Item name={[field.name, 'step']} label="步长">
                          <InputNumber min={0.000001} />
                        </Form.Item>
                        <Form.Item name={[field.name, 'minimumEvidence']} label="最少证据">
                          <InputNumber min={0} precision={0} />
                        </Form.Item>
                      </div>
                      <Space>
                        <Form.Item name={[field.name, 'required']} valuePropName="checked">
                          <Checkbox>必填指标</Checkbox>
                        </Form.Item>
                        <Form.Item name={[field.name, 'enabled']} valuePropName="checked">
                          <Checkbox>启用</Checkbox>
                        </Form.Item>
                      </Space>
                    </Card>
                  ))}
                  <Button
                    block
                    icon={<PlusOutlined />}
                    onClick={() =>
                      add({
                        code: '',
                        name: '',
                        definition: '',
                        weight: 0,
                        minimum: 1,
                        maximum: 5,
                        step: 0.5,
                        required: true,
                        enabled: true,
                        minimumEvidence: 1,
                      })
                    }
                  >
                    添加指标
                  </Button>
                </Space>
              )}
            </Form.List>
          </Form>
        </Drawer>

        <Drawer
          title="人工编辑自评并创建新版本"
          open={narrativeOpen}
          onClose={() => setNarrativeOpen(false)}
          width={920}
          extra={
            <Button
              type="primary"
              loading={saveNarrative.isPending}
              onClick={() =>
                void narrativeForm.validateFields().then((values) => saveNarrative.mutate(values))
              }
            >
              保存新版本
            </Button>
          }
          destroyOnHidden
        >
          <Form form={narrativeForm} layout="vertical">
            <Form.Item name="overallOverview" label="总体概述" rules={[{ required: true }]}>
              <Input.TextArea rows={5} maxLength={30000} showCount />
            </Form.Item>
            <Divider titlePlacement="start">核心成果段落</Divider>
            <Form.List name="coreAchievements">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {fields.map((field, index) => (
                    <Card
                      key={field.key}
                      title={`核心成果 ${index + 1}`}
                      extra={
                        fields.length > 1 ? (
                          <Button danger size="small" onClick={() => remove(field.name)}>
                            移除
                          </Button>
                        ) : null
                      }
                    >
                      <Form.Item
                        name={[field.name, 'heading']}
                        label="标题"
                        rules={[{ required: true }]}
                      >
                        <Input />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'body']}
                        label="正文"
                        rules={[{ required: true }]}
                      >
                        <Input.TextArea rows={6} />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'achievementIds']}
                        label="引用成果"
                        rules={[{ required: true, type: 'array', min: 1 }]}
                      >
                        <Select
                          mode="multiple"
                          options={selectedAchievements.map((achievement) => ({
                            value: achievement.id,
                            label: achievement.title,
                          }))}
                        />
                      </Form.Item>
                      <Form.Item name={[field.name, 'metricIds']} label="引用指标">
                        <Select
                          mode="multiple"
                          options={(review?.metricTemplate?.metrics ?? []).map((metric) => ({
                            value: metric.id,
                            label: metric.name,
                          }))}
                        />
                      </Form.Item>
                      <Form.Item name={[field.name, 'evidenceIds']} label="引用证据">
                        <Select
                          mode="multiple"
                          options={selectedAchievements.flatMap((achievement) =>
                            achievement.evidences.map((evidence) => ({
                              value: evidence.id,
                              label: `${achievement.title} / ${evidence.title}`,
                            })),
                          )}
                        />
                      </Form.Item>
                    </Card>
                  ))}
                  <Button
                    block
                    icon={<PlusOutlined />}
                    onClick={() =>
                      add({
                        heading: '',
                        body: '',
                        achievementIds: [],
                        metricIds: [],
                        evidenceIds: [],
                      })
                    }
                  >
                    添加核心成果段落
                  </Button>
                </Space>
              )}
            </Form.List>
            <Divider />
            <Form.Item
              name="collaborationAndGrowth"
              label="协作与能力成长"
              rules={[{ required: true }]}
            >
              <Input.TextArea rows={5} />
            </Form.Item>
            <Form.Item
              name="problemsAndImprovements"
              label="问题和改进"
              rules={[{ required: true }]}
            >
              <Input.TextArea rows={5} />
            </Form.Item>
            <Form.Item name="nextPeriodPlan" label="下一周期计划" rules={[{ required: true }]}>
              <Input.TextArea rows={5} />
            </Form.Item>
            <Form.Item
              name="changeReason"
              label="本次人工修改原因"
              rules={[{ required: true, min: 2, max: 1000 }]}
            >
              <Input maxLength={1000} showCount />
            </Form.Item>
          </Form>
        </Drawer>

        <Drawer
          title="自评版本历史"
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          width={700}
        >
          <List
            dataSource={narratives.data?.data ?? []}
            renderItem={(version) => (
              <List.Item
                actions={[
                  <Button
                    key="restore"
                    size="small"
                    disabled={version.id === review?.currentNarrativeVersionId}
                    onClick={() => openDecision({ kind: 'restore', version })}
                  >
                    恢复为新版本
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Tag>{narrativeOriginLabels[version.origin]}</Tag>
                      <Typography.Text>v{version.versionNo}</Typography.Text>
                      {version.id === review?.currentNarrativeVersionId ? (
                        <Tag color="green">当前</Tag>
                      ) : null}
                    </Space>
                  }
                  description={
                    <>
                      <Typography.Text type="secondary">
                        {new Date(version.createdAt).toLocaleString()}
                      </Typography.Text>
                      <br />
                      <Typography.Text code>{version.contentHash.slice(0, 20)}…</Typography.Text>
                    </>
                  }
                />
              </List.Item>
            )}
          />
        </Drawer>

        <Modal
          title={
            narrativeDecision?.kind === 'restore'
              ? '恢复历史版本'
              : narrativeDecision?.kind === 'adopt'
                ? '采纳 AI 自评候选'
                : '拒绝 AI 建议'
          }
          open={Boolean(narrativeDecision)}
          onCancel={() => setNarrativeDecision(null)}
          onOk={() =>
            void decisionForm.validateFields().then((values) => decideNarrative.mutate(values))
          }
          confirmLoading={decideNarrative.isPending}
        >
          <Alert
            type="warning"
            showIcon
            message={
              narrativeDecision?.kind === 'restore'
                ? '恢复会复制内容并创建新的人工版本，历史版本本身不变。'
                : narrativeDecision?.kind === 'adopt'
                  ? '采纳会创建人工版本；AI 原始候选仍单独保留。'
                  : '拒绝是终态决策，不会删除生成记录。'
            }
            style={{ marginBottom: 16 }}
          />
          <Form form={decisionForm} layout="vertical">
            <Form.Item
              name="reason"
              label="决策原因"
              rules={[{ required: true, min: 2, max: 1000 }]}
            >
              <Input.TextArea rows={4} maxLength={1000} showCount />
            </Form.Item>
          </Form>
        </Modal>

        <Drawer
          title="AI 输入边界与生成事实"
          open={Boolean(selectedAiGenerationId)}
          onClose={() => setSelectedAiGenerationId(null)}
          width={760}
        >
          {selectedAiGeneration.isLoading ? (
            <Card loading />
          ) : selectedAiGeneration.data?.data ? (
            <AiGenerationDetail generation={selectedAiGeneration.data.data} />
          ) : (
            <Empty />
          )}
        </Drawer>

        <Modal
          title="确认并冻结季度绩效快照"
          open={confirmOpen}
          onCancel={() => setConfirmOpen(false)}
          onOk={() => confirmReview.mutate()}
          okText="确认冻结，不对外提交"
          confirmLoading={confirmReview.isPending}
          width={760}
        >
          <Alert
            type="warning"
            showIcon
            message="本操作会锁定当前成果、证据、指标模板、用户分、计算、自评和完整性知悉。"
            description="它不会发送文件或写入任何公司系统；后续编辑会使此确认失效。"
          />
          <Divider />
          {currentNarrative.data?.data.content ? (
            <NarrativePreview
              content={currentNarrative.data.data.content}
              achievements={allReviewAchievements}
              compact
            />
          ) : null}
        </Modal>

        <Drawer
          title="导出结构验收与渲染事实"
          open={Boolean(selectedExportId)}
          onClose={() => setSelectedExportId(null)}
          width={760}
        >
          {selectedExport.isLoading ? (
            <Card loading />
          ) : selectedExport.data?.data ? (
            <>
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="制品 ID">{selectedExport.data.data.id}</Descriptions.Item>
                <Descriptions.Item label="确认快照">
                  {selectedExport.data.data.inputSnapshotHash}
                </Descriptions.Item>
                <Descriptions.Item label="内容哈希">
                  {selectedExport.data.data.contentHash ?? '—'}
                </Descriptions.Item>
                <Descriptions.Item label="文件大小">
                  {formatFileSize(selectedExport.data.data.sizeBytes)}
                </Descriptions.Item>
                <Descriptions.Item label="模板版本">
                  {selectedExport.data.data.templateVersion}
                </Descriptions.Item>
                <Descriptions.Item label="状态">
                  <StatusTag status={selectedExport.data.data.status} />
                </Descriptions.Item>
                <Descriptions.Item label="结构 QA">
                  <StatusTag status={selectedExport.data.data.qaStatus} />
                </Descriptions.Item>
              </Descriptions>
              <Divider titlePlacement="start">QA 报告</Divider>
              <pre className="safe-json">
                {JSON.stringify(selectedExport.data.data.qaReport ?? {}, null, 2)}
              </pre>
              <Divider titlePlacement="start">渲染事实</Divider>
              <pre className="safe-json">
                {JSON.stringify(selectedExport.data.data.rendererFacts ?? {}, null, 2)}
              </pre>
            </>
          ) : (
            <Empty />
          )}
        </Drawer>
      </>
    );
  }
}

function CompletenessFacts({ completeness }: { completeness: QuarterlyCompleteness }) {
  const entries: Array<[string, string]> = [
    ['来源新鲜度', completeness.sourceFreshness ?? 'not_collected'],
    ['证据覆盖率', percentage(completeness.evidenceCoverage)],
    ['必填指标覆盖率', percentage(completeness.requiredMetricCoverage)],
    ['评分理由覆盖率', percentage(completeness.scoreReasonCoverage)],
    ['未解决冲突', String(completeness.unresolvedConflictCount ?? 0)],
  ];
  return (
    <Descriptions
      column={1}
      bordered
      size="small"
      items={entries.map(([label, value]) => ({ key: label, label, children: value }))}
    />
  );
}

function AchievementDetail({ achievement }: { achievement: QuarterlyAchievement }) {
  return (
    <div className="quarterly-achievement-detail">
      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label="背景/目标">{achievement.situation}</Descriptions.Item>
        <Descriptions.Item label="个人行动">{achievement.action}</Descriptions.Item>
        <Descriptions.Item label="可验证结果">{achievement.result}</Descriptions.Item>
        <Descriptions.Item label="影响">{achievement.impact}</Descriptions.Item>
        <Descriptions.Item label="贡献边界">{achievement.contributionBoundary}</Descriptions.Item>
        {achievement.exclusionReason ? (
          <Descriptions.Item label="排除原因">{achievement.exclusionReason}</Descriptions.Item>
        ) : null}
      </Descriptions>
      <Divider titlePlacement="start">证据与贡献角度</Divider>
      <List
        size="small"
        dataSource={achievement.evidences}
        locale={{ emptyText: '暂无证据' }}
        renderItem={(evidence) => (
          <List.Item>
            <List.Item.Meta
              title={
                <Space>
                  {evidence.primaryEvidence ? <Tag color="blue">主证据</Tag> : <Tag>辅助</Tag>}
                  {evidence.url ? (
                    <Typography.Link href={evidence.url} target="_blank" rel="noreferrer">
                      {evidence.title}
                    </Typography.Link>
                  ) : (
                    <Typography.Text>{evidence.title}</Typography.Text>
                  )}
                  {evidence.duplicateInReview ? <Tag color="orange">重复引用</Tag> : null}
                </Space>
              }
              description={`${evidence.contributionAngle} · ${evidence.availabilityState} · ${evidence.eventAt ? new Date(evidence.eventAt).toLocaleString() : '无时间'}`}
            />
          </List.Item>
        )}
      />
    </div>
  );
}

function NarrativePreview({
  content,
  achievements,
  compact = false,
}: {
  content: QuarterlyNarrativeContent;
  achievements: QuarterlyAchievement[];
  compact?: boolean;
}) {
  const achievementById = new Map(achievements.map((achievement) => [achievement.id, achievement]));
  return (
    <Space direction="vertical" size={compact ? 10 : 18} style={{ width: '100%' }}>
      <section>
        <Typography.Title level={5}>总体概述</Typography.Title>
        <Typography.Paragraph className="quarterly-narrative-text">
          {content.overallOverview}
        </Typography.Paragraph>
      </section>
      <section>
        <Typography.Title level={5}>核心成果</Typography.Title>
        <Space direction="vertical" style={{ width: '100%' }}>
          {content.coreAchievements.map((item, index) => (
            <Card
              size="small"
              key={`${item.heading}-${index}`}
              title={item.heading}
              extra={<Tag>{item.achievementIds.length} 项事实</Tag>}
            >
              <Typography.Paragraph className="quarterly-narrative-text">
                {item.body}
              </Typography.Paragraph>
              <Space wrap>
                {item.achievementIds.map((id) => (
                  <Tag key={id}>{achievementById.get(id)?.title ?? id}</Tag>
                ))}
              </Space>
            </Card>
          ))}
        </Space>
      </section>
      {!compact ? (
        <>
          <section>
            <Typography.Title level={5}>协作与能力成长</Typography.Title>
            <Typography.Paragraph className="quarterly-narrative-text">
              {content.collaborationAndGrowth}
            </Typography.Paragraph>
          </section>
          <section>
            <Typography.Title level={5}>问题和改进</Typography.Title>
            <Typography.Paragraph className="quarterly-narrative-text">
              {content.problemsAndImprovements}
            </Typography.Paragraph>
          </section>
          <section>
            <Typography.Title level={5}>下一周期计划</Typography.Title>
            <Typography.Paragraph className="quarterly-narrative-text">
              {content.nextPeriodPlan}
            </Typography.Paragraph>
          </section>
        </>
      ) : null}
    </Space>
  );
}

function AiGenerationDetail({ generation }: { generation: QuarterlyAiGeneration }) {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type={generation.stale ? 'warning' : 'info'}
        showIcon
        message={
          generation.stale ? '该建议基线已过期，只可查看' : '输入经过白名单净化，模型没有写操作工具'
        }
      />
      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label="用途">{generation.purpose}</Descriptions.Item>
        <Descriptions.Item label="协议 / 模型">
          {generation.protocol} / {generation.model}
        </Descriptions.Item>
        <Descriptions.Item label="基线版本">{generation.baseReviewVersion}</Descriptions.Item>
        <Descriptions.Item label="净化策略">
          {generation.sanitizationPolicyVersion}
        </Descriptions.Item>
        <Descriptions.Item label="输入哈希">
          {generation.sanitizedInputHash ?? '—'}
        </Descriptions.Item>
        <Descriptions.Item label="状态">
          <StatusTag status={generation.status} />
        </Descriptions.Item>
        <Descriptions.Item label="人工决策">{generation.adoptionStatus}</Descriptions.Item>
        <Descriptions.Item label="耗时">{generation.durationMs ?? '—'} ms</Descriptions.Item>
      </Descriptions>
      <Divider titlePlacement="start">发送类别 / 移除类别</Divider>
      <pre className="safe-json">
        {JSON.stringify(
          {
            inputCategories: generation.inputCategories,
            removedCategories: generation.removedCategories,
            inputRefs: generation.inputRefs,
          },
          null,
          2,
        )}
      </pre>
      <Divider titlePlacement="start">结构化输出</Divider>
      <pre className="safe-json">{JSON.stringify(generation.parsedOutput ?? {}, null, 2)}</pre>
    </Space>
  );
}

function emptyScore(metricId: string): QuarterlyScoreItem {
  return {
    id: `draft-${metricId}`,
    metricId,
    aiSuggestedScore: null,
    aiSuggestedMinimum: null,
    aiSuggestedMaximum: null,
    aiReason: null,
    aiEvidenceGaps: [],
    aiUncertainty: null,
    userScore: null,
    userReason: null,
    rawContribution: null,
    validationStatus: 'missing',
    version: 1,
  };
}

function percentage(value: unknown): string {
  const number = Number(value ?? 0);
  return `${number <= 1 ? (number * 100).toFixed(0) : number.toFixed(0)}%`;
}
