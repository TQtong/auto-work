import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  DiffOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  ExperimentOutlined,
  FileAddOutlined,
  HistoryOutlined,
  CopyOutlined,
  RedoOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SendOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
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
  List,
  Modal,
  Segmented,
  Select,
  Space,
  Steps,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiClientError, apiRequest, type ApiEnvelope } from '../api/client.js';
import type {
  DingTalkTemplateMappingHistory,
  Integration,
  WeeklyReport,
  WeeklyReportDeliveryIntent,
  WeeklyReportExportCopy,
  WeeklyReportRobotNotification,
  WeeklyAiGeneration,
  WeeklyAiGenerationList,
  WeeklyAiSuggestionResult,
  WeeklyReportList,
  WeeklyReportVersion,
  WeeklyReportVersionSummary,
} from '../api/types.js';
import {
  deliveryRecoveryActions,
  canNotifyFormalLogFailure,
  currentLogDeliveryIntent,
  deliveryRecoveryOutcomeLabel,
  deliveryRecoveryStatusLabel,
  eligibleSevereRiskWarnings,
  latestUnresolvedLogDeliveryIntent,
} from './weekly-report-delivery-view-model.js';
import {
  compareWeeklyFields,
  previousVersionId,
  weeklyReportFields,
} from './weekly-report-view-model.js';

interface EditorValues {
  reportDate: Dayjs;
  recentGoals: string;
  weeklyWork: string;
  nextWeekPlans: string;
  problems: string;
  other: string;
}

interface ReportMutationResult {
  replayed: boolean;
  report: WeeklyReport;
  version: WeeklyReportVersion;
}

interface GenerateResult extends ReportMutationResult {
  sourceSnapshot: WeeklyReportVersion['sourceSnapshot'];
}

interface ConfirmResult {
  replayed: boolean;
  report: WeeklyReport;
  confirmation: NonNullable<WeeklyReport['currentConfirmation']>;
}

interface EditAction {
  reportId: string;
  baseVersionId: string;
  reportVersion: number;
  fields?: WeeklyReportVersion['fields'];
  attachmentIds?: string[];
  recipientValidationIds?: string[];
  templateMappingVersionId?: string | null;
  scheduleAt?: string | null;
  changeReason: string;
  source: 'autosave' | 'manual' | 'metadata' | 'attachment';
}

interface AiSuggestionFormValues {
  providerConnectionId: string;
  fields: Array<'recentGoals' | 'weeklyWork' | 'nextWeekPlans' | 'problems' | 'other'>;
  allowPeopleNames: boolean;
  allowInternalUrls: boolean;
  allowDescriptionSummaries: boolean;
}

interface AiDecisionResult {
  replayed: boolean;
  generation: WeeklyAiGeneration;
  adoptedVersion?: WeeklyReportVersionSummary;
  report?: { id: string; currentVersionId: string; version: number; status: string };
}

interface DeliveryRequestResult {
  replayed: boolean;
  jobId: string | null;
  intent: WeeklyReportDeliveryIntent;
}

interface DeliveryRecoveryResult {
  intentId: string;
  status: WeeklyReportDeliveryIntent['status'];
  recoveryStatus: WeeklyReportDeliveryIntent['recoveryStatus'];
  externalId?: string | null;
  candidateCount?: number;
  exactMatchCount?: number;
  retryAllowed: boolean;
  outcome?: string;
  errorCode?: string;
}

interface DeliveryRetryResult {
  intentId: string;
  status: 'pending';
  jobId: string;
  nextAttemptNo: number;
}

interface NotificationRequestResult {
  notification: WeeklyReportRobotNotification;
  disposition: 'created' | 'duplicate' | 'coalesced';
  jobId: string | null;
}

interface ManualResolutionValues {
  resolution: 'delivered' | 'not_delivered';
  externalId?: string;
  externalUrl?: string;
  reason: string;
  confirmationPhrase: string;
}

interface DeliveryRetryValues {
  reason: string;
}

interface SubmissionOperationLog {
  key: string;
  timestamp: string;
  status: 'waiting' | 'running' | 'success' | 'error';
  title: string;
  detail?: string;
}

interface WeeklyReportContentTemplate {
  id: string | null;
  version: number;
  fields: Pick<
    WeeklyReportVersion['fields'],
    'recentGoals' | 'weeklyWork' | 'nextWeekPlans' | 'problems' | 'other'
  >;
  updatedAt: string | null;
}

const workflowItems = [{ title: '准备内容' }, { title: '钉钉自动填写' }, { title: '提交完成' }];

type DirectSubmitStage = 'idle' | 'saving_content' | 'saving_settings' | 'preparing' | 'queuing';

// 旧的群机器人测试、双通道恢复账本和来源审计仅保留在代码中供历史数据兼容，
// 不再进入日常周报工作流。
const SHOW_INTERNAL_WEEKLY_TOOLS = false;

const originLabels: Record<string, string> = {
  rule: '规则生成',
  manual: '人工编辑',
  restore: '历史恢复',
  ai: 'AI 建议',
};

export function WeeklyReportsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const requestedReportId = searchParams.get('reportId');
  const [messageApi, holder] = message.useMessage();
  const [form] = Form.useForm<EditorValues>();
  const [generateForm] = Form.useForm<{
    customPeriod: boolean;
    period: [Dayjs, Dayjs];
    reportDate: Dayjs;
    freshnessMode: 'require_fresh' | 'allow_stale';
    includeUnconfirmedEvidence: boolean;
  }>();
  const [aiForm] = Form.useForm<AiSuggestionFormValues>();
  const [manualResolutionForm] = Form.useForm<ManualResolutionValues>();
  const [deliveryRetryForm] = Form.useForm<DeliveryRetryValues>();
  const [contentTemplateForm] = Form.useForm<WeeklyReportContentTemplate['fields']>();
  const [selectedReportId, setSelectedReportId] = useState<string | null>(requestedReportId);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [contentTemplateOpen, setContentTemplateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [selectedAiGenerationId, setSelectedAiGenerationId] = useState<string | null>(null);
  const [compareVersionId, setCompareVersionId] = useState<string | null>(null);
  const [selectedMappingId, setSelectedMappingId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>([]);
  const [selectedSchedule, setSelectedSchedule] = useState<Dayjs | null>(null);
  const [submissionSettingsDirty, setSubmissionSettingsDirty] = useState(false);
  const [selectedRobotConnectionId, setSelectedRobotConnectionId] = useState<string | null>(null);
  const [riskNotificationOpen, setRiskNotificationOpen] = useState(false);
  const [exportCopyPreview, setExportCopyPreview] = useState<WeeklyReportExportCopy | null>(null);
  const [selectedRiskWarningIds, setSelectedRiskWarningIds] = useState<string[]>([]);
  const [manualResolutionIntent, setManualResolutionIntent] =
    useState<WeeklyReportDeliveryIntent | null>(null);
  const [deliveryRetryIntent, setDeliveryRetryIntent] = useState<WeeklyReportDeliveryIntent | null>(
    null,
  );
  const [dirty, setDirty] = useState(false);
  const [autosaveState, setAutosaveState] = useState<
    'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'
  >('idle');
  const [directSubmitStage, setDirectSubmitStage] = useState<DirectSubmitStage>('idle');
  const [submissionOperationLogs, setSubmissionOperationLogs] = useState<SubmissionOperationLog[]>(
    [],
  );
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locallySavedVersionId = useRef<string | null>(null);

  const recordSubmissionOperation = useCallback(
    (key: string, status: SubmissionOperationLog['status'], title: string, detail?: string) => {
      setSubmissionOperationLogs((current) => {
        const next: SubmissionOperationLog = {
          key,
          timestamp: new Date().toISOString(),
          status,
          title,
          ...(detail ? { detail } : {}),
        };
        const existing = current.findIndex((item) => item.key === key);
        if (existing < 0) return [...current, next];
        return current.map((item, index) => (index === existing ? { ...item, ...next } : item));
      });
    },
    [],
  );

  const reports = useQuery({
    queryKey: ['weekly-reports'],
    queryFn: () => apiRequest<WeeklyReportList>('/api/v1/weekly-reports?limit=100'),
    refetchInterval: 30_000,
  });
  const contentTemplate = useQuery({
    queryKey: ['weekly-report-content-template'],
    queryFn: () =>
      apiRequest<WeeklyReportContentTemplate>('/api/v1/weekly-reports/content-template'),
  });
  const reportItems = reports.data?.data.items ?? [];

  useEffect(() => {
    if (
      requestedReportId &&
      reportItems.some((report) => report.id === requestedReportId) &&
      selectedReportId !== requestedReportId
    ) {
      setSelectedReportId(requestedReportId);
      return;
    }
    if (!selectedReportId && reportItems[0]) setSelectedReportId(reportItems[0].id);
    if (
      selectedReportId &&
      reportItems.length > 0 &&
      !reportItems.some((report) => report.id === selectedReportId)
    ) {
      setSelectedReportId(reportItems[0]?.id ?? null);
    }
  }, [reportItems, requestedReportId, selectedReportId]);

  const reportDetail = useQuery({
    queryKey: ['weekly-report', selectedReportId],
    queryFn: () => {
      if (!selectedReportId) throw new Error('尚未选择周报');
      return apiRequest<WeeklyReport>(`/api/v1/weekly-reports/${selectedReportId}`);
    },
    enabled: Boolean(selectedReportId),
  });
  const report = reportDetail.data?.data ?? null;
  const currentVersionId = report?.currentVersionId ?? null;
  const versionDetail = useQuery({
    queryKey: ['weekly-report-version', selectedReportId, currentVersionId],
    queryFn: () => {
      if (!selectedReportId || !currentVersionId) throw new Error('当前周报版本不存在');
      return apiRequest<WeeklyReportVersion>(
        `/api/v1/weekly-reports/${selectedReportId}/versions/${currentVersionId}`,
      );
    },
    enabled: Boolean(selectedReportId && currentVersionId),
  });
  const version = versionDetail.data?.data ?? null;
  const versions = useQuery({
    queryKey: ['weekly-report-versions', selectedReportId],
    queryFn: () => {
      if (!selectedReportId) throw new Error('尚未选择周报');
      return apiRequest<WeeklyReportVersionSummary[]>(
        `/api/v1/weekly-reports/${selectedReportId}/versions`,
      );
    },
    enabled: Boolean(selectedReportId),
  });
  const deliveries = useQuery({
    queryKey: ['weekly-report-deliveries', selectedReportId],
    queryFn: () => {
      if (!selectedReportId) throw new Error('尚未选择周报');
      return apiRequest<WeeklyReportDeliveryIntent[]>(
        `/api/v1/weekly-reports/${selectedReportId}/deliveries`,
      );
    },
    enabled: Boolean(selectedReportId),
    refetchInterval: 3_000,
  });
  const notifications = useQuery({
    queryKey: ['weekly-report-notifications', selectedReportId],
    queryFn: () => {
      if (!selectedReportId) throw new Error('尚未选择周报');
      return apiRequest<WeeklyReportRobotNotification[]>(
        `/api/v1/weekly-reports/${selectedReportId}/notifications`,
      );
    },
    enabled: Boolean(selectedReportId),
    refetchInterval: 3_000,
  });
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiRequest<Integration[]>('/api/v1/integrations'),
  });
  const aiConnections = useMemo(
    () =>
      (integrations.data?.data ?? []).filter(
        (connection) => connection.type === 'ai' && connection.enabled,
      ),
    [integrations.data],
  );
  const healthyRobotConnections = useMemo(
    () =>
      (integrations.data?.data ?? []).filter(
        (connection) =>
          connection.type === 'dingtalk_robot' &&
          connection.enabled &&
          connection.status === 'healthy' &&
          !connection.credentialReplacementPending,
      ),
    [integrations.data],
  );
  const aiGenerations = useQuery({
    queryKey: ['weekly-report-ai-generations', selectedReportId],
    queryFn: () => {
      if (!selectedReportId) throw new Error('尚未选择周报');
      return apiRequest<WeeklyAiGenerationList>(
        `/api/v1/weekly-reports/${selectedReportId}/ai-generations`,
      );
    },
    enabled: Boolean(selectedReportId),
  });
  const aiGenerationDetail = useQuery({
    queryKey: ['weekly-report-ai-generation', selectedReportId, selectedAiGenerationId],
    queryFn: () => {
      if (!selectedReportId || !selectedAiGenerationId) throw new Error('尚未选择 AI 生成记录');
      return apiRequest<WeeklyAiGeneration>(
        `/api/v1/weekly-reports/${selectedReportId}/ai-generations/${selectedAiGenerationId}`,
      );
    },
    enabled: Boolean(selectedReportId && selectedAiGenerationId),
  });
  const dingtalkConnections = useMemo(
    () =>
      (integrations.data?.data ?? []).filter((connection) =>
        ['dingtalk_log', 'dingtalk_desktop'].includes(connection.type),
      ),
    [integrations.data],
  );
  const mappingQueries = useQueries({
    queries: dingtalkConnections.map((connection) => ({
      queryKey: ['dingtalk-template-mappings', connection.id],
      queryFn: () =>
        apiRequest<DingTalkTemplateMappingHistory>(
          `/api/v1/integrations/${connection.id}/dingtalk/template-mappings`,
        ),
      staleTime: 30_000,
    })),
  });
  const currentMappings = mappingQueries.flatMap((query) => {
    const history = query.data?.data;
    return history
      ? history.versions.filter((mapping) => mapping.id === history.currentVersionId)
      : [];
  });
  const comparedVersion = useQuery({
    queryKey: ['weekly-report-version', selectedReportId, compareVersionId],
    queryFn: () => {
      if (!selectedReportId || !compareVersionId) throw new Error('尚未选择比较版本');
      return apiRequest<WeeklyReportVersion>(
        `/api/v1/weekly-reports/${selectedReportId}/versions/${compareVersionId}`,
      );
    },
    enabled: Boolean(selectedReportId && compareVersionId),
  });

  const invalidateReport = async (reportId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['weekly-reports'] }),
      queryClient.invalidateQueries({ queryKey: ['weekly-report', reportId] }),
      queryClient.invalidateQueries({ queryKey: ['weekly-report-versions', reportId] }),
      queryClient.invalidateQueries({ queryKey: ['weekly-report-version', reportId] }),
      queryClient.invalidateQueries({ queryKey: ['weekly-report-attachments', reportId] }),
      queryClient.invalidateQueries({ queryKey: ['weekly-report-ai-generations', reportId] }),
      queryClient.invalidateQueries({ queryKey: ['weekly-report-ai-generation', reportId] }),
      queryClient.invalidateQueries({ queryKey: ['weekly-report-deliveries', reportId] }),
      queryClient.invalidateQueries({ queryKey: ['weekly-report-notifications', reportId] }),
    ]);
  };

  const applyLocalEditResult = (response: ApiEnvelope<ReportMutationResult>) => {
    const updatedReport = response.data.report;
    const updatedVersion = response.data.version;
    locallySavedVersionId.current = updatedVersion.id;
    queryClient.setQueryData<ApiEnvelope<WeeklyReport>>(
      ['weekly-report', updatedReport.id],
      (cached) => ({
        data: updatedReport,
        meta: cached?.meta ?? response.meta,
      }),
    );
    queryClient.setQueryData<ApiEnvelope<WeeklyReportVersion>>(
      ['weekly-report-version', updatedReport.id, updatedVersion.id],
      { data: updatedVersion, meta: response.meta },
    );
    queryClient.setQueryData<ApiEnvelope<WeeklyReportVersionSummary[]>>(
      ['weekly-report-versions', updatedReport.id],
      (cached) =>
        cached
          ? {
              ...cached,
              data: [
                updatedVersion,
                ...cached.data.filter((item) => item.id !== updatedVersion.id),
              ],
            }
          : cached,
    );
    queryClient.setQueryData<ApiEnvelope<WeeklyReportList>>(['weekly-reports'], (cached) =>
      cached
        ? {
            ...cached,
            data: {
              ...cached.data,
              items: cached.data.items.map((item) =>
                item.id === updatedReport.id ? updatedReport : item,
              ),
            },
          }
        : cached,
    );
  };

  const editMutation = useMutation({
    mutationFn: (action: EditAction) =>
      apiRequest<ReportMutationResult>(`/api/v1/weekly-reports/${action.reportId}`, {
        method: 'PUT',
        headers: { 'Idempotency-Key': idempotencyKey(`weekly-${action.source}`) },
        body: JSON.stringify({
          baseVersionId: action.baseVersionId,
          reportVersion: action.reportVersion,
          ...(action.fields ? { fields: action.fields } : {}),
          ...(action.attachmentIds ? { attachmentIds: action.attachmentIds } : {}),
          ...(action.recipientValidationIds
            ? { recipientValidationIds: action.recipientValidationIds }
            : {}),
          ...(action.templateMappingVersionId !== undefined
            ? { templateMappingVersionId: action.templateMappingVersionId }
            : {}),
          ...(action.scheduleAt !== undefined ? { scheduleAt: action.scheduleAt } : {}),
          changeReason: action.changeReason,
        }),
      }),
    onMutate: (action) => {
      if (action.source === 'autosave' || action.source === 'manual') setAutosaveState('saving');
    },
    onSuccess: async (response, action) => {
      if (action.source !== 'autosave') setRedoStack([]);
      if (action.source === 'autosave' || action.source === 'manual') {
        const hasNewerInput = action.fields
          ? !sameWeeklyFields(editorFields(form.getFieldsValue()), action.fields)
          : false;
        applyLocalEditResult(response);
        setDirty(hasNewerInput);
        setAutosaveState(hasNewerInput ? 'dirty' : 'saved');
        if (action.source === 'manual' && !response.data.replayed) {
          void messageApi.success(`已创建 v${response.data.version.versionNo}`);
        }
        return;
      }
      if (action.source === 'metadata') {
        applyLocalEditResult(response);
        setSubmissionSettingsDirty(false);
        await invalidateReport(action.reportId);
        if (!response.data.replayed) {
          void messageApi.success(`钉钉提交设置已保存到 v${response.data.version.versionNo}`);
        }
        return;
      }
      setDirty(false);
      setAutosaveState('saved');
      await invalidateReport(action.reportId);
      if (!response.data.replayed) {
        void messageApi.success(`已创建 v${response.data.version.versionNo}`);
      }
    },
    onError: (error: Error, action) => {
      if (action.source === 'metadata') {
        setSubmissionSettingsDirty(true);
      } else {
        setAutosaveState(
          error instanceof ApiClientError && error.status === 409 ? 'conflict' : 'error',
        );
      }
      void messageApi.error(error.message);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      targetVersionId: string;
      baseVersionId: string;
      reportVersion: number;
      reason: string;
    }) =>
      apiRequest<ReportMutationResult>(
        `/api/v1/weekly-reports/${input.reportId}/versions/${input.targetVersionId}/restore`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey('weekly-restore') },
          body: JSON.stringify({
            baseVersionId: input.baseVersionId,
            reportVersion: input.reportVersion,
            changeReason: input.reason,
          }),
        },
      ),
    onSuccess: async (response) => {
      setDirty(false);
      setAutosaveState('saved');
      setHistoryOpen(false);
      setCompareVersionId(null);
      await invalidateReport(response.data.report.id);
      void messageApi.success(`已恢复为新的 v${response.data.version.versionNo}，历史版本未被覆盖`);
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const confirmMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      versionId: string;
      reportVersion: number;
      templateMappingVersionId: string;
      acknowledgedWarningIds: string[];
    }) =>
      apiRequest<ConfirmResult>(`/api/v1/weekly-reports/${input.reportId}/confirm`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey('weekly-confirm') },
        body: JSON.stringify({
          versionId: input.versionId,
          reportVersion: input.reportVersion,
          templateMappingVersionId: input.templateMappingVersionId,
          acknowledgedWarningIds: input.acknowledgedWarningIds,
        }),
      }),
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const submitLogMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      confirmationId: string;
      confirmedVersionId: string;
      recipientScopeHash: string;
      reportVersion: number;
      scheduledApproval?: {
        scheduledAt: string;
        confirmationPhrase: '我确认在计划时间自动提交钉钉正式日志';
      };
    }) =>
      apiRequest<DeliveryRequestResult>(`/api/v1/weekly-reports/${input.reportId}/submit-log`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey('weekly-submit-log') },
        body: JSON.stringify({
          confirmationId: input.confirmationId,
          confirmedVersionId: input.confirmedVersionId,
          recipientScopeHash: input.recipientScopeHash,
          reportVersion: input.reportVersion,
          ...(input.scheduledApproval ? { scheduledApproval: input.scheduledApproval } : {}),
        }),
      }),
    onSuccess: async (response) => {
      await invalidateReport(response.data.intent.reportId);
      void messageApi.success(
        response.data.replayed
          ? '已返回原交付意图，不会重复创建钉钉正式日志'
          : dayjs(response.data.intent.scheduledFor).isAfter(dayjs().add(1, 'second'))
            ? `正式日志已预约在 ${formatDateTime(response.data.intent.scheduledFor)} 执行`
            : '正式日志交付已进入受控队列',
      );
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const exportCopyMutation = useMutation({
    mutationFn: (input: { reportId: string; versionId: string; reportVersion: number }) =>
      apiRequest<WeeklyReportExportCopy>(`/api/v1/weekly-reports/${input.reportId}/export-copy`, {
        method: 'POST',
        body: JSON.stringify({
          versionId: input.versionId,
          reportVersion: input.reportVersion,
        }),
      }),
    onSuccess: (response) => setExportCopyPreview(response.data),
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const notifyGroupMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      confirmationId: string;
      robotConnectionId: string;
      reportVersion: number;
    }) =>
      apiRequest<DeliveryRequestResult>(`/api/v1/weekly-reports/${input.reportId}/notify-group`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey('weekly-notify-group') },
        body: JSON.stringify({
          confirmationId: input.confirmationId,
          robotConnectionId: input.robotConnectionId,
          notificationType: 'submission_success',
          reportVersion: input.reportVersion,
        }),
      }),
    onSuccess: async (response) => {
      await invalidateReport(response.data.intent.reportId);
      void messageApi.success(
        response.data.replayed ? '已返回原群通知意图，不会重复发送' : '群摘要通知已进入受控队列',
      );
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const testNotifyGroupMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      versionId: string;
      robotConnectionId: string;
      reportVersion: number;
    }) =>
      apiRequest<NotificationRequestResult>(
        `/api/v1/weekly-reports/${input.reportId}/notifications/test-group`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey('weekly-test-notify-group') },
          body: JSON.stringify({
            versionId: input.versionId,
            robotConnectionId: input.robotConnectionId,
            reportVersion: input.reportVersion,
            confirmSendTestReport: true,
          }),
        },
      ),
    onSuccess: async (response, input) => {
      await invalidateReport(input.reportId);
      void messageApi.success(
        response.data.disposition === 'created'
          ? '当前周报测试消息已进入群机器人发送队列'
          : '同一次测试请求已经存在，不会重复发送',
      );
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const notifyFailureMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      robotConnectionId: string;
      failedDeliveryIntentId: string;
      reportVersion: number;
    }) =>
      apiRequest<NotificationRequestResult>(
        `/api/v1/weekly-reports/${input.reportId}/notifications/failure`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey('weekly-notify-failure') },
          body: JSON.stringify({
            robotConnectionId: input.robotConnectionId,
            failedDeliveryIntentId: input.failedDeliveryIntentId,
            reportVersion: input.reportVersion,
          }),
        },
      ),
    onSuccess: async (response, input) => {
      await invalidateReport(input.reportId);
      void messageApi.success(
        response.data.disposition === 'created'
          ? '交付失败提醒已进入独立通知队列'
          : response.data.disposition === 'coalesced'
            ? '相同失败提醒仍在静默窗口，已合并且不会重复发送'
            : '相同状态版本的失败提醒已经存在，不会重复发送',
      );
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const notifyRiskMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      robotConnectionId: string;
      versionId: string;
      warningIds: string[];
      reportVersion: number;
    }) =>
      apiRequest<NotificationRequestResult>(
        `/api/v1/weekly-reports/${input.reportId}/notifications/risk`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey('weekly-notify-risk') },
          body: JSON.stringify({
            robotConnectionId: input.robotConnectionId,
            versionId: input.versionId,
            warningIds: input.warningIds,
            reportVersion: input.reportVersion,
          }),
        },
      ),
    onSuccess: async (response, input) => {
      setRiskNotificationOpen(false);
      setSelectedRiskWarningIds([]);
      await invalidateReport(input.reportId);
      void messageApi.success(
        response.data.disposition === 'created'
          ? '严重风险提醒已进入独立通知队列'
          : response.data.disposition === 'coalesced'
            ? '相同风险提醒仍在静默窗口，已合并且不会重复发送'
            : '当前版本的相同风险提醒已经存在，不会重复发送',
      );
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const reconcileDeliveryMutation = useMutation({
    mutationFn: (input: { reportId: string; intentId: string; intentVersion: number }) =>
      apiRequest<DeliveryRecoveryResult>(
        `/api/v1/weekly-reports/${input.reportId}/deliveries/${input.intentId}/reconcile`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey('weekly-delivery-reconcile') },
          body: JSON.stringify({ intentVersion: input.intentVersion }),
        },
      ),
    onSuccess: async (response, input) => {
      await invalidateReport(input.reportId);
      const result = response.data;
      if (result.recoveryStatus === 'matched') {
        void messageApi.success(`查询唯一命中钉钉日志 ${result.externalId ?? ''}，已恢复成功`);
      } else if (result.recoveryStatus === 'absence_confirmed') {
        void messageApi.warning('连续查询确认未创建，现在可以发起一次受控新尝试');
      } else if (result.recoveryStatus === 'ambiguous') {
        void messageApi.warning('查询结果有歧义，已进入待人工复核');
      } else if (result.outcome === 'query_failed') {
        void messageApi.error(`只读恢复查询失败：${result.errorCode ?? '未知错误'}`);
      } else {
        void messageApi.info('本次未找到精确匹配；等待可见性宽限后请再次查询');
      }
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const resolveDeliveryMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      intentId: string;
      intentVersion: number;
      values: ManualResolutionValues;
    }) =>
      apiRequest<DeliveryRecoveryResult>(
        `/api/v1/weekly-reports/${input.reportId}/deliveries/${input.intentId}/resolve`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey('weekly-delivery-resolve') },
          body: JSON.stringify({
            intentVersion: input.intentVersion,
            resolution: input.values.resolution,
            externalId:
              input.values.resolution === 'delivered'
                ? input.values.externalId?.trim() || null
                : null,
            externalUrl:
              input.values.resolution === 'delivered'
                ? input.values.externalUrl?.trim() || null
                : null,
            reason: input.values.reason,
            confirmationPhrase: input.values.confirmationPhrase,
          }),
        },
      ),
    onSuccess: async (response, input) => {
      setManualResolutionIntent(null);
      manualResolutionForm.resetFields();
      await invalidateReport(input.reportId);
      void messageApi.success(
        response.data.status === 'succeeded'
          ? '已记录人工确认的交付成功事实'
          : '已记录人工确认的未交付事实，可按门禁发起受控重试',
      );
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const retryDeliveryMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      intentId: string;
      intentVersion: number;
      reason: string;
    }) =>
      apiRequest<DeliveryRetryResult>(
        `/api/v1/weekly-reports/${input.reportId}/deliveries/${input.intentId}/retry`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey('weekly-delivery-retry') },
          body: JSON.stringify({ intentVersion: input.intentVersion, reason: input.reason }),
        },
      ),
    onSuccess: async (response, input) => {
      setDeliveryRetryIntent(null);
      deliveryRetryForm.resetFields();
      await invalidateReport(input.reportId);
      void messageApi.success(`第 ${response.data.nextAttemptNo} 次显式尝试已进入受控队列`);
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const generateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<GenerateResult>('/api/v1/weekly-reports/generate', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: async (response) => {
      setGenerateOpen(false);
      setSelectedReportId(response.data.report.id);
      await invalidateReport(response.data.report.id);
      void messageApi.success(`周报 v${response.data.version.versionNo} 已由确定性规则生成`);
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const contentTemplateMutation = useMutation({
    mutationFn: (fields: WeeklyReportContentTemplate['fields']) =>
      apiRequest<WeeklyReportContentTemplate>('/api/v1/weekly-reports/content-template', {
        method: 'PUT',
        body: JSON.stringify({ version: contentTemplate.data?.data.version ?? 0, ...fields }),
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(['weekly-report-content-template'], response);
      setContentTemplateOpen(false);
      void messageApi.success('周报正文默认模板已保存');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const aiSuggestionMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      baseVersionId: string;
      reportVersion: number;
      values: AiSuggestionFormValues;
      mode: 'suggestion' | 'fill';
    }) =>
      apiRequest<WeeklyAiSuggestionResult>(
        `/api/v1/weekly-reports/${input.reportId}/ai-suggestions`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey('weekly-ai-suggestion') },
          body: JSON.stringify({
            baseVersionId: input.baseVersionId,
            reportVersion: input.reportVersion,
            providerConnectionId: input.values.providerConnectionId,
            fields: input.values.fields,
            consent: {
              allowPeopleNames: input.values.allowPeopleNames,
              allowInternalUrls: input.values.allowInternalUrls,
              allowDescriptionSummaries: input.values.allowDescriptionSummaries,
            },
          }),
        },
      ),
    onSuccess: async (response, input) => {
      setSelectedAiGenerationId(response.data.generation.id);
      if (response.data.report) await invalidateReport(response.data.report.id);
      else if (response.data.generation.reportId) {
        await invalidateReport(response.data.generation.reportId);
      }
      if (response.data.fallback) {
        void messageApi.warning(
          `AI 未改变正文，已回退当前版本：${response.data.fallbackReasonCode ?? '未知原因'}`,
        );
      } else if (input.mode === 'suggestion') {
        void messageApi.success(
          `已生成独立 AI 建议 v${response.data.suggestionVersion?.versionNo ?? '—'}，需人工比较后采纳`,
        );
      }
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const adoptAiMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      generationId: string;
      suggestionVersionId: string;
      baseVersionId: string;
      reportVersion: number;
      decisionReason: string;
      uiSource?: 'manual' | 'auto_fill';
    }) =>
      apiRequest<AiDecisionResult>(
        `/api/v1/weekly-reports/${input.reportId}/ai-generations/${input.generationId}/adopt`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey('weekly-ai-adopt') },
          body: JSON.stringify({
            suggestionVersionId: input.suggestionVersionId,
            baseVersionId: input.baseVersionId,
            reportVersion: input.reportVersion,
            decisionReason: input.decisionReason,
          }),
        },
      ),
    onSuccess: async (response, input) => {
      if (response.data.report) await invalidateReport(response.data.report.id);
      setSelectedAiGenerationId(response.data.generation.id);
      if (input.uiSource === 'auto_fill') {
        setAiOpen(false);
        void messageApi.success(
          `AI 已填写周报并保存为 v${response.data.adoptedVersion?.versionNo ?? '—'}`,
        );
      } else {
        void messageApi.success(
          `已人工采纳为 v${response.data.adoptedVersion?.versionNo ?? '—'}；AI 原建议仍完整保留`,
        );
      }
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const rejectAiMutation = useMutation({
    mutationFn: (input: { reportId: string; generationId: string; decisionReason: string }) =>
      apiRequest<AiDecisionResult>(
        `/api/v1/weekly-reports/${input.reportId}/ai-generations/${input.generationId}/reject`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey('weekly-ai-reject') },
          body: JSON.stringify({ decisionReason: input.decisionReason }),
        },
      ),
    onSuccess: async (response) => {
      if (response.data.generation.reportId) {
        await invalidateReport(response.data.generation.reportId);
      }
      setSelectedAiGenerationId(response.data.generation.id);
      void messageApi.success('已明确拒绝 AI 建议；当前正文未改变');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const fillReportWithAi = async () => {
    if (!report || !version) return;
    try {
      const values = await aiForm.validateFields();
      const suggested = await aiSuggestionMutation.mutateAsync({
        reportId: report.id,
        baseVersionId: version.id,
        reportVersion: report.version,
        values,
        mode: 'fill',
      });
      const suggestionVersion = suggested.data.suggestionVersion;
      const suggestionReport = suggested.data.report;
      if (suggested.data.fallback || !suggestionVersion || !suggestionReport) return;
      await adoptAiMutation.mutateAsync({
        reportId: report.id,
        generationId: suggested.data.generation.id,
        suggestionVersionId: suggestionVersion.id,
        baseVersionId: suggestionReport.currentVersionId,
        reportVersion: suggestionReport.version,
        decisionReason: 'AI 自动生成并填入当前周报',
        uiSource: 'auto_fill',
      });
    } catch {
      // Form validation renders inline errors; request mutations surface their own API messages.
    }
  };

  useEffect(() => {
    const healthy = aiConnections.find((connection) => connection.status === 'healthy');
    if (!aiForm.getFieldValue('providerConnectionId') && healthy) {
      aiForm.setFieldsValue({ providerConnectionId: healthy.id });
    }
  }, [aiConnections, aiForm]);

  useEffect(() => {
    if (
      !selectedRobotConnectionId ||
      !healthyRobotConnections.some((connection) => connection.id === selectedRobotConnectionId)
    ) {
      setSelectedRobotConnectionId(healthyRobotConnections[0]?.id ?? null);
    }
  }, [healthyRobotConnections, selectedRobotConnectionId]);

  useEffect(() => {
    const hasActiveDelivery = (deliveries.data?.data ?? []).some((intent) =>
      ['pending', 'running'].includes(intent.status),
    );
    if (!hasActiveDelivery || !selectedReportId) return;
    const timer = setInterval(() => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['weekly-report', selectedReportId] }),
        queryClient.invalidateQueries({
          queryKey: ['weekly-report-deliveries', selectedReportId],
        }),
      ]);
    }, 1_500);
    return () => clearInterval(timer);
  }, [deliveries.data, queryClient, selectedReportId]);

  useEffect(() => {
    setSelectedAiGenerationId(null);
    setSubmissionOperationLogs([]);
  }, [selectedReportId]);

  useEffect(() => {
    setRiskNotificationOpen(false);
    setSelectedRiskWarningIds([]);
  }, [selectedReportId, currentVersionId, selectedRobotConnectionId]);

  useEffect(() => {
    if (!version) return;
    if (locallySavedVersionId.current === version.id) {
      locallySavedVersionId.current = null;
      return;
    }
    form.setFieldsValue({
      reportDate: dayjs(version.fields.reportDate),
      recentGoals: version.fields.recentGoals,
      weeklyWork: version.fields.weeklyWork,
      nextWeekPlans: version.fields.nextWeekPlans,
      problems: version.fields.problems,
      other: version.fields.other,
    });
    setSelectedMappingId(version.templateMappingVersionId);
    setSelectedConnectionId(version.recipientScope.connectionId ?? null);
    setSelectedRecipientIds(
      (version.recipientScope.recipients ?? []).map((recipient) => recipient.validationId),
    );
    setSelectedSchedule(version.scheduleAt ? dayjs(version.scheduleAt) : null);
    setSubmissionSettingsDirty(false);
    setDirty(false);
    setAutosaveState('idle');
  }, [form, version?.id]);

  useEffect(() => {
    if (!selectedMappingId || selectedConnectionId) return;
    const mapping = currentMappings.find((item) => item.id === selectedMappingId);
    if (mapping) setSelectedConnectionId(mapping.connectionId);
  }, [currentMappings, selectedConnectionId, selectedMappingId]);

  useEffect(() => {
    if (!dirty || !report || !version || editMutation.isPending) return;
    // 保存失败/冲突后保留未保存内容，但不循环重试；用户再次编辑会把状态改回 dirty。
    if (autosaveState === 'error' || autosaveState === 'conflict') return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    // 自动保存也创建不可变版本；基准版本和聚合版本共同防止覆盖其他窗口的修改。
    autosaveTimer.current = setTimeout(() => {
      const values = form.getFieldsValue();
      editMutation.mutate({
        reportId: report.id,
        baseVersionId: version.id,
        reportVersion: report.version,
        fields: editorFields(values),
        changeReason: '自动保存：六字段编辑',
        source: 'autosave',
      });
    }, 1_200);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [dirty, report, version, editMutation.isPending, autosaveState, form]);

  const previousId = version
    ? previousVersionId(versions.data?.data ?? [], version.versionNo)
    : null;
  const sourceGroups = useMemo(() => {
    const groups = new Map<string, WeeklyReportVersion['sourceLinks']>();
    for (const link of version?.sourceLinks ?? []) {
      groups.set(link.field, [...(groups.get(link.field) ?? []), link]);
    }
    return groups;
  }, [version]);
  const candidates = (version?.sourceSnapshot.sources.evidence ?? []).filter(
    (item) => item.relationStatus === 'suggested' || item.taskId === null,
  );
  const differences =
    version && comparedVersion.data?.data
      ? compareWeeklyFields(comparedVersion.data.data.fields, version.fields)
      : [];
  const deliveryItems = deliveries.data?.data ?? [];
  const notificationItems = notifications.data?.data ?? [];
  const selectedRobotConnection = healthyRobotConnections.find(
    (connection) => connection.id === selectedRobotConnectionId,
  );
  const severeRiskWarnings = eligibleSevereRiskWarnings(
    version?.warnings ?? [],
    selectedRobotConnection?.config ?? null,
  );
  const logIntent = currentLogDeliveryIntent(deliveryItems, report?.currentConfirmation?.id);
  const unresolvedLogIntent = latestUnresolvedLogDeliveryIntent(deliveryItems);
  const historicalUnresolvedLogIntent =
    unresolvedLogIntent && unresolvedLogIntent.id !== logIntent?.id ? unresolvedLogIntent : null;
  const directSubmitPending = directSubmitStage !== 'idle';
  const logDeliveryActive = Boolean(logIntent && ['pending', 'running'].includes(logIntent.status));
  const logDeliveryCanRetry = Boolean(logIntent && deliveryRecoveryActions(logIntent).canRetry);
  const workflowCurrent =
    logIntent?.status === 'succeeded' ? 2 : logIntent || directSubmitStage === 'queuing' ? 1 : 0;
  const workflowStatus =
    logIntent && ['failed', 'unknown', 'needs_review'].includes(logIntent.status)
      ? 'error'
      : 'process';

  useEffect(() => {
    if (!logIntent) return;
    if (logIntent.status === 'pending') {
      recordSubmissionOperation(
        'delivery-pending',
        'waiting',
        '等待 Windows 钉钉桌面执行',
        '桌面桥接已收到任务。',
      );
      return;
    }
    if (logIntent.status === 'running') {
      recordSubmissionOperation(
        'desktop-running',
        'running',
        '正在识别并操作钉钉界面',
        '同时使用 English (en-US) 与简体中文 (zh-Hans-CN) OCR。',
      );
      return;
    }
    if (logIntent.status === 'succeeded') {
      recordSubmissionOperation(
        'delivery-result',
        'success',
        '钉钉周报提交成功',
        logIntent.externalId ?? '本地提交回执已记录。',
      );
      return;
    }
    if (logIntent.status === 'failed') {
      recordSubmissionOperation(
        'delivery-result',
        'error',
        `提交失败：${desktopAutomationFailureStage(logIntent.lastErrorCode)}`,
        logIntent.lastErrorSummary ?? logIntent.lastErrorCode ?? '未返回详细错误。',
      );
      return;
    }
    if (logIntent.status === 'unknown' || logIntent.status === 'needs_review') {
      recordSubmissionOperation(
        'delivery-result',
        'error',
        '提交结果需要人工核对',
        '脚本已点击 Submit，但没有可靠识别成功提示；系统不会自动重复提交。',
      );
    }
  }, [logIntent, recordSubmissionOperation]);
  const selectedRobotIntent =
    deliveryItems.find(
      (intent) =>
        intent.channel === 'dingtalk_robot' && intent.connectionId === selectedRobotConnectionId,
    ) ?? null;
  const logResultUnknown = logIntent?.status === 'unknown' || logIntent?.status === 'needs_review';
  const logSubmissionBlocked =
    !report ||
    !version ||
    version.attachments.length > 0 ||
    Boolean(logIntent && !logDeliveryCanRetry) ||
    Boolean(historicalUnresolvedLogIntent) ||
    directSubmitPending ||
    editMutation.isPending ||
    confirmMutation.isPending ||
    submitLogMutation.isPending;
  const robotNotificationBlocked =
    !report ||
    !report.currentConfirmation ||
    report.logDeliveryState !== 'submitted' ||
    !selectedRobotConnectionId ||
    Boolean(selectedRobotIntent);
  const testRobotNotificationBlocked =
    !report ||
    !version ||
    !selectedRobotConnectionId ||
    dirty ||
    autosaveState === 'saving' ||
    editMutation.isPending;
  const failureNotificationBlocked =
    !report || !canNotifyFormalLogFailure(logIntent) || !selectedRobotConnectionId;
  const riskNotificationBlocked =
    !report || !version || !selectedRobotConnectionId || severeRiskWarnings.length === 0;

  const saveFieldsNow = () => {
    if (!report || !version) return;
    const values = form.getFieldsValue();
    editMutation.mutate({
      reportId: report.id,
      baseVersionId: version.id,
      reportVersion: report.version,
      fields: editorFields(values),
      changeReason: '人工保存：六字段编辑',
      source: 'manual',
    });
  };

  const applyContentTemplateToCurrentReport = () => {
    if (!report || !version) return;
    const templateFields = contentTemplate.data?.data.fields;
    if (!templateFields) {
      void messageApi.warning('周报模板尚未加载完成，请稍后重试');
      return;
    }
    const applicableFields = Object.fromEntries(
      Object.entries(templateFields).filter(([, value]) => value.trim().length > 0),
    ) as Partial<WeeklyReportContentTemplate['fields']>;
    if (Object.keys(applicableFields).length === 0) {
      void messageApi.warning('模板中没有可应用的默认内容');
      return;
    }
    const nextValues: EditorValues = {
      ...form.getFieldsValue(),
      ...applicableFields,
    };
    form.setFieldsValue(nextValues);
    setDirty(true);
    editMutation.mutate({
      reportId: report.id,
      baseVersionId: version.id,
      reportVersion: report.version,
      fields: editorFields(nextValues),
      changeReason: '应用周报正文默认模板',
      source: 'manual',
    });
  };

  const persistSubmissionSettings = (
    currentReport: WeeklyReport,
    currentVersion: WeeklyReportVersion,
  ) =>
    editMutation.mutateAsync({
      reportId: currentReport.id,
      baseVersionId: currentVersion.id,
      reportVersion: currentReport.version,
      attachmentIds: currentVersion.attachments.map((attachment) => attachment.id),
      recipientValidationIds: selectedRecipientIds,
      templateMappingVersionId: selectedMappingId,
      scheduleAt: selectedSchedule?.toISOString() ?? null,
      changeReason: '保存钉钉模板、接收范围和提交时间',
      source: 'metadata',
    });

  const restoreVersion = (
    targetVersionId: string,
    reason: string,
    mode: 'undo' | 'redo' | 'history',
  ) => {
    if (!report || !version) return;
    // 撤销/重做都通过后端“恢复为新版本”实现，历史行始终保持不可变。
    if (mode === 'undo') setRedoStack((stack) => [...stack, version.id]);
    if (mode === 'redo') setRedoStack((stack) => stack.slice(0, -1));
    if (mode === 'history') setRedoStack([]);
    restoreMutation.mutate({
      reportId: report.id,
      targetVersionId,
      baseVersionId: version.id,
      reportVersion: report.version,
      reason,
    });
  };

  const confirmAiDecision = (generation: WeeklyAiGeneration, decision: 'adopt' | 'reject') => {
    if (!report || !version) return;
    const suggestion = generation.suggestionVersions[0];
    if (decision === 'adopt' && !suggestion) {
      void messageApi.error('本次生成没有可采纳的 AI 建议版本');
      return;
    }
    let reason =
      decision === 'adopt' ? '已逐段核对引用、数字、日期和项目名' : '人工核对后不采用本次建议';
    Modal.confirm({
      title: decision === 'adopt' ? '显式采纳 AI 建议' : '明确拒绝 AI 建议',
      icon: <ExclamationCircleOutlined />,
      width: 620,
      content: (
        <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 12 }}>
          <Alert
            type={decision === 'adopt' ? 'warning' : 'info'}
            showIcon
            message={
              decision === 'adopt'
                ? '采纳会新建人工派生版本并切换当前正文；不会覆盖或删除 AI 原建议。'
                : '拒绝只冻结本次人工决定，不改变当前正文。'
            }
          />
          <Input.TextArea
            aria-label="人工决定理由"
            placeholder="请填写核对结论或不采用原因"
            defaultValue={reason}
            maxLength={500}
            showCount
            autoSize={{ minRows: 3, maxRows: 6 }}
            onChange={(event) => {
              reason = event.target.value.trim();
            }}
          />
        </Space>
      ),
      okText: decision === 'adopt' ? '核对完成并采纳' : '确认拒绝',
      okButtonProps: { danger: decision === 'reject' },
      cancelText: '取消',
      onOk: async () => {
        if (!reason) throw new Error('必须填写人工决定理由');
        if (decision === 'adopt') {
          await adoptAiMutation.mutateAsync({
            reportId: report.id,
            generationId: generation.id,
            suggestionVersionId: suggestion!.id,
            baseVersionId: version.id,
            reportVersion: report.version,
            decisionReason: reason,
          });
        } else {
          await rejectAiMutation.mutateAsync({
            reportId: report.id,
            generationId: generation.id,
            decisionReason: reason,
          });
        }
      },
    });
  };

  const submitCurrentReport = async () => {
    if (!report || !version || logSubmissionBlocked) return;
    setSubmissionOperationLogs([]);
    recordSubmissionOperation(
      'start',
      'running',
      logIntent && logDeliveryCanRetry ? '重新启动自动提交' : '开始一键自动提交',
      '将自动保存页面内容并调用 Windows 钉钉桌面。',
    );
    if (logIntent && logDeliveryCanRetry) {
      setDirectSubmitStage('queuing');
      try {
        await retryDeliveryMutation.mutateAsync({
          reportId: report.id,
          intentId: logIntent.id,
          intentVersion: logIntent.version,
          reason: '用户在周报页面点击重新自动提交',
        });
        recordSubmissionOperation('queued', 'success', '重试任务已进入桌面执行队列');
      } catch (error) {
        recordSubmissionOperation(
          'queue-error',
          'error',
          '无法启动重试任务',
          error instanceof Error ? error.message : '未知错误',
        );
      } finally {
        setDirectSubmitStage('idle');
      }
      return;
    }
    let validatedValues: EditorValues;
    try {
      validatedValues = await form.validateFields();
    } catch {
      recordSubmissionOperation(
        'validation',
        'error',
        '周报正文不完整',
        '请补全页面标出的必填字段后再提交。',
      );
      void messageApi.error('请先补全周报六字段正文');
      return;
    }
    if (!selectedMappingId) {
      recordSubmissionOperation('validation', 'error', '未选择钉钉周报模板');
      void messageApi.error('请先选择钉钉周报模板');
      return;
    }
    if (selectedRecipientIds.length === 0) {
      recordSubmissionOperation('validation', 'error', '未选择接收范围');
      void messageApi.error('请先选择接收范围');
      return;
    }
    setDirectSubmitStage(dirty ? 'saving_content' : 'preparing');
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    try {
      let currentReport = report;
      let currentVersion = version;
      if (dirty) {
        recordSubmissionOperation('content', 'running', '正在保存六字段正文');
        const saved = await editMutation.mutateAsync({
          reportId: report.id,
          baseVersionId: version.id,
          reportVersion: report.version,
          fields: editorFields(validatedValues),
          changeReason: '提交前自动保存当前正文',
          source: 'autosave',
        });
        currentReport = saved.data.report;
        currentVersion = saved.data.version;
        recordSubmissionOperation('content', 'success', '六字段正文已保存');
      } else {
        recordSubmissionOperation('content', 'success', '六字段正文无需保存');
      }
      if (submissionSettingsDirty) {
        setDirectSubmitStage('saving_settings');
        recordSubmissionOperation('settings', 'running', '正在保存模板、接收范围和提交时间');
        const saved = await persistSubmissionSettings(currentReport, currentVersion);
        currentReport = saved.data.report;
        currentVersion = saved.data.version;
        recordSubmissionOperation('settings', 'success', '钉钉提交设置已保存');
      } else {
        recordSubmissionOperation('settings', 'success', '钉钉提交设置无需保存');
      }
      if (!currentVersion.templateMappingVersionId) {
        void messageApi.error('当前周报没有可用的钉钉模板');
        return;
      }
      if (currentVersion.attachments.length > 0) {
        void messageApi.error('当前钉钉提交不支持附件，请移除附件后再提交');
        return;
      }

      let confirmation = currentReport.currentConfirmation;
      if (!confirmation || confirmation.versionId !== currentVersion.id) {
        setDirectSubmitStage('preparing');
        recordSubmissionOperation('prepare', 'running', '正在生成本次提交快照');
        const confirmed = await confirmMutation.mutateAsync({
          reportId: currentReport.id,
          versionId: currentVersion.id,
          reportVersion: currentReport.version,
          templateMappingVersionId: currentVersion.templateMappingVersionId,
          acknowledgedWarningIds: currentVersion.warnings
            .filter((warning) => !warning.blocking)
            .map((warning) => warning.id),
        });
        currentReport = confirmed.data.report;
        confirmation = confirmed.data.confirmation;
      }
      recordSubmissionOperation('prepare', 'success', '本次提交内容已准备完成');

      const futureSchedule =
        currentVersion.scheduleAt && dayjs(currentVersion.scheduleAt).isAfter(dayjs());
      setDirectSubmitStage('queuing');
      recordSubmissionOperation(
        'queued',
        'running',
        futureSchedule ? '正在创建预约任务' : '正在启动 Windows 钉钉桌面任务',
      );
      await submitLogMutation.mutateAsync({
        reportId: currentReport.id,
        confirmationId: confirmation.id,
        confirmedVersionId: currentVersion.id,
        recipientScopeHash: confirmation.recipientScopeHash,
        reportVersion: currentReport.version,
        ...(futureSchedule
          ? {
              scheduledApproval: {
                scheduledAt: currentVersion.scheduleAt!,
                confirmationPhrase: '我确认在计划时间自动提交钉钉正式日志' as const,
              },
            }
          : {}),
      });
      recordSubmissionOperation(
        'queued',
        'success',
        futureSchedule ? '预约任务已创建' : 'Windows 钉钉桌面任务已进入队列',
      );
    } catch (error) {
      recordSubmissionOperation(
        'request-error',
        'error',
        '自动提交流程中止',
        error instanceof Error ? error.message : '未知错误',
      );
      // 表单和各 mutation 已显示具体错误；保留当前输入供用户继续修改。
    } finally {
      setDirectSubmitStage('idle');
    }
  };

  const confirmNotifyGroup = () => {
    if (!report?.currentConfirmation || !selectedRobotConnectionId) return;
    const robot = healthyRobotConnections.find(
      (connection) => connection.id === selectedRobotConnectionId,
    );
    Modal.confirm({
      title: '发送钉钉群摘要？',
      icon: <SendOutlined />,
      width: 620,
      content: (
        <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 12 }}>
          <Alert
            type="info"
            showIcon
            message="群消息只发送交付摘要"
            description="仅包含周期、报告日期、状态、最多三个项目名和正式日志 ID；不会发送六字段全文、附件、凭证或 localhost 链接。"
          />
          <Typography.Text>
            目标群聊：{robot ? robotGroupLabel(robot) : selectedRobotConnectionId}
          </Typography.Text>
        </Space>
      ),
      okText: '确认发送摘要',
      cancelText: '取消',
      onOk: () =>
        notifyGroupMutation.mutateAsync({
          reportId: report.id,
          confirmationId: report.currentConfirmation!.id,
          robotConnectionId: selectedRobotConnectionId,
          reportVersion: report.version,
        }),
    });
  };

  const confirmTestNotifyGroup = () => {
    if (!report || !version || !selectedRobotConnectionId || testRobotNotificationBlocked) return;
    const robot = healthyRobotConnections.find(
      (connection) => connection.id === selectedRobotConnectionId,
    );
    Modal.confirm({
      title: '将当前周报作为测试消息发送到群聊？',
      icon: <ExperimentOutlined />,
      width: 680,
      content: (
        <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 12 }}>
          <Alert
            type="warning"
            showIcon
            message="这会真实调用群机器人"
            description="当前版本的五项周报正文会发送到所选群聊，并明确标注为测试消息；不会创建钉钉正式日志，也不会改变周报的确认或提交状态。疑似凭证与带查询参数的 URL 会在服务端脱敏，过长字段会截断。"
          />
          <Typography.Text>当前版本：v{version.versionNo}</Typography.Text>
          <Typography.Text>
            目标群聊：{robot ? robotGroupLabel(robot) : selectedRobotConnectionId}
          </Typography.Text>
        </Space>
      ),
      okText: '确认测试发送',
      cancelText: '取消',
      onOk: () =>
        testNotifyGroupMutation.mutateAsync({
          reportId: report.id,
          versionId: version.id,
          robotConnectionId: selectedRobotConnectionId,
          reportVersion: report.version,
        }),
    });
  };

  const confirmNotifyFailure = () => {
    if (
      !report ||
      !canNotifyFormalLogFailure(logIntent) ||
      !logIntent ||
      !selectedRobotConnectionId
    )
      return;
    const robot = healthyRobotConnections.find(
      (connection) => connection.id === selectedRobotConnectionId,
    );
    Modal.confirm({
      title: '发送正式日志失败提醒？',
      icon: <ExclamationCircleOutlined />,
      width: 660,
      content: (
        <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 12 }}>
          <Alert
            type="warning"
            showIcon
            message="只根据明确失败事实生成短提醒"
            description="消息只包含周期、失败阶段、脱敏简化错误和本机查看提示；不会发送六字段全文、附件、凭证或 localhost 链接。结果未知时该入口会被禁止。"
          />
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label="失败意图">{logIntent.id}</Descriptions.Item>
            <Descriptions.Item label="错误代码">
              {logIntent.lastErrorCode ?? '未提供'}
            </Descriptions.Item>
            <Descriptions.Item label="目标群聊">
              {robot ? robotGroupLabel(robot) : selectedRobotConnectionId}
            </Descriptions.Item>
          </Descriptions>
        </Space>
      ),
      okText: '确认发送失败提醒',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        notifyFailureMutation.mutateAsync({
          reportId: report.id,
          robotConnectionId: selectedRobotConnectionId,
          failedDeliveryIntentId: logIntent.id,
          reportVersion: report.version,
        }),
    });
  };

  const confirmReconcileDelivery = (intent: WeeklyReportDeliveryIntent) => {
    Modal.confirm({
      title: '查询钉钉实际交付结果？',
      icon: <SafetyCertificateOutlined />,
      width: 660,
      content: (
        <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 12 }}>
          <Alert
            type="info"
            showIcon
            message="这是只读外部查询，不会创建或重发日志"
            description="系统会查询原尝试附近的窄时间窗口，并用确认冻结的六字段逐项精确匹配。唯一命中才恢复成功；首次未找到不会开放重试。"
          />
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label="交付意图">{intent.id}</Descriptions.Item>
            <Descriptions.Item label="当前恢复状态">
              {deliveryRecoveryStatusLabel(intent.recoveryStatus)}
            </Descriptions.Item>
            <Descriptions.Item label="已有尝试">{intent.attemptCount} 次</Descriptions.Item>
          </Descriptions>
        </Space>
      ),
      okText: '执行只读查询',
      cancelText: '取消',
      onOk: () =>
        reconcileDeliveryMutation.mutateAsync({
          reportId: intent.reportId,
          intentId: intent.id,
          intentVersion: intent.version,
        }),
    });
  };

  const openManualResolution = (intent: WeeklyReportDeliveryIntent) => {
    manualResolutionForm.setFieldsValue({
      resolution: 'delivered',
      ...(intent.externalId ? { externalId: intent.externalId } : {}),
      ...(intent.externalUrl ? { externalUrl: intent.externalUrl } : {}),
      reason: '',
      confirmationPhrase: '',
    });
    setManualResolutionIntent(intent);
  };

  const openDeliveryRetry = (intent: WeeklyReportDeliveryIntent) => {
    deliveryRetryForm.setFieldsValue({ reason: '' });
    setDeliveryRetryIntent(intent);
  };

  return (
    <Space direction="vertical" size={20} className="page-stack weekly-report-page">
      {holder}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>周报</Typography.Title>
          <Typography.Text type="secondary">
            AI 生成内容，可随时编辑，点击后自动填写并提交到钉钉。
          </Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void reports.refetch()}>
            刷新
          </Button>
          <Button
            icon={<DiffOutlined />}
            loading={contentTemplate.isLoading}
            onClick={() => {
              contentTemplateForm.setFieldsValue(
                contentTemplate.data?.data.fields ?? {
                  recentGoals: '',
                  weeklyWork: '',
                  nextWeekPlans: '',
                  problems: '',
                  other: '',
                },
              );
              setContentTemplateOpen(true);
            }}
          >
            新建周报模板
          </Button>
          <Button
            type="primary"
            icon={<FileAddOutlined />}
            onClick={() => {
              generateForm.setFieldsValue({
                customPeriod: false,
                freshnessMode: 'allow_stale',
                includeUnconfirmedEvidence: false,
              });
              setGenerateOpen(true);
            }}
          >
            新建周报
          </Button>
        </Space>
      </div>

      <Card size="small">
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap>
            <Typography.Text strong>周报周期</Typography.Text>
            <Select
              value={selectedReportId ?? undefined}
              loading={reports.isLoading}
              placeholder="选择周报"
              style={{ width: 360 }}
              onChange={(value) => {
                setSelectedReportId(value ?? null);
                setRedoStack([]);
              }}
              options={reportItems.map((item) => ({
                value: item.id,
                label: `${item.periodStart} 至 ${item.periodEnd} · ${statusLabel(item.status)} · ${item.versionCount ?? 0} 版`,
              }))}
            />
            {version && (
              <Tag color="blue">
                v{version.versionNo} · {originLabels[version.origin] ?? version.origin}
              </Tag>
            )}
          </Space>
          {report && version && (
            <Space wrap>
              <Typography.Text strong>提交时间</Typography.Text>
              <DatePicker
                showTime
                allowClear
                value={selectedSchedule}
                onChange={(schedule) => {
                  setSelectedSchedule(schedule);
                  setSubmissionSettingsDirty(true);
                }}
                placeholder="留空表示点击提交后立即发送"
                style={{ width: 280 }}
              />
              <Typography.Text type="secondary">
                聚合版本 {report.version} · 更新 {formatDateTime(report.updatedAt)}
              </Typography.Text>
            </Space>
          )}
        </Space>
      </Card>

      {!selectedReportId && !reports.isLoading ? (
        <Card>
          <Empty description="暂无周报" image={Empty.PRESENTED_IMAGE_SIMPLE}>
            <Button
              type="primary"
              onClick={() => {
                generateForm.setFieldsValue({
                  customPeriod: false,
                  freshnessMode: 'allow_stale',
                  includeUnconfirmedEvidence: false,
                });
                setGenerateOpen(true);
              }}
            >
              新建周报
            </Button>
          </Empty>
        </Card>
      ) : reportDetail.isError || versionDetail.isError ? (
        <Alert
          type="error"
          showIcon
          message="无法加载周报"
          description={(reportDetail.error ?? versionDetail.error)?.message}
        />
      ) : report && version ? (
        <>
          <Card size="small">
            <Steps
              size="small"
              current={workflowCurrent}
              items={workflowItems}
              status={workflowStatus}
            />
          </Card>

          <div className="weekly-primary-actions">
            <Typography.Text strong>修改正文后可直接提交到钉钉</Typography.Text>
            <Space wrap>
              {logIntent && (
                <Tag color={deliveryStatusColor(logIntent.status)}>
                  钉钉：{deliveryStatusLabel(logIntent.status)}
                </Tag>
              )}
              {dirty && (
                <Button
                  icon={<SaveOutlined />}
                  loading={editMutation.isPending}
                  onClick={saveFieldsNow}
                >
                  保存修改
                </Button>
              )}
              <Button
                type="primary"
                icon={<SendOutlined />}
                disabled={logSubmissionBlocked}
                loading={directSubmitPending || logDeliveryActive}
                onClick={() => void submitCurrentReport()}
              >
                {logIntent?.status === 'failed'
                  ? '重新自动提交到钉钉'
                  : logDeliveryActive
                    ? '钉钉正在自动填写…'
                    : directSubmitStageLabel(directSubmitStage)}
              </Button>
            </Space>
          </div>

          {logIntent && (
            <Alert
              type={
                logIntent.status === 'succeeded'
                  ? 'success'
                  : ['failed', 'unknown', 'needs_review'].includes(logIntent.status)
                    ? 'error'
                    : 'info'
              }
              showIcon
              message={deliveryAutomationTitle(logIntent)}
              description={deliveryAutomationDescription(logIntent)}
            />
          )}

          {historicalUnresolvedLogIntent && (
            <Alert
              type="warning"
              showIcon
              message="此前自动提交结果仍未核对"
              description={`交付任务 ${historicalUnresolvedLogIntent.id} 的结果为“${deliveryStatusLabel(historicalUnresolvedLogIntent.status)}”。为避免重复提交，完成钉钉人工核对前不能创建新的正式日志。`}
              action={
                <Button onClick={() => openManualResolution(historicalUnresolvedLogIntent)}>
                  人工核对结果
                </Button>
              }
            />
          )}

          {submissionOperationLogs.length > 0 && (
            <Card size="small" title="自动提交操作日志">
              <Timeline
                items={submissionOperationLogs.map((item) => ({
                  color: submissionLogColor(item.status),
                  children: (
                    <Space direction="vertical" size={2}>
                      <Space wrap>
                        <Typography.Text strong>{item.title}</Typography.Text>
                        <Typography.Text type="secondary">
                          {dayjs(item.timestamp).format('HH:mm:ss')}
                        </Typography.Text>
                      </Space>
                      {item.detail && (
                        <Typography.Text type="secondary">{item.detail}</Typography.Text>
                      )}
                    </Space>
                  ),
                }))}
              />
            </Card>
          )}

          {SHOW_INTERNAL_WEEKLY_TOOLS && (
            <Card title="群聊测试（无需钉钉正式日志权限）">
              <Space direction="vertical" size={14} style={{ width: '100%' }}>
                <Alert
                  type="info"
                  showIcon
                  icon={<ExperimentOutlined />}
                  message="测试链路：生成测试数据 → AI 填写周报 → 选择群机器人 → 测试发送到群聊"
                  description="这里直接发送当前保存版本，不要求模板映射、接收范围、正式确认或钉钉日志应用权限。发送成功只代表群机器人链路可用。"
                />
                {healthyRobotConnections.length === 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="还没有可用的群机器人"
                    description="请先在设置中完成机器人 Webhook/加签配置并通过真实连接测试。"
                  />
                ) : (
                  <Space wrap align="end">
                    <div>
                      <Typography.Text strong>测试目标群聊</Typography.Text>
                      <Select
                        value={selectedRobotConnectionId}
                        placeholder="选择要测试发送到的群聊"
                        style={{ width: 360, display: 'block', marginTop: 6 }}
                        onChange={(value: string) => setSelectedRobotConnectionId(value)}
                        options={healthyRobotConnections.map((connection) => ({
                          value: connection.id,
                          label: robotGroupLabel(connection),
                        }))}
                      />
                    </div>
                    <Tooltip
                      title={
                        dirty || autosaveState === 'saving' || editMutation.isPending
                          ? '正在保存编辑，请等待当前版本保存完成后再发送'
                          : undefined
                      }
                    >
                      <Button
                        type="primary"
                        icon={<SendOutlined />}
                        disabled={testRobotNotificationBlocked}
                        loading={testNotifyGroupMutation.isPending}
                        onClick={confirmTestNotifyGroup}
                      >
                        测试发送当前周报
                      </Button>
                    </Tooltip>
                    <Typography.Text type="secondary">
                      当前将发送 v{version.versionNo}；不会创建正式日志
                    </Typography.Text>
                  </Space>
                )}
              </Space>
            </Card>
          )}

          {SHOW_INTERNAL_WEEKLY_TOOLS && (
            <Card
              title="钉钉双通道交付"
              extra={
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={deliveries.isFetching}
                  onClick={() => void deliveries.refetch()}
                >
                  刷新交付事实
                </Button>
              }
            >
              <Space direction="vertical" size={14} style={{ width: '100%' }}>
                {version.attachments.length > 0 && report.status === 'confirmed' && (
                  <Alert
                    type="warning"
                    showIcon
                    message="当前确认包含附件，正式日志提交已阻断"
                    description="当前已批准的钉钉正式日志适配器不能可靠上传附件。请开始新版本、移除附件并重新确认，或使用下方复制/附件导出人工兜底。"
                  />
                )}
                {logResultUnknown && (
                  <Alert
                    type="error"
                    showIcon
                    message="正式日志结果未知，禁止再次提交"
                    description="外部请求可能已经成功。请先执行只读查询或在钉钉人工核对；系统不会盲目重放。"
                    action={
                      logIntent ? (
                        <Button
                          size="small"
                          loading={reconcileDeliveryMutation.isPending}
                          onClick={() => confirmReconcileDelivery(logIntent)}
                        >
                          查询实际结果
                        </Button>
                      ) : undefined
                    }
                  />
                )}
                {report.delivery?.partial && (
                  <Alert
                    type="warning"
                    showIcon
                    message="部分交付：正式日志已成功，但群摘要尚未成功"
                    description="正式日志成功事实保持不变；可选择尚无交付意图的其他健康机器人。当前失败意图需等待受控恢复/重试，重复点击不会伪装成重试。"
                  />
                )}

                <Descriptions size="small" bordered column={{ xs: 1, sm: 2, lg: 3 }}>
                  <Descriptions.Item label="正式日志">
                    <Tag color={deliveryStatusColor(report.logDeliveryState)}>
                      {deliveryStatusLabel(report.logDeliveryState)}
                    </Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="群摘要">
                    <Tag color={deliveryStatusColor(report.robotDeliveryState)}>
                      {deliveryStatusLabel(report.robotDeliveryState)}
                    </Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="外部日志 ID">
                    <Typography.Text copyable={Boolean(logIntent?.externalId)}>
                      {logIntent?.externalId ?? '—'}
                    </Typography.Text>
                  </Descriptions.Item>
                </Descriptions>

                <Space wrap align="end">
                  <Button
                    type="primary"
                    danger
                    icon={<SendOutlined />}
                    disabled={logSubmissionBlocked}
                    loading={directSubmitPending || logDeliveryActive}
                    onClick={() => void submitCurrentReport()}
                  >
                    {logIntent?.status === 'failed'
                      ? '重新自动提交到钉钉'
                      : directSubmitStageLabel(directSubmitStage)}
                  </Button>
                  <div>
                    <Typography.Text type="secondary">目标群聊</Typography.Text>
                    <Select
                      value={selectedRobotConnectionId}
                      placeholder="选择要发送到的群聊"
                      style={{ width: 340, display: 'block', marginTop: 4 }}
                      onChange={(value: string) => setSelectedRobotConnectionId(value)}
                      options={healthyRobotConnections.map((connection) => ({
                        value: connection.id,
                        label: robotGroupLabel(connection),
                      }))}
                    />
                    <Typography.Text type="secondary" style={{ display: 'block', marginTop: 3 }}>
                      每个加签机器人对应一个固定群聊
                    </Typography.Text>
                  </div>
                  <Button
                    icon={<RobotOutlined />}
                    disabled={robotNotificationBlocked}
                    loading={notifyGroupMutation.isPending}
                    onClick={confirmNotifyGroup}
                  >
                    发送群交付摘要
                  </Button>
                  <Button
                    danger
                    icon={<ExclamationCircleOutlined />}
                    disabled={failureNotificationBlocked}
                    loading={notifyFailureMutation.isPending}
                    onClick={confirmNotifyFailure}
                  >
                    发送失败提醒
                  </Button>
                  <Button
                    icon={<ExclamationCircleOutlined />}
                    disabled={riskNotificationBlocked}
                    loading={notifyRiskMutation.isPending}
                    onClick={() => {
                      setSelectedRiskWarningIds([]);
                      setRiskNotificationOpen(true);
                    }}
                  >
                    发送严重风险提醒
                  </Button>
                  <Tooltip
                    title={
                      dirty || autosaveState === 'saving'
                        ? '请先保存当前编辑，导出只读取服务端不可变版本'
                        : undefined
                    }
                  >
                    <Button
                      icon={<CopyOutlined />}
                      disabled={dirty || autosaveState === 'saving'}
                      loading={exportCopyMutation.isPending}
                      onClick={() => {
                        if (!report || !version) return;
                        exportCopyMutation.mutate({
                          reportId: report.id,
                          versionId: version.id,
                          reportVersion: report.version,
                        });
                      }}
                    >
                      复制/导出人工兜底
                    </Button>
                  </Tooltip>
                </Space>

                {deliveryItems.length === 0 ? (
                  <Empty description="尚无交付意图" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  <Table
                    size="small"
                    rowKey="id"
                    pagination={false}
                    scroll={{ x: 1_180 }}
                    dataSource={deliveryItems}
                    expandable={{
                      expandedRowRender: (item) => (
                        <Space direction="vertical" size={10} style={{ width: '100%' }}>
                          <Descriptions size="small" bordered column={{ xs: 1, md: 2, lg: 3 }}>
                            <Descriptions.Item label="恢复状态">
                              {deliveryRecoveryStatusLabel(item.recoveryStatus)}
                            </Descriptions.Item>
                            <Descriptions.Item label="最后核对">
                              {formatDateTime(item.lastRecoveryAt)}
                            </Descriptions.Item>
                            <Descriptions.Item label="人工裁决">
                              {item.resolvedAt
                                ? `${formatDateTime(item.resolvedAt)} · ${item.resolvedBy ?? '本机用户'}`
                                : '—'}
                            </Descriptions.Item>
                            <Descriptions.Item label="裁决原因" span={3}>
                              {item.resolutionReason ?? '—'}
                            </Descriptions.Item>
                          </Descriptions>
                          {item.recoveryChecks.length === 0 ? (
                            <Typography.Text type="secondary">
                              尚无恢复查询或人工裁决证据
                            </Typography.Text>
                          ) : (
                            <Timeline
                              items={item.recoveryChecks.map((check) => ({
                                color:
                                  check.outcome === 'matched' ||
                                  check.outcome === 'manual_succeeded'
                                    ? 'green'
                                    : check.outcome === 'absence_confirmed' ||
                                        check.outcome === 'manual_absence_confirmed'
                                      ? 'blue'
                                      : check.outcome === 'ambiguous' ||
                                          check.outcome === 'query_failed'
                                        ? 'red'
                                        : 'gray',
                                children: (
                                  <Space direction="vertical" size={2}>
                                    <Space wrap>
                                      <Typography.Text strong>
                                        第 {check.sequenceNo} 次 ·{' '}
                                        {deliveryRecoveryOutcomeLabel(check.outcome)}
                                      </Typography.Text>
                                      <Tag>
                                        {check.mode === 'provider_query'
                                          ? '外部只读查询'
                                          : '人工裁决'}
                                      </Tag>
                                    </Space>
                                    <Typography.Text type="secondary">
                                      {formatDateTime(check.createdAt)} · 候选{' '}
                                      {check.candidateCount} · 精确命中 {check.exactMatchCount}
                                      {check.matchedExternalId
                                        ? ` · 外部 ID ${check.matchedExternalId}`
                                        : ''}
                                    </Typography.Text>
                                    <Typography.Text type="secondary" copyable>
                                      证据哈希 {check.evidenceHash}
                                    </Typography.Text>
                                  </Space>
                                ),
                              }))}
                            />
                          )}
                        </Space>
                      ),
                    }}
                    columns={[
                      {
                        title: '通道',
                        dataIndex: 'channel',
                        width: 130,
                        render: (value: WeeklyReportDeliveryIntent['channel']) =>
                          value === 'dingtalk_log' ? '正式日志' : '群摘要',
                      },
                      {
                        title: '状态',
                        dataIndex: 'status',
                        width: 120,
                        render: (value: string) => (
                          <Tag color={deliveryStatusColor(value)}>{deliveryStatusLabel(value)}</Tag>
                        ),
                      },
                      { title: '尝试次数', dataIndex: 'attemptCount', width: 100 },
                      {
                        title: '计划/批准',
                        key: 'schedule',
                        width: 210,
                        render: (_value: unknown, item: WeeklyReportDeliveryIntent) => (
                          <Space direction="vertical" size={0}>
                            <Typography.Text>{formatDateTime(item.scheduledFor)}</Typography.Text>
                            <Typography.Text type="secondary">
                              {item.scheduleApprovedAt
                                ? `批准于 ${formatDateTime(item.scheduleApprovedAt)}`
                                : '立即提交'}
                            </Typography.Text>
                          </Space>
                        ),
                      },
                      {
                        title: '恢复状态',
                        dataIndex: 'recoveryStatus',
                        width: 170,
                        render: (value: string) => deliveryRecoveryStatusLabel(value),
                      },
                      {
                        title: '外部标识',
                        dataIndex: 'externalId',
                        width: 210,
                        ellipsis: true,
                        render: (value: string | null) => value ?? '—',
                      },
                      {
                        title: '最近错误',
                        key: 'error',
                        width: 220,
                        render: (_value: unknown, item: WeeklyReportDeliveryIntent) =>
                          item.lastErrorCode ? (
                            <Tooltip title={item.lastErrorSummary ?? item.lastErrorCode}>
                              <Typography.Text type="danger">{item.lastErrorCode}</Typography.Text>
                            </Tooltip>
                          ) : item.status === 'unknown' || item.status === 'needs_review' ? (
                            '必须人工复核'
                          ) : (
                            '—'
                          ),
                      },
                      {
                        title: '更新时间',
                        dataIndex: 'updatedAt',
                        width: 170,
                        render: (value: string) => formatDateTime(value),
                      },
                      {
                        title: '恢复动作',
                        key: 'actions',
                        width: 300,
                        fixed: 'right',
                        render: (_value: unknown, item: WeeklyReportDeliveryIntent) => {
                          const connection = (integrations.data?.data ?? []).find(
                            (candidate) => candidate.id === item.connectionId,
                          );
                          const actions = deliveryRecoveryActions(item, {
                            resultQuerySupported: connection?.type !== 'dingtalk_desktop',
                          });
                          return (
                            <Space wrap>
                              {actions.canReconcile && (
                                <Button
                                  size="small"
                                  loading={
                                    reconcileDeliveryMutation.isPending &&
                                    reconcileDeliveryMutation.variables?.intentId === item.id
                                  }
                                  onClick={() => confirmReconcileDelivery(item)}
                                >
                                  查询钉钉结果
                                </Button>
                              )}
                              {actions.canResolve && (
                                <Button size="small" onClick={() => openManualResolution(item)}>
                                  人工裁决
                                </Button>
                              )}
                              {actions.canRetry && (
                                <Button size="small" danger onClick={() => openDeliveryRetry(item)}>
                                  受控重试
                                </Button>
                              )}
                              {!actions.canReconcile &&
                                !actions.canResolve &&
                                !actions.canRetry &&
                                (actions.retryBlockedReason ? (
                                  <Tooltip title={actions.retryBlockedReason}>
                                    <Typography.Text type="secondary">不可重试</Typography.Text>
                                  </Tooltip>
                                ) : (
                                  '—'
                                ))}
                            </Space>
                          );
                        },
                      },
                    ]}
                  />
                )}

                <Typography.Title level={5} style={{ margin: '8px 0 0' }}>
                  机器人通知账本
                </Typography.Title>
                {notificationItems.length === 0 ? (
                  <Empty description="尚无业务通知事实" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  <Table
                    size="small"
                    rowKey="id"
                    pagination={false}
                    scroll={{ x: 1_100 }}
                    dataSource={notificationItems}
                    columns={[
                      {
                        title: '通知类型',
                        dataIndex: 'notificationType',
                        width: 150,
                        render: (value: WeeklyReportRobotNotification['notificationType']) =>
                          notificationTypeLabel(value),
                      },
                      {
                        title: '状态',
                        dataIndex: 'status',
                        width: 120,
                        render: (value: WeeklyReportRobotNotification['status']) => (
                          <Tag color={deliveryStatusColor(value)}>{deliveryStatusLabel(value)}</Tag>
                        ),
                      },
                      {
                        title: '状态版本',
                        dataIndex: 'stateVersion',
                        width: 100,
                        render: (value: number) => `v${value}`,
                      },
                      {
                        title: '静默合并',
                        dataIndex: 'coalescedCount',
                        width: 100,
                        render: (value: number) => `${value} 次`,
                      },
                      {
                        title: '供应商调用',
                        key: 'providerCalls',
                        width: 170,
                        render: (_value: unknown, item: WeeklyReportRobotNotification) =>
                          `${item.providerCallCount} 次${item.retryDelaysMs.length ? ` · 等待 ${item.retryDelaysMs.join('/')}ms` : ''}`,
                      },
                      {
                        title: '最近错误/跳过原因',
                        key: 'error',
                        width: 260,
                        ellipsis: true,
                        render: (_value: unknown, item: WeeklyReportRobotNotification) => {
                          const detail = item.lastErrorSummary ?? item.skipReason;
                          return detail ? (
                            <Tooltip title={detail}>
                              <Typography.Text type="danger">
                                {item.lastErrorCode ?? detail}
                              </Typography.Text>
                            </Tooltip>
                          ) : (
                            '—'
                          );
                        },
                      },
                      {
                        title: '发送/更新时间',
                        key: 'time',
                        width: 180,
                        render: (_value: unknown, item: WeeklyReportRobotNotification) =>
                          formatDateTime(item.sentAt ?? item.updatedAt),
                      },
                    ]}
                  />
                )}
              </Space>
            </Card>
          )}

          {autosaveState === 'conflict' && (
            <Alert
              type="error"
              showIcon
              message="自动保存遇到并发冲突"
              description="其他页面已生成新版本。当前输入未继续覆盖服务端；请复制必要文本后刷新并比较版本。"
              action={<Button onClick={() => window.location.reload()}>刷新页面</Button>}
            />
          )}

          <div>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Card
                title="六字段正文"
                extra={
                  <Space wrap>
                    <AutosaveTag state={autosaveState} />
                    <Tooltip title={previousId ? '恢复上一历史版本并创建新版本' : '没有更早版本'}>
                      <Button
                        icon={<UndoOutlined />}
                        disabled={!previousId || restoreMutation.isPending}
                        onClick={() =>
                          previousId && restoreVersion(previousId, '撤销：恢复上一历史版本', 'undo')
                        }
                      >
                        撤销
                      </Button>
                    </Tooltip>
                    <Button
                      icon={<RedoOutlined />}
                      disabled={redoStack.length === 0 || restoreMutation.isPending}
                      onClick={() => {
                        const target = redoStack.at(-1);
                        if (target) restoreVersion(target, '重做：恢复撤销前版本', 'redo');
                      }}
                    >
                      重做
                    </Button>
                    <Button icon={<RobotOutlined />} onClick={() => setAiOpen(true)}>
                      AI 填写 / 建议
                    </Button>
                    <Button
                      icon={<DiffOutlined />}
                      loading={contentTemplate.isLoading}
                      disabled={editMutation.isPending}
                      onClick={applyContentTemplateToCurrentReport}
                    >
                      应用周报模板
                    </Button>
                    <Button icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>
                      历史
                    </Button>
                    <Button
                      type="primary"
                      icon={<SaveOutlined />}
                      disabled={!dirty}
                      loading={editMutation.isPending}
                      onClick={saveFieldsNow}
                    >
                      立即保存
                    </Button>
                  </Space>
                }
              >
                <Form<EditorValues>
                  form={form}
                  layout="vertical"
                  onValuesChange={() => {
                    setDirty(true);
                    setAutosaveState('dirty');
                  }}
                >
                  {weeklyReportFields.map((definition) => (
                    <Form.Item
                      key={definition.key}
                      name={definition.key}
                      label={definition.label}
                      rules={
                        definition.key === 'reportDate'
                          ? [{ required: true, message: `${definition.label}不能为空` }]
                          : [
                              {
                                type: 'string',
                                required: true,
                                whitespace: true,
                                message: `${definition.label}不能为空`,
                              },
                            ]
                      }
                    >
                      {definition.key === 'reportDate' ? (
                        <DatePicker allowClear={false} style={{ width: 220 }} />
                      ) : (
                        <Input.TextArea
                          autoSize={{
                            minRows: definition.key === 'weeklyWork' ? 7 : 4,
                            maxRows: 18,
                          }}
                          showCount
                          maxLength={50_000}
                        />
                      )}
                    </Form.Item>
                  ))}
                </Form>
              </Card>
            </Space>

            {SHOW_INTERNAL_WEEKLY_TOOLS && (
              <Card className="weekly-context-card" title="来源与版本上下文">
                <Tabs
                  items={[
                    {
                      key: 'sources',
                      label: `正文来源 ${version.sourceLinks.length}`,
                      children:
                        sourceGroups.size === 0 ? (
                          <Empty
                            description="当前版本没有来源链接"
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                          />
                        ) : (
                          <Collapse
                            size="small"
                            defaultActiveKey={[...sourceGroups.keys()]}
                            items={[...sourceGroups.entries()].map(([field, links]) => ({
                              key: field,
                              label: `${fieldLabel(field)} · ${links.length}`,
                              children: (
                                <List
                                  size="small"
                                  dataSource={links}
                                  renderItem={(link) => (
                                    <List.Item>
                                      <Space
                                        direction="vertical"
                                        size={2}
                                        style={{ width: '100%' }}
                                      >
                                        <Space wrap>
                                          <Tag color={sourceColor(link.sourceType)}>
                                            {link.sourceType}
                                          </Tag>
                                          <Typography.Text code>{link.sourceId}</Typography.Text>
                                        </Space>
                                        <Typography.Text>
                                          {sourceTitle(link.sourceSummary)}
                                        </Typography.Text>
                                        <Typography.Text type="secondary" ellipsis>
                                          哈希 {link.sourceContentHash.slice(0, 16)}…
                                        </Typography.Text>
                                      </Space>
                                    </List.Item>
                                  )}
                                />
                              ),
                            }))}
                          />
                        ),
                    },
                    {
                      key: 'warnings',
                      label: `Warning ${version.warnings.length}`,
                      children:
                        version.warnings.length === 0 ? (
                          <Empty description="没有 warning" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                        ) : (
                          <Space direction="vertical" size={10} style={{ width: '100%' }}>
                            {version.warnings.map((warning) => (
                              <Alert
                                key={warning.id}
                                type={warning.blocking ? 'error' : 'warning'}
                                showIcon
                                message={warning.code}
                                description={warning.message ?? warningText(warning)}
                              />
                            ))}
                          </Space>
                        ),
                    },
                    {
                      key: 'candidates',
                      label: `候选 ${candidates.length}`,
                      children:
                        candidates.length === 0 ? (
                          <Empty
                            description="没有未确认证据候选"
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                          />
                        ) : (
                          <List
                            size="small"
                            dataSource={candidates}
                            renderItem={(candidate) => (
                              <List.Item>
                                <Space direction="vertical" size={2}>
                                  <Space>
                                    <Tag color="gold">待确认</Tag>
                                    <Typography.Text>
                                      {String(candidate.title ?? candidate.id)}
                                    </Typography.Text>
                                  </Space>
                                  <Typography.Text type="secondary">
                                    只进入快照候选，不会擅自写入正文或绑定任务。
                                  </Typography.Text>
                                </Space>
                              </List.Item>
                            )}
                          />
                        ),
                    },
                    {
                      key: 'snapshot',
                      label: '快照',
                      children: (
                        <Descriptions column={1} size="small" bordered>
                          <Descriptions.Item label="来源哈希">
                            <Typography.Text code copyable>
                              {version.sourceSnapshot.sourceContentHash}
                            </Typography.Text>
                          </Descriptions.Item>
                          <Descriptions.Item label="规则版本">
                            {version.sourceSnapshot.ruleVersion}
                          </Descriptions.Item>
                          <Descriptions.Item label="净化策略">
                            {version.sourceSnapshot.sanitizationPolicyVersion}
                          </Descriptions.Item>
                          <Descriptions.Item label="Jira 成功运行">
                            {version.sourceSnapshot.jiraSyncRunIds.length
                              ? version.sourceSnapshot.jiraSyncRunIds.join('、')
                              : '无'}
                          </Descriptions.Item>
                          <Descriptions.Item label="新鲜度策略">
                            {safeText(version.sourceSnapshot.freshnessPolicy.mode, '未知')}
                          </Descriptions.Item>
                          <Descriptions.Item label="冻结时间">
                            {formatDateTime(version.sourceSnapshot.createdAt)}
                          </Descriptions.Item>
                        </Descriptions>
                      ),
                    },
                  ]}
                />
              </Card>
            )}
          </div>
        </>
      ) : (
        <Card loading />
      )}

      <Modal
        title="六字段复制与附件导出"
        width={920}
        open={Boolean(exportCopyPreview)}
        footer={
          exportCopyPreview
            ? [
                <Button key="close" onClick={() => setExportCopyPreview(null)}>
                  关闭
                </Button>,
                <Button
                  key="copy"
                  icon={<CopyOutlined />}
                  onClick={() => {
                    void copyToClipboard(exportCopyPreview.copyText).then((copied) => {
                      void (copied
                        ? messageApi.success('六字段模板文本已复制；仍需在钉钉人工提交')
                        : messageApi.error('浏览器拒绝剪贴板访问，请在预览框中手工复制'));
                    });
                  }}
                >
                  复制模板文本
                </Button>,
                <Button
                  key="download"
                  type="primary"
                  icon={<DownloadOutlined />}
                  onClick={() => downloadBase64Attachment(exportCopyPreview.attachment)}
                >
                  导出 UTF-8 附件
                </Button>,
              ]
            : null
        }
        onCancel={() => setExportCopyPreview(null)}
      >
        {exportCopyPreview && (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              message="未正式提交"
              description="本次操作只生成供人工复制或上传的本地材料；不会调用钉钉日志、机器人或网页自动化，也不能作为正式提交成功证明。"
            />
            <Descriptions size="small" bordered column={{ xs: 1, md: 2 }}>
              <Descriptions.Item label="冻结版本">
                v{exportCopyPreview.versionNo} · {exportCopyPreview.contentHash.slice(0, 16)}…
              </Descriptions.Item>
              <Descriptions.Item label="模板字段来源">
                {exportCopyPreview.mappingSource === 'frozen_mapping'
                  ? '冻结钉钉模板映射'
                  : '标准六字段降级映射'}
              </Descriptions.Item>
              <Descriptions.Item label="当前正式日志事实">
                {deliveryStatusLabel(exportCopyPreview.formalLogState)}
              </Descriptions.Item>
              <Descriptions.Item label="附件 SHA-256">
                <Typography.Text code copyable>
                  {exportCopyPreview.attachment.sha256}
                </Typography.Text>
              </Descriptions.Item>
            </Descriptions>
            {exportCopyPreview.warnings.map((warning) => (
              <Alert key={warning} type="warning" showIcon message={warning} />
            ))}
            <Input.TextArea
              readOnly
              rows={22}
              value={exportCopyPreview.copyText}
              aria-label="未正式提交的六字段模板文本预览"
            />
          </Space>
        )}
      </Modal>

      <Modal
        title="人工裁决钉钉交付结果"
        width={720}
        open={Boolean(manualResolutionIntent)}
        okText="确认并写入裁决事实"
        okButtonProps={{ danger: true }}
        confirmLoading={resolveDeliveryMutation.isPending}
        onCancel={() => {
          setManualResolutionIntent(null);
          manualResolutionForm.resetFields();
        }}
        onOk={() => {
          if (!manualResolutionIntent) return;
          // 表单校验失败由控件就地展示，接口失败由 mutation 统一提示，避免产生未处理 Promise。
          void manualResolutionForm
            .validateFields()
            .then((values) =>
              resolveDeliveryMutation.mutateAsync({
                reportId: manualResolutionIntent.reportId,
                intentId: manualResolutionIntent.id,
                intentVersion: manualResolutionIntent.version,
                values,
              }),
            )
            .catch(() => undefined);
        }}
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="人工裁决会改变本机交付主事实"
            description="请先在钉钉客户端核对模板、操作用户、时间和六字段。确认已交付必须填写真实日志 ID；确认未交付后才可能开放受控重试。"
          />
          <Form<ManualResolutionValues>
            form={manualResolutionForm}
            layout="vertical"
            initialValues={{ resolution: 'delivered' }}
          >
            <Form.Item
              name="resolution"
              label="钉钉实际结果"
              rules={[{ required: true, message: '请选择实际结果' }]}
            >
              <Segmented
                block
                options={[
                  { label: '已找到本次正式日志', value: 'delivered' },
                  { label: '确认未创建/未发送', value: 'not_delivered' },
                ]}
              />
            </Form.Item>
            <Form.Item noStyle shouldUpdate>
              {({ getFieldValue }) =>
                getFieldValue('resolution') === 'delivered' ? (
                  <>
                    <Form.Item
                      name="externalId"
                      label="钉钉日志 ID"
                      rules={[
                        {
                          required: true,
                          whitespace: true,
                          message: '确认已交付时必须填写日志 ID',
                        },
                        { max: 500 },
                      ]}
                    >
                      <Input placeholder="从钉钉实际日志中复制，不要猜测" />
                    </Form.Item>
                    <Form.Item
                      name="externalUrl"
                      label="可打开链接（可选）"
                      rules={[{ max: 2_000 }]}
                    >
                      <Input placeholder="仅填写已核对的 https:// 或 dingtalk:// 链接" />
                    </Form.Item>
                  </>
                ) : (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="确认未交付时不会保存外部 ID；提交后仍需点击“受控重试”才能创建新 attempt。"
                  />
                )
              }
            </Form.Item>
            <Form.Item
              name="reason"
              label="核对依据与原因"
              rules={[
                { required: true, whitespace: true, message: '请记录人工核对依据' },
                { min: 5, max: 500 },
              ]}
            >
              <Input.TextArea
                rows={3}
                placeholder="例如：在钉钉发件箱按模板与时间核对，六字段唯一匹配……"
              />
            </Form.Item>
            <Form.Item
              name="confirmationPhrase"
              label="强确认短语"
              extra="请输入：我已在钉钉人工核对交付结果"
              rules={[
                { required: true, message: '必须输入强确认短语' },
                {
                  validator: (_rule, value: unknown) =>
                    value === '我已在钉钉人工核对交付结果'
                      ? Promise.resolve()
                      : Promise.reject(new Error('确认短语不一致')),
                },
              ]}
            >
              <Input autoComplete="off" />
            </Form.Item>
          </Form>
        </Space>
      </Modal>

      <Modal
        title="发起一次受控新尝试"
        width={660}
        open={Boolean(deliveryRetryIntent)}
        okText="创建新 attempt"
        okButtonProps={{ danger: true }}
        confirmLoading={retryDeliveryMutation.isPending}
        onCancel={() => {
          setDeliveryRetryIntent(null);
          deliveryRetryForm.resetFields();
        }}
        onOk={() => {
          if (!deliveryRetryIntent) return;
          // 受控重试只在完整校验后创建新 attempt，失败提示统一由 mutation 输出。
          void deliveryRetryForm
            .validateFields()
            .then((values) =>
              retryDeliveryMutation.mutateAsync({
                reportId: deliveryRetryIntent.reportId,
                intentId: deliveryRetryIntent.id,
                intentVersion: deliveryRetryIntent.version,
                reason: values.reason,
              }),
            )
            .catch(() => undefined);
        }}
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="这会产生一次新的外部写尝试"
            description="仅明确失败或已证明未交付的意图可执行；每个作业只尝试一次，总 attempt 上限为三次。正式日志结果未知时后端仍会拒绝。"
          />
          {deliveryRetryIntent && (
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="通道">
                {deliveryRetryIntent.channel === 'dingtalk_log' ? '正式日志' : '群摘要'}
              </Descriptions.Item>
              <Descriptions.Item label="当前尝试次数">
                {deliveryRetryIntent.attemptCount} / 3
              </Descriptions.Item>
              <Descriptions.Item label="失败/恢复事实">
                {deliveryRecoveryStatusLabel(deliveryRetryIntent.recoveryStatus)}
                {deliveryRetryIntent.lastErrorCode ? ` · ${deliveryRetryIntent.lastErrorCode}` : ''}
              </Descriptions.Item>
            </Descriptions>
          )}
          <Form<DeliveryRetryValues> form={deliveryRetryForm} layout="vertical">
            <Form.Item
              name="reason"
              label="重试原因与已完成的修正"
              rules={[
                { required: true, whitespace: true, message: '请说明为什么现在可以重试' },
                { min: 3, max: 500 },
              ]}
            >
              <Input.TextArea
                rows={4}
                placeholder="例如：已修复应用权限并重新测试连接；或连续查询已确认未创建……"
              />
            </Form.Item>
          </Form>
        </Space>
      </Modal>

      <Modal
        title="新建周报模板"
        open={contentTemplateOpen}
        confirmLoading={contentTemplateMutation.isPending}
        okText="保存默认内容"
        cancelText="取消"
        width={820}
        onCancel={() => setContentTemplateOpen(false)}
        onOk={() => {
          void contentTemplateForm.validateFields().then((values) => {
            contentTemplateMutation.mutate(values);
          });
        }}
      >
        <Alert
          type="info"
          showIcon
          message="这里维护六字段正文模块的默认内容"
          description="保存后，新建周报会优先使用非空默认值；已有周报可在六字段正文右上角点击“应用周报模板”。模板中留空的字段不会覆盖已有内容，填写日期也不会被模板修改。"
          style={{ marginBottom: 16 }}
        />
        <Form form={contentTemplateForm} layout="vertical">
          {weeklyReportFields
            .filter((definition) => definition.key !== 'reportDate')
            .map((definition) => (
              <Form.Item key={definition.key} name={definition.key} label={definition.label}>
                <Input.TextArea
                  autoSize={{ minRows: definition.key === 'weeklyWork' ? 5 : 3, maxRows: 12 }}
                  showCount
                  maxLength={50_000}
                  placeholder={`输入${definition.label}的默认内容；留空则自动生成`}
                />
              </Form.Item>
            ))}
        </Form>
      </Modal>

      <Modal
        title="新建周报"
        open={generateOpen}
        confirmLoading={generateMutation.isPending}
        okText="生成周报"
        cancelText="取消"
        width={720}
        onCancel={() => setGenerateOpen(false)}
        onOk={() => {
          void generateForm.validateFields().then((values) => {
            const custom = values.customPeriod;
            generateMutation.mutate({
              ...(custom
                ? {
                    periodStart: values.period[0].format('YYYY-MM-DD'),
                    periodEnd: values.period[1].format('YYYY-MM-DD'),
                    reportDate: values.reportDate.format('YYYY-MM-DD'),
                  }
                : {}),
              timezone: 'Asia/Shanghai',
              freshnessPolicy: {
                mode: values.freshnessMode,
                taskMaxAgeMinutes: 1_440,
                evidenceMaxAgeMinutes: 1_440,
              },
              includeUnconfirmedEvidence: values.includeUnconfirmedEvidence,
              existingReportPolicy: 'reject',
            });
          });
        }}
      >
        <Form
          form={generateForm}
          layout="vertical"
          initialValues={{
            customPeriod: false,
            freshnessMode: 'allow_stale',
            includeUnconfirmedEvidence: false,
          }}
        >
          <Form.Item name="customPeriod" label="周期计算">
            <Segmented
              options={[
                { value: false, label: '企业工作日历默认周' },
                { value: true, label: '指定周期' },
              ]}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(
              before: Partial<{ customPeriod: boolean }>,
              after: Partial<{ customPeriod: boolean }>,
            ) => before.customPeriod !== after.customPeriod}
          >
            {({ getFieldValue }) =>
              getFieldValue('customPeriod') ? (
                <div className="form-grid">
                  <Form.Item
                    name="period"
                    label="周报周期"
                    rules={[{ required: true, message: '请选择完整周期' }]}
                  >
                    <DatePicker.RangePicker allowClear={false} />
                  </Form.Item>
                  <Form.Item
                    name="reportDate"
                    label="填写日期"
                    rules={[{ required: true, message: '请选择填写日期' }]}
                  >
                    <DatePicker allowClear={false} />
                  </Form.Item>
                </div>
              ) : (
                <Alert
                  type="info"
                  showIcon
                  message="服务端按 Asia/Shanghai 企业工作日历计算周期；未配置日历时会回退周一至周五并保留 warning。"
                  style={{ marginBottom: 16 }}
                />
              )
            }
          </Form.Item>
          <Typography.Text type="secondary">
            将使用最近一次已同步的工作数据生成草稿，生成后可继续编辑。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title="选择当前版本的严重风险"
        width={760}
        open={riskNotificationOpen}
        onCancel={() => setRiskNotificationOpen(false)}
        okText="确认发送风险短摘要"
        cancelText="取消"
        confirmLoading={notifyRiskMutation.isPending}
        okButtonProps={{
          danger: true,
          disabled: selectedRiskWarningIds.length < 1 || selectedRiskWarningIds.length > 3,
        }}
        onOk={() => {
          if (
            !report ||
            !version ||
            !selectedRobotConnectionId ||
            selectedRiskWarningIds.length < 1 ||
            selectedRiskWarningIds.length > 3
          )
            return;
          notifyRiskMutation.mutate({
            reportId: report.id,
            robotConnectionId: selectedRobotConnectionId,
            versionId: version.id,
            warningIds: selectedRiskWarningIds,
            reportVersion: report.version,
          });
        }}
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="只发送已配置规则对应的当前版本 warning，最多三项"
            description="正文由服务端从当前不可变版本提取并生成固定短模板；页面不能提交任意风险文字，六字段全文、附件、凭证和本机链接不会外发。"
          />
          <Typography.Text>
            目标群聊：
            {selectedRobotConnection
              ? robotGroupLabel(selectedRobotConnection)
              : (selectedRobotConnectionId ?? '未选择')}
          </Typography.Text>
          {severeRiskWarnings.length === 0 ? (
            <Empty description="当前版本没有符合机器人严重规则配置的 warning" />
          ) : (
            <Checkbox.Group
              value={selectedRiskWarningIds}
              onChange={(values) => setSelectedRiskWarningIds(values.slice(0, 3))}
              style={{ width: '100%' }}
            >
              <Space direction="vertical" style={{ width: '100%' }}>
                {severeRiskWarnings.map((warning) => (
                  <Card size="small" key={warning.id}>
                    <Checkbox
                      value={warning.id}
                      disabled={
                        selectedRiskWarningIds.length >= 3 &&
                        !selectedRiskWarningIds.includes(warning.id)
                      }
                    >
                      <Space wrap>
                        <Tag color="red">{warning.code}</Tag>
                        <Typography.Text>{warning.message}</Typography.Text>
                      </Space>
                    </Checkbox>
                  </Card>
                ))}
              </Space>
            </Checkbox.Group>
          )}
          <Typography.Text type="secondary">
            已选择 {selectedRiskWarningIds.length}/3
            项；状态版本去重和机器人静默窗口仍会在服务端生效。
          </Typography.Text>
        </Space>
      </Modal>

      <Drawer
        title="AI 建议、净化边界与引用依据"
        width={1040}
        open={aiOpen}
        onClose={() => setAiOpen(false)}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            icon={<SafetyCertificateOutlined />}
            message="AI 生成后仍由你决定是否提交"
            description="AI 会根据已采集的工作信息生成周报正文。生成后可以继续修改，点击提交前不会写入钉钉。"
          />

          <Card title="生成新的 AI 建议" size="small">
            <Form<AiSuggestionFormValues>
              form={aiForm}
              layout="vertical"
              initialValues={{
                fields: ['recentGoals', 'weeklyWork', 'nextWeekPlans', 'problems', 'other'],
                allowPeopleNames: false,
                allowInternalUrls: false,
                allowDescriptionSummaries: false,
              }}
              onFinish={(values) => {
                if (!report || !version) return;
                aiSuggestionMutation.mutate({
                  reportId: report.id,
                  baseVersionId: version.id,
                  reportVersion: report.version,
                  values,
                  mode: 'suggestion',
                });
              }}
            >
              <Form.Item
                name="providerConnectionId"
                label="AI 连接（必须已通过真实连接测试）"
                rules={[{ required: true, message: '请选择 AI 连接' }]}
              >
                <Select
                  placeholder="选择健康的 AI 连接"
                  options={aiConnections.map((connection) => ({
                    value: connection.id,
                    disabled: connection.status !== 'healthy',
                    label: `${connection.name} · ${safeText(connection.config.protocol, '未知协议')} · ${safeText(connection.config.model, '未知模型')} · ${connection.status}`,
                  }))}
                />
              </Form.Item>
              {aiConnections.length === 0 && (
                <Alert
                  type="warning"
                  showIcon
                  message="尚无 AI 连接"
                  description="请先在设置页配置协议、模型、用途与凭证，并完成真实连接测试。"
                  style={{ marginBottom: 16 }}
                />
              )}
              <Form.Item
                name="fields"
                label="建议范围"
                rules={[{ required: true, message: '至少选择一个正文栏位' }]}
              >
                <Checkbox.Group
                  options={weeklyReportFields
                    .filter((field) => field.key !== 'reportDate')
                    .map((field) => ({ label: field.label, value: field.key }))}
                />
              </Form.Item>
              <Divider titlePlacement="start" plain>
                条件数据同意（默认全部关闭）
              </Divider>
              <Space direction="vertical" size={8}>
                <Form.Item name="allowPeopleNames" valuePropName="checked" noStyle>
                  <Checkbox>允许发送白名单事实中明确存在的人员姓名</Checkbox>
                </Form.Item>
                <Form.Item name="allowInternalUrls" valuePropName="checked" noStyle>
                  <Checkbox>
                    允许发送依据 HTTPS URL（用户名、密码、查询参数和片段仍会移除）
                  </Checkbox>
                </Form.Item>
                <Form.Item name="allowDescriptionSummaries" valuePropName="checked" noStyle>
                  <Checkbox>允许发送按政策生成且已同意的 Jira 描述摘要</Checkbox>
                </Form.Item>
              </Space>
              <Space wrap>
                <Button
                  htmlType="submit"
                  icon={<RobotOutlined />}
                  loading={aiSuggestionMutation.isPending}
                  disabled={
                    !report || !version || aiConnections.every((item) => item.status !== 'healthy')
                  }
                >
                  仅生成独立建议
                </Button>
                <Button
                  type="primary"
                  icon={<RobotOutlined />}
                  loading={aiSuggestionMutation.isPending || adoptAiMutation.isPending}
                  disabled={
                    !report || !version || aiConnections.every((item) => item.status !== 'healthy')
                  }
                  onClick={() => void fillReportWithAi()}
                >
                  AI 生成并填入周报
                </Button>
              </Space>
            </Form>
          </Card>

          <Card
            title={`生成与人工决定历史（${aiGenerations.data?.data.total ?? 0}）`}
            size="small"
            extra={
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={aiGenerations.isFetching}
                onClick={() => void aiGenerations.refetch()}
              >
                刷新
              </Button>
            }
          >
            {(aiGenerations.data?.data.items ?? []).length === 0 ? (
              <Empty description="尚无 AI 生成尝试" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <List
                dataSource={aiGenerations.data?.data.items ?? []}
                renderItem={(generation) => {
                  const suggestion = generation.suggestionVersions[0];
                  return (
                    <List.Item>
                      <Card size="small" style={{ width: '100%' }}>
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          <Space wrap>
                            <Tag color={aiGenerationStatusColor(generation.status)}>
                              {aiGenerationStatusLabel(generation.status)}
                            </Tag>
                            <Tag color={aiDecisionColor(generation.adoptionStatus)}>
                              {aiDecisionLabel(generation.adoptionStatus)}
                            </Tag>
                            {generation.stale && <Tag color="orange">基线已变化</Tag>}
                            {suggestion && <Tag color="blue">建议 v{suggestion.versionNo}</Tag>}
                            <Typography.Text strong>
                              {generation.protocol} · {generation.model}
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              {formatDateTime(generation.createdAt)} ·{' '}
                              {generation.durationMs ?? '—'} ms
                            </Typography.Text>
                          </Space>
                          <Typography.Text>
                            范围：
                            {generation.requestedFields.map(weeklyFieldLabel).join('、') || '—'}
                          </Typography.Text>
                          {generation.errorCode && (
                            <Alert
                              type={generation.status === 'blocked' ? 'warning' : 'error'}
                              showIcon
                              message={`未采用 AI 输出：${generation.errorCode}`}
                              description={
                                generation.securityBlocks.length > 0
                                  ? `本地阻断类别：${generation.securityBlocks.join('、')}`
                                  : '已保持当前规则/人工版本，编辑流程未被阻塞。'
                              }
                            />
                          )}
                          <Space wrap>
                            <Button
                              size="small"
                              onClick={() => setSelectedAiGenerationId(generation.id)}
                            >
                              查看净化与引用依据
                            </Button>
                            {suggestion && (
                              <Button
                                size="small"
                                icon={<DiffOutlined />}
                                onClick={() => setCompareVersionId(suggestion.id)}
                              >
                                与当前版本比较
                              </Button>
                            )}
                            {generation.adoptionStatus === 'pending' && suggestion && (
                              <>
                                <Button
                                  size="small"
                                  type="primary"
                                  disabled={generation.stale || adoptAiMutation.isPending}
                                  onClick={() => confirmAiDecision(generation, 'adopt')}
                                >
                                  核对后采纳
                                </Button>
                                <Button
                                  size="small"
                                  danger
                                  loading={rejectAiMutation.isPending}
                                  onClick={() => confirmAiDecision(generation, 'reject')}
                                >
                                  拒绝本次建议
                                </Button>
                              </>
                            )}
                          </Space>
                          {generation.decisionReason && (
                            <Typography.Text type="secondary">
                              人工决定：{generation.decisionReason}（
                              {formatDateTime(generation.decidedAt)}）
                            </Typography.Text>
                          )}
                        </Space>
                      </Card>
                    </List.Item>
                  );
                }}
              />
            )}
          </Card>

          {selectedAiGenerationId && (
            <Card
              title="生成详情与逐段引用"
              size="small"
              loading={aiGenerationDetail.isLoading}
              extra={
                <Button size="small" onClick={() => setSelectedAiGenerationId(null)}>
                  关闭详情
                </Button>
              }
            >
              {aiGenerationDetail.data?.data && (
                <Space direction="vertical" size={14} style={{ width: '100%' }}>
                  <Descriptions size="small" bordered column={2}>
                    <Descriptions.Item label="配置版本">
                      {aiGenerationDetail.data.data.providerConfigVersion}
                    </Descriptions.Item>
                    <Descriptions.Item label="提示词版本">
                      {aiGenerationDetail.data.data.promptTemplateVersion}
                    </Descriptions.Item>
                    <Descriptions.Item label="净化策略版本">
                      {aiGenerationDetail.data.data.sanitizationPolicyVersion}
                    </Descriptions.Item>
                    <Descriptions.Item label="留存方式">
                      {aiGenerationDetail.data.data.retentionMode}
                    </Descriptions.Item>
                    <Descriptions.Item label="净化输入哈希" span={2}>
                      <Typography.Text copyable code>
                        {aiGenerationDetail.data.data.sanitizedInputHash ?? '阻断发生在哈希生成前'}
                      </Typography.Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="供应商请求 ID">
                      {aiGenerationDetail.data.data.providerRequestId ?? '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="停止原因">
                      {aiGenerationDetail.data.data.stopReason ?? '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Token usage">
                      输入 {aiGenerationDetail.data.data.usage.inputTokens ?? '—'} / 输出{' '}
                      {aiGenerationDetail.data.data.usage.outputTokens ?? '—'} / 总计{' '}
                      {aiGenerationDetail.data.data.usage.totalTokens ?? '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="已移除类别">
                      {aiGenerationDetail.data.data.removedCategories.length > 0
                        ? aiGenerationDetail.data.data.removedCategories.join('、')
                        : '无'}
                    </Descriptions.Item>
                  </Descriptions>

                  <Divider titlePlacement="start" plain>
                    本次本地引用映射
                  </Divider>
                  <Table
                    size="small"
                    rowKey="refId"
                    pagination={false}
                    dataSource={aiGenerationDetail.data.data.inputRefs ?? []}
                    columns={[
                      {
                        title: '引用 ID',
                        dataIndex: 'refId',
                        render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
                      },
                      { title: '类型', dataIndex: 'sourceType', width: 110 },
                      {
                        title: '栏位',
                        dataIndex: 'field',
                        width: 130,
                        render: (value: string | null) =>
                          value ? weeklyFieldLabel(value) : '跨栏位事实',
                      },
                      { title: '来源对象', dataIndex: 'sourceId', ellipsis: true },
                      { title: '内容哈希', dataIndex: 'contentHash', ellipsis: true },
                    ]}
                  />

                  <Divider titlePlacement="start" plain>
                    解析后的建议与逐段 citations
                  </Divider>
                  {(aiGenerationDetail.data.data.parsedOutput?.fields ?? []).map((field) => (
                    <Card key={field.field} size="small" title={weeklyFieldLabel(field.field)}>
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        {field.paragraphs.map((paragraph, index) => (
                          <div key={`${field.field}-${index}`}>
                            {paragraph.projectName && (
                              <Tag color="geekblue">{paragraph.projectName}</Tag>
                            )}
                            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                              {paragraph.text}
                            </Typography.Paragraph>
                            <Space wrap>
                              <Typography.Text type="secondary">依据：</Typography.Text>
                              {paragraph.citations.map((citation) => (
                                <Tag key={citation}>{citation}</Tag>
                              ))}
                            </Space>
                          </div>
                        ))}
                      </Space>
                    </Card>
                  ))}

                  <Collapse
                    items={[
                      {
                        key: 'raw-output',
                        label: '供应商原始输出（始终按纯文本显示）',
                        children: (
                          // React 会转义该字符串；这里绝不使用 dangerouslySetInnerHTML 或 Markdown 执行器。
                          <pre className="weekly-diff-text">
                            {aiGenerationDetail.data.data.rawOutput ?? '本次没有供应商原始输出'}
                          </pre>
                        ),
                      },
                    ]}
                  />
                </Space>
              )}
            </Card>
          )}
        </Space>
      </Drawer>

      <Drawer
        title="不可变版本历史"
        width={760}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
      >
        <Timeline
          items={(versions.data?.data ?? []).map((item) => ({
            color: item.id === version?.id ? 'blue' : 'gray',
            children: (
              <Card size="small">
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space wrap>
                    <Typography.Text strong>v{item.versionNo}</Typography.Text>
                    <Tag>{originLabels[item.origin] ?? item.origin}</Tag>
                    {item.id === version?.id && <Tag color="blue">当前</Tag>}
                    <Typography.Text type="secondary">
                      {formatDateTime(item.createdAt)}
                    </Typography.Text>
                  </Space>
                  <Typography.Text type="secondary">
                    {changeSummaryText(item.changeSummary)}
                  </Typography.Text>
                  <Space>
                    <Button
                      size="small"
                      icon={<DiffOutlined />}
                      disabled={item.id === version?.id}
                      onClick={() => setCompareVersionId(item.id)}
                    >
                      与当前比较
                    </Button>
                    <Button
                      size="small"
                      disabled={item.id === version?.id}
                      onClick={() =>
                        restoreVersion(item.id, `从历史 v${item.versionNo} 恢复`, 'history')
                      }
                    >
                      恢复为新版本
                    </Button>
                  </Space>
                </Space>
              </Card>
            ),
          }))}
        />
      </Drawer>

      <Drawer
        title={`字段比较${comparedVersion.data?.data ? `：v${comparedVersion.data.data.versionNo} → 当前 v${version?.versionNo}` : ''}`}
        width={980}
        open={Boolean(compareVersionId)}
        onClose={() => setCompareVersionId(null)}
      >
        <Table
          rowKey="field"
          loading={comparedVersion.isLoading}
          dataSource={differences}
          pagination={false}
          columns={[
            {
              title: '字段',
              dataIndex: 'label',
              width: 120,
              render: (label: string, row) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>{label}</Typography.Text>
                  <Tag color={row.changed ? 'gold' : 'default'}>
                    {row.changed ? '已变化' : '未变化'}
                  </Tag>
                </Space>
              ),
            },
            {
              title: '历史版本',
              dataIndex: 'before',
              render: (value: string) => (
                <pre className="weekly-diff-text">{value || '（空）'}</pre>
              ),
            },
            {
              title: '当前版本',
              dataIndex: 'after',
              render: (value: string) => (
                <pre className="weekly-diff-text">{value || '（空）'}</pre>
              ),
            },
          ]}
        />
      </Drawer>
    </Space>
  );
}

function weeklyFieldLabel(field: string): string {
  return weeklyReportFields.find((item) => item.key === field)?.label ?? field;
}

function aiGenerationStatusLabel(status: WeeklyAiGeneration['status']): string {
  return {
    succeeded: '输出已校验',
    failed: '已失败并回退',
    blocked: '本地安全阻断',
  }[status];
}

function aiGenerationStatusColor(status: WeeklyAiGeneration['status']): string {
  return { succeeded: 'green', failed: 'red', blocked: 'orange' }[status];
}

function aiDecisionLabel(status: WeeklyAiGeneration['adoptionStatus']): string {
  return {
    pending: '待人工决定',
    adopted: '已采纳',
    rejected: '已拒绝',
    not_applicable: '未产生建议',
  }[status];
}

function aiDecisionColor(status: WeeklyAiGeneration['adoptionStatus']): string {
  return { pending: 'gold', adopted: 'blue', rejected: 'default', not_applicable: 'default' }[
    status
  ];
}

function editorFields(values: EditorValues): WeeklyReportVersion['fields'] {
  return {
    reportDate: values.reportDate.format('YYYY-MM-DD'),
    recentGoals: values.recentGoals ?? '',
    weeklyWork: values.weeklyWork ?? '',
    nextWeekPlans: values.nextWeekPlans ?? '',
    problems: values.problems ?? '',
    other: values.other ?? '',
  };
}

function sameWeeklyFields(
  left: WeeklyReportVersion['fields'],
  right: WeeklyReportVersion['fields'],
): boolean {
  return weeklyReportFields.every((field) => left[field.key] === right[field.key]);
}

function idempotencyKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // 兼容禁用 Clipboard API 的受限浏览器；临时文本框只存在于本次用户点击期间。
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    try {
      return document.execCommand('copy');
    } finally {
      textarea.remove();
    }
  }
}

function downloadBase64Attachment(attachment: WeeklyReportExportCopy['attachment']): void {
  const binary = atob(attachment.contentBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: attachment.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = attachment.fileName;
  anchor.click();
  // 下载启动后再回收对象 URL，避免长期保留完整周报正文的浏览器内存副本。
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function statusLabel(status: WeeklyReport['status']): string {
  return {
    collecting: '采集中',
    generated: '已生成',
    editing: '编辑中',
    confirmed: '已保存',
  }[status];
}

function deliveryStatusLabel(status: string): string {
  return (
    {
      not_started: '未开始',
      submitting: '排队提交',
      pending: '待执行',
      queued: '已排队',
      running: '执行中',
      sending: '发送中',
      submitted: '正式日志已提交',
      notified: '群摘要已发送',
      succeeded: '成功',
      failed: '失败',
      unknown: '结果未知',
      needs_review: '待人工复核',
      skipped: '已跳过',
      cancelled: '已取消',
    }[status] ?? status
  );
}

function deliveryStatusColor(status: string): string {
  if (['submitted', 'notified', 'succeeded'].includes(status)) return 'green';
  if (['submitting', 'pending', 'queued', 'running', 'sending'].includes(status))
    return 'processing';
  if (['unknown', 'needs_review'].includes(status)) return 'orange';
  if (status === 'failed') return 'red';
  return 'default';
}

function directSubmitStageLabel(stage: DirectSubmitStage): string {
  return {
    idle: '自动填写并提交到钉钉',
    saving_content: '正在保存正文…',
    saving_settings: '正在保存提交设置…',
    preparing: '正在准备钉钉提交…',
    queuing: '正在启动自动提交…',
  }[stage];
}

function deliveryAutomationTitle(intent: WeeklyReportDeliveryIntent): string {
  if (intent.status === 'pending') return '已启动自动提交，等待钉钉桌面执行';
  if (intent.status === 'running') return '正在操作钉钉并填写周报';
  if (intent.status === 'succeeded') return '钉钉周报提交成功';
  if (intent.status === 'failed') {
    return `自动提交失败：${desktopAutomationFailureStage(intent.lastErrorCode)}`;
  }
  if (intent.status === 'unknown' || intent.status === 'needs_review') {
    return '钉钉已执行提交动作，但结果需要人工核对';
  }
  return `自动提交流程${deliveryStatusLabel(intent.status)}`;
}

function deliveryAutomationDescription(intent: WeeklyReportDeliveryIntent): string {
  const route = '执行路径：工作台 → My 下的 Report → Create → 指定模板 → 填写六字段 → 提交。';
  if (intent.status === 'failed') {
    const detail = intent.lastErrorSummary ?? intent.lastErrorCode ?? '未返回详细错误';
    return `${detail}。修复问题后可点击“重新自动提交到钉钉”。${route}`;
  }
  if (intent.status === 'unknown' || intent.status === 'needs_review') {
    return '为避免重复周报，系统不会自动重试。请先在钉钉“我发出的”中核对结果。';
  }
  if (intent.status === 'succeeded') {
    return `已取得桌面提交回执：${intent.externalId ?? '本地回执已记录'}`;
  }
  return route;
}

function desktopAutomationFailureStage(errorCode: string | null): string {
  if (!errorCode) return '未知步骤';
  if (errorCode.includes('WORKPLACE')) return '未找到工作台';
  if (errorCode.includes('MY_SECTION')) return '未找到 My 应用区';
  if (errorCode.includes('REPORT_APP')) return '未找到 My 下的 Report';
  if (errorCode.includes('CREATE')) return '未找到 Create';
  if (errorCode.includes('TEMPLATE')) return '未找到指定模板';
  if (errorCode.includes('FORM')) return '未进入模板填写页';
  if (errorCode.includes('FIELD') || errorCode.includes('INPUT')) return '填写六字段';
  if (errorCode.includes('RECIPIENT')) return '校验接收范围';
  if (errorCode.includes('SUBMIT')) return '点击或确认提交';
  return errorCode;
}

function submissionLogColor(status: SubmissionOperationLog['status']): string {
  return {
    waiting: 'gray',
    running: 'blue',
    success: 'green',
    error: 'red',
  }[status];
}

function notificationTypeLabel(type: WeeklyReportRobotNotification['notificationType']): string {
  return {
    generation_reminder: '生成提醒',
    confirmation_reminder: '确认提醒',
    deadline_reminder: '截止提醒',
    test_report: '周报测试发送',
    submission_success: '提交成功摘要',
    submission_failure: '提交失败提醒',
    risk_alert: '严重风险提醒',
  }[type];
}

function formatDateTime(value: string | null | undefined): string {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '—';
}

function fieldLabel(field: string): string {
  return weeklyReportFields.find((item) => item.key === field)?.label ?? field;
}

function sourceColor(sourceType: string): string {
  return sourceType === 'task' ? 'blue' : sourceType === 'evidence' ? 'purple' : 'green';
}

function sourceTitle(summary: Record<string, unknown>): string {
  return safeText(summary.title, safeText(summary.text, safeText(summary.issueKey, '来源事实')));
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : fallback;
}

function robotGroupLabel(connection: Integration): string {
  const groupId = safeText(connection.config.groupId, '未标注群聊');
  const robotName = safeText(connection.config.robotName, connection.name);
  return robotName === connection.name
    ? `${connection.name} · 群标识 ${groupId}`
    : `${connection.name} · ${robotName} · 群标识 ${groupId}`;
}

function warningText(warning: Record<string, unknown>): string {
  if (typeof warning.message === 'string') return warning.message;
  const refs = Array.isArray(warning.sourceRefs) ? warning.sourceRefs.length : 0;
  return refs > 0 ? `涉及 ${refs} 个来源事实` : '请核对该风险后再处理';
}

function changeSummaryText(summary: Record<string, unknown> | undefined): string {
  if (!summary) return '无变更摘要';
  if (typeof summary.reason === 'string') return summary.reason;
  if (typeof summary.kind === 'string') return summary.kind;
  return '已记录结构化变更摘要';
}

function AutosaveTag({
  state,
}: {
  state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';
}) {
  const view = {
    idle: { color: 'default', icon: <CloudSyncOutlined />, text: '未修改' },
    dirty: { color: 'gold', icon: <CloudSyncOutlined />, text: '等待自动保存' },
    saving: { color: 'processing', icon: <CloudSyncOutlined spin />, text: '保存中' },
    saved: { color: 'success', icon: <CheckCircleOutlined />, text: '已保存为版本' },
    error: { color: 'error', icon: <ExclamationCircleOutlined />, text: '保存失败' },
    conflict: { color: 'error', icon: <ExclamationCircleOutlined />, text: '版本冲突' },
  }[state];
  return (
    <Tag color={view.color} icon={view.icon}>
      {view.text}
    </Tag>
  );
}
