import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  DiffOutlined,
  ExclamationCircleOutlined,
  FileAddOutlined,
  HistoryOutlined,
  PaperClipOutlined,
  RedoOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
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
  Upload,
  message,
} from 'antd';
import type { UploadProps } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiClientError, apiRequest } from '../api/client.js';
import type {
  DingTalkRecipientValidation,
  DingTalkTemplateMappingHistory,
  Integration,
  WeeklyReport,
  WeeklyAiGeneration,
  WeeklyAiGenerationList,
  WeeklyAiSuggestionResult,
  WeeklyReportAttachment,
  WeeklyReportList,
  WeeklyReportVersion,
  WeeklyReportVersionSummary,
} from '../api/types.js';
import { StatusTag } from '../components/StatusTag.js';
import {
  compareWeeklyFields,
  confirmationGate,
  previousVersionId,
  reportWorkflowStep,
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

const workflowItems = [
  { title: '采集数据' },
  { title: '生成周报' },
  { title: '编辑完善' },
  { title: '确认锁定' },
  { title: '正式提交' },
  { title: '通知完成' },
];

const originLabels: Record<string, string> = {
  rule: '规则生成',
  manual: '人工编辑',
  restore: '历史恢复',
  ai: 'AI 建议',
};

export function WeeklyReportsPage() {
  const queryClient = useQueryClient();
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
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [selectedAiGenerationId, setSelectedAiGenerationId] = useState<string | null>(null);
  const [compareVersionId, setCompareVersionId] = useState<string | null>(null);
  const [acknowledgedWarningIds, setAcknowledgedWarningIds] = useState<string[]>([]);
  const [selectedMappingId, setSelectedMappingId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>([]);
  const [selectedSchedule, setSelectedSchedule] = useState<Dayjs | null>(null);
  const [dirty, setDirty] = useState(false);
  const [autosaveState, setAutosaveState] = useState<
    'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'
  >('idle');
  const [confirmedEditingUnlocked, setConfirmedEditingUnlocked] = useState(false);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reports = useQuery({
    queryKey: ['weekly-reports'],
    queryFn: () => apiRequest<WeeklyReportList>('/api/v1/weekly-reports?limit=100'),
    refetchInterval: 30_000,
  });
  const reportItems = reports.data?.data.items ?? [];

  useEffect(() => {
    if (!selectedReportId && reportItems[0]) setSelectedReportId(reportItems[0].id);
    if (
      selectedReportId &&
      reportItems.length > 0 &&
      !reportItems.some((report) => report.id === selectedReportId)
    ) {
      setSelectedReportId(reportItems[0]?.id ?? null);
    }
  }, [reportItems, selectedReportId]);

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
  const attachments = useQuery({
    queryKey: ['weekly-report-attachments', selectedReportId],
    queryFn: () => {
      if (!selectedReportId) throw new Error('尚未选择周报');
      return apiRequest<WeeklyReportAttachment[]>(
        `/api/v1/weekly-reports/${selectedReportId}/attachments`,
      );
    },
    enabled: Boolean(selectedReportId),
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
      (integrations.data?.data ?? []).filter((connection) => connection.type === 'dingtalk_log'),
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
  const mappingHistories = mappingQueries.flatMap((query) => (query.data ? [query.data.data] : []));
  const currentMappings = mappingHistories.flatMap((history) =>
    history.versions.filter((mapping) => mapping.id === history.currentVersionId),
  );
  const recipients = useQuery({
    queryKey: ['dingtalk-recipients', selectedConnectionId],
    queryFn: () => {
      if (!selectedConnectionId) throw new Error('尚未选择钉钉连接');
      return apiRequest<DingTalkRecipientValidation[]>(
        `/api/v1/integrations/${selectedConnectionId}/dingtalk/recipients`,
      );
    },
    enabled: Boolean(selectedConnectionId),
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
    ]);
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
      setDirty(false);
      setAutosaveState('saved');
      await invalidateReport(action.reportId);
      if (!response.data.replayed) {
        void messageApi.success(
          action.source === 'autosave'
            ? `已自动保存为 v${response.data.version.versionNo}`
            : `已创建 v${response.data.version.versionNo}`,
        );
      }
    },
    onError: (error: Error) => {
      setAutosaveState(
        error instanceof ApiClientError && error.status === 409 ? 'conflict' : 'error',
      );
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
      setAcknowledgedWarningIds([]);
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
    onSuccess: async (response) => {
      setConfirmOpen(false);
      setConfirmedEditingUnlocked(false);
      await invalidateReport(response.data.report.id);
      void messageApi.success('当前版本已锁定确认；后续编辑会生成新版本并使本次确认失效');
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

  const aiSuggestionMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      baseVersionId: string;
      reportVersion: number;
      values: AiSuggestionFormValues;
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
    onSuccess: async (response) => {
      setSelectedAiGenerationId(response.data.generation.id);
      if (response.data.report) await invalidateReport(response.data.report.id);
      else if (response.data.generation.reportId) {
        await invalidateReport(response.data.generation.reportId);
      }
      if (response.data.fallback) {
        void messageApi.warning(
          `AI 未改变正文，已回退当前版本：${response.data.fallbackReasonCode ?? '未知原因'}`,
        );
      } else {
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
    onSuccess: async (response) => {
      if (response.data.report) await invalidateReport(response.data.report.id);
      setSelectedAiGenerationId(response.data.generation.id);
      void messageApi.success(
        `已人工采纳为 v${response.data.adoptedVersion?.versionNo ?? '—'}；AI 原建议仍完整保留`,
      );
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

  useEffect(() => {
    const healthy = aiConnections.find((connection) => connection.status === 'healthy');
    if (!aiForm.getFieldValue('providerConnectionId') && healthy) {
      aiForm.setFieldsValue({ providerConnectionId: healthy.id });
    }
  }, [aiConnections, aiForm]);

  useEffect(() => {
    setSelectedAiGenerationId(null);
  }, [selectedReportId]);

  useEffect(() => {
    if (!version) return;
    form.setFieldsValue({
      reportDate: dayjs(version.fields.reportDate),
      recentGoals: version.fields.recentGoals,
      weeklyWork: version.fields.weeklyWork,
      nextWeekPlans: version.fields.nextWeekPlans,
      problems: version.fields.problems,
      other: version.fields.other,
    });
    setSelectedMappingId(version.templateMappingVersionId);
    const mappingConnection = currentMappings.find(
      (mapping) => mapping.id === version.templateMappingVersionId,
    )?.connectionId;
    setSelectedConnectionId(version.recipientScope.connectionId ?? mappingConnection ?? null);
    setSelectedRecipientIds(
      (version.recipientScope.recipients ?? []).map((recipient) => recipient.validationId),
    );
    setSelectedSchedule(version.scheduleAt ? dayjs(version.scheduleAt) : null);
    setAcknowledgedWarningIds([]);
    setDirty(false);
    setAutosaveState('idle');
  }, [form, version?.id]);

  useEffect(() => {
    if (!dirty || !report || !version || editMutation.isPending) return;
    if (report.status === 'confirmed' && !confirmedEditingUnlocked) return;
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
  }, [dirty, report, version, editMutation.isPending, confirmedEditingUnlocked, form]);

  const gate =
    report && version
      ? confirmationGate({
          report,
          version,
          mapping:
            currentMappings.find((mapping) => mapping.id === version.templateMappingVersionId) ??
            null,
          acknowledgedWarningIds,
          availableAttachmentIds: (attachments.data?.data ?? [])
            .filter((attachment) => attachment.status === 'available')
            .map((attachment) => attachment.id),
        })
      : { ready: false, items: [] };
  const readOnly = Boolean(report?.status === 'confirmed' && !confirmedEditingUnlocked);
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

  const saveMetadata = () => {
    if (!report || !version) return;
    editMutation.mutate({
      reportId: report.id,
      baseVersionId: version.id,
      reportVersion: report.version,
      attachmentIds: version.attachments.map((attachment) => attachment.id),
      recipientValidationIds: selectedRecipientIds,
      templateMappingVersionId: selectedMappingId,
      scheduleAt: selectedSchedule?.toISOString() ?? null,
      changeReason: '保存：模板映射、接收范围和计划提交时间',
      source: 'metadata',
    });
  };

  const uploadProps: UploadProps = {
    showUploadList: false,
    accept: '.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.txt',
    disabled: !report || !version || readOnly || editMutation.isPending,
    customRequest: (options) => {
      void (async () => {
        if (!report || !version || !(options.file instanceof File)) return;
        const formData = new FormData();
        formData.append('file', options.file);
        let uploadedAttachmentId: string | null = null;
        try {
          const uploaded = await apiRequest<WeeklyReportAttachment>(
            `/api/v1/weekly-reports/${report.id}/attachments`,
            { method: 'POST', body: formData },
          );
          uploadedAttachmentId = uploaded.data.id;
          await editMutation.mutateAsync({
            reportId: report.id,
            baseVersionId: version.id,
            reportVersion: report.version,
            attachmentIds: [
              ...version.attachments.map((attachment) => attachment.id),
              uploaded.data.id,
            ],
            changeReason: `添加附件：${uploaded.data.originalName}`,
            source: 'attachment',
          });
          options.onSuccess?.(uploaded.data);
        } catch (error) {
          // 文件事实已创建但版本保存失败时主动回收，避免产生无人引用的可用附件。
          if (uploadedAttachmentId) {
            await apiRequest(
              `/api/v1/weekly-reports/${report.id}/attachments/${uploadedAttachmentId}`,
              { method: 'DELETE' },
            ).catch(() => undefined);
          }
          options.onError?.(error instanceof Error ? error : new Error('附件上传失败'));
        }
      })();
    },
  };

  const removeAttachment = async (attachmentId: string) => {
    if (!report || !version) return;
    try {
      const saved = await editMutation.mutateAsync({
        reportId: report.id,
        baseVersionId: version.id,
        reportVersion: report.version,
        attachmentIds: version.attachments
          .filter((attachment) => attachment.id !== attachmentId)
          .map((attachment) => attachment.id),
        changeReason: '从当前版本移除附件',
        source: 'attachment',
      });
      await apiRequest(`/api/v1/weekly-reports/${report.id}/attachments/${attachmentId}`, {
        method: 'DELETE',
      });
      await invalidateReport(saved.data.report.id);
      void messageApi.success('附件已从新版本解除引用并标记删除');
    } catch (error) {
      void messageApi.error(error instanceof Error ? error.message : '移除附件失败');
    }
  };

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

  return (
    <Space direction="vertical" size={20} className="page-stack weekly-report-page">
      {holder}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>六字段周报工作台</Typography.Title>
          <Typography.Text type="secondary">
            规则先生成、来源可追溯、每次编辑留版本；确认只锁定当前版本，不代表已经提交到钉钉。
          </Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void reports.refetch()}>
            刷新
          </Button>
          <Button type="primary" icon={<FileAddOutlined />} onClick={() => setGenerateOpen(true)}>
            生成本周周报
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        message="确认与正式提交严格分离"
        description="本页面只完成可追溯编辑与确认锁定。钉钉模板、收件人和附件必须来自已验证事实；日志正式提交与机器人通知将在独立交付步骤执行。"
      />

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
                setConfirmedEditingUnlocked(false);
              }}
              options={reportItems.map((item) => ({
                value: item.id,
                label: `${item.periodStart} 至 ${item.periodEnd} · ${statusLabel(item.status)} · ${item.versionCount ?? 0} 版`,
              }))}
            />
            {report && <StatusTag status={report.status} />}
            {version && (
              <Tag color="blue">
                v{version.versionNo} · {originLabels[version.origin] ?? version.origin}
              </Tag>
            )}
          </Space>
          {report && (
            <Typography.Text type="secondary">
              聚合版本 {report.version} · 更新 {formatDateTime(report.updatedAt)}
            </Typography.Text>
          )}
        </Space>
      </Card>

      {!selectedReportId && !reports.isLoading ? (
        <Card>
          <Empty
            description="尚无周报。先生成确定性规则版本，再进入编辑与确认。"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          >
            <Button type="primary" onClick={() => setGenerateOpen(true)}>
              生成本周周报
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
              current={reportWorkflowStep(report)}
              items={workflowItems}
              status={report.logDeliveryState === 'failed' ? 'error' : 'process'}
            />
          </Card>

          {report.status === 'confirmed' && (
            <Alert
              type="success"
              showIcon
              message={`v${version.versionNo} 已确认锁定`}
              description={
                confirmedEditingUnlocked
                  ? '已进入“开始新版本编辑”模式；首次保存会使旧确认失效并保留完整历史。'
                  : `确认时间 ${formatDateTime(report.currentConfirmation?.confirmedAt)}。正文保持只读；如需修改，必须明确开始新版本。`
              }
              action={
                !confirmedEditingUnlocked ? (
                  <Button
                    onClick={() =>
                      Modal.confirm({
                        title: '开始新版本编辑？',
                        icon: <ExclamationCircleOutlined />,
                        content:
                          '旧确认不会删除，但首次保存新版本后会标记为失效，正式提交必须重新确认。',
                        okText: '开始新版本',
                        cancelText: '保持锁定',
                        onOk: () => setConfirmedEditingUnlocked(true),
                      })
                    }
                  >
                    开始新版本编辑
                  </Button>
                ) : undefined
              }
            />
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

          <div className="weekly-workbench-grid">
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Card
                title="六字段正文"
                extra={
                  <Space wrap>
                    <AutosaveTag state={autosaveState} />
                    <Tooltip title={previousId ? '恢复上一历史版本并创建新版本' : '没有更早版本'}>
                      <Button
                        icon={<UndoOutlined />}
                        disabled={!previousId || restoreMutation.isPending || readOnly}
                        onClick={() =>
                          previousId && restoreVersion(previousId, '撤销：恢复上一历史版本', 'undo')
                        }
                      >
                        撤销
                      </Button>
                    </Tooltip>
                    <Button
                      icon={<RedoOutlined />}
                      disabled={redoStack.length === 0 || restoreMutation.isPending || readOnly}
                      onClick={() => {
                        const target = redoStack.at(-1);
                        if (target) restoreVersion(target, '重做：恢复撤销前版本', 'redo');
                      }}
                    >
                      重做
                    </Button>
                    <Button icon={<RobotOutlined />} onClick={() => setAiOpen(true)}>
                      AI 建议与依据
                    </Button>
                    <Button icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>
                      历史
                    </Button>
                    <Button
                      type="primary"
                      icon={<SaveOutlined />}
                      disabled={!dirty || readOnly}
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
                  disabled={readOnly || editMutation.isPending}
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
                      rules={[{ required: true, message: `${definition.label}不能为空` }]}
                      extra={
                        definition.key === 'problems'
                          ? '没有问题时请明确填写“暂无”，不能留空。'
                          : undefined
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

              <Card
                title="提交元数据"
                extra={
                  <Button
                    icon={<SaveOutlined />}
                    disabled={readOnly}
                    loading={editMutation.isPending}
                    onClick={saveMetadata}
                  >
                    保存为新版本
                  </Button>
                }
              >
                <div className="weekly-metadata-grid">
                  <div>
                    <Typography.Text strong>钉钉模板映射</Typography.Text>
                    <Select
                      allowClear
                      value={selectedMappingId ?? undefined}
                      disabled={readOnly}
                      placeholder="选择当前有效映射"
                      style={{ width: '100%', marginTop: 8 }}
                      onChange={(mappingId: string | undefined) => {
                        const mapping = currentMappings.find((item) => item.id === mappingId);
                        setSelectedMappingId(mappingId ?? null);
                        setSelectedConnectionId(mapping?.connectionId ?? null);
                        setSelectedRecipientIds([]);
                      }}
                      options={currentMappings.map((mapping) => ({
                        value: mapping.id,
                        disabled: mapping.expired,
                        label: `${mapping.templateName} · v${mapping.versionNo}${mapping.expired ? '（已过期）' : ''}`,
                      }))}
                    />
                    {currentMappings.length === 0 && (
                      <Typography.Paragraph type="warning" style={{ marginTop: 8 }}>
                        没有真实探测并保存的模板映射；确认会保持阻断。
                      </Typography.Paragraph>
                    )}
                  </div>
                  <div>
                    <Typography.Text strong>已验证接收范围</Typography.Text>
                    <Select
                      mode="multiple"
                      value={selectedRecipientIds}
                      disabled={readOnly || !selectedConnectionId}
                      loading={recipients.isLoading}
                      placeholder="选择用户、部门或群组"
                      style={{ width: '100%', marginTop: 8 }}
                      onChange={setSelectedRecipientIds}
                      options={(recipients.data?.data ?? []).map((recipient) => ({
                        value: recipient.id,
                        disabled: !recipient.available || recipient.expired,
                        label: `${recipient.displayName} · ${recipient.subjectType}${recipient.expired ? '（已过期）' : ''}`,
                      }))}
                    />
                  </div>
                  <div>
                    <Typography.Text strong>计划提交时间</Typography.Text>
                    <DatePicker
                      showTime
                      allowClear
                      value={selectedSchedule}
                      disabled={readOnly}
                      onChange={setSelectedSchedule}
                      placeholder="留空表示确认后立即提交"
                      style={{ width: '100%', marginTop: 8 }}
                    />
                  </div>
                  <div>
                    <Typography.Text strong>附件</Typography.Text>
                    <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
                      {version.attachments.map((attachment) => (
                        <div className="weekly-attachment-row" key={attachment.id}>
                          <Space>
                            <PaperClipOutlined />
                            <Typography.Text>{attachment.originalName}</Typography.Text>
                            <Typography.Text type="secondary">
                              {formatBytes(attachment.sizeBytes)}
                            </Typography.Text>
                          </Space>
                          <Button
                            danger
                            size="small"
                            disabled={readOnly || editMutation.isPending}
                            onClick={() => void removeAttachment(attachment.id)}
                          >
                            移除
                          </Button>
                        </div>
                      ))}
                      <Upload {...uploadProps}>
                        <Button
                          icon={<PaperClipOutlined />}
                          disabled={Boolean(uploadProps.disabled)}
                        >
                          上传并加入新版本
                        </Button>
                      </Upload>
                      <Typography.Text type="secondary">
                        PDF/DOCX/XLSX/PNG/JPEG/TXT，最大 8 MiB；确认时会重新校验磁盘哈希。
                      </Typography.Text>
                    </Space>
                  </div>
                </div>
              </Card>

              <Card
                title="确认预检"
                extra={
                  <Button
                    type="primary"
                    icon={<CheckCircleOutlined />}
                    onClick={() => setConfirmOpen(true)}
                  >
                    打开只读确认预览
                  </Button>
                }
              >
                <div className="weekly-gate-grid">
                  {gate.items.map((item) => (
                    <div
                      className={item.passed ? 'weekly-gate passed' : 'weekly-gate blocked'}
                      key={item.key}
                    >
                      <Typography.Text strong>{item.label}</Typography.Text>
                      <StatusTag status={item.passed ? 'ready' : 'blocked'} />
                      <Typography.Text type="secondary">{item.detail}</Typography.Text>
                    </div>
                  ))}
                </div>
              </Card>
            </Space>

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
                                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
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
          </div>
        </>
      ) : (
        <Card loading />
      )}

      <Modal
        title="生成确定性周报版本"
        open={generateOpen}
        confirmLoading={generateMutation.isPending}
        okText="采集快照并生成"
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
            freshnessMode: 'require_fresh',
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
          <Form.Item name="freshnessMode" label="来源新鲜度策略">
            <Select
              options={[
                { value: 'require_fresh', label: '严格：过期或不可用即阻断生成' },
                { value: 'allow_stale', label: '显式允许旧来源，并写入 warning' },
              ]}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(
              before: Partial<{ freshnessMode: string }>,
              after: Partial<{ freshnessMode: string }>,
            ) => before.freshnessMode !== after.freshnessMode}
          >
            {({ getFieldValue }) =>
              getFieldValue('freshnessMode') === 'allow_stale' ? (
                <Alert
                  type="warning"
                  showIcon
                  message="旧来源会固定到本次不可变快照，确认前必须逐项知悉 warning。"
                  style={{ marginBottom: 16 }}
                />
              ) : null
            }
          </Form.Item>
          <Form.Item name="includeUnconfirmedEvidence" valuePropName="checked">
            <Checkbox>
              把待确认证据纳入快照候选（不会自动绑定任务，也不会直接写入确定性正文）
            </Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="只读确认预览"
        open={confirmOpen}
        width={1080}
        okText="锁定当前版本"
        cancelText="返回编辑"
        okButtonProps={{ disabled: !gate.ready }}
        confirmLoading={confirmMutation.isPending}
        onCancel={() => setConfirmOpen(false)}
        onOk={() => {
          if (!report || !version || !version.templateMappingVersionId || !gate.ready) return;
          confirmMutation.mutate({
            reportId: report.id,
            versionId: version.id,
            reportVersion: report.version,
            templateMappingVersionId: version.templateMappingVersionId,
            acknowledgedWarningIds,
          });
        }}
      >
        {report && version && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message={`将锁定 v${version.versionNo} · ${version.contentHash.slice(0, 16)}…`}
              description="确认仅表示内容、附件、模板和收件范围已经人工核对；不会在此步骤调用钉钉。"
            />
            <div className="weekly-gate-grid">
              {gate.items.map((item) => (
                <div
                  className={item.passed ? 'weekly-gate passed' : 'weekly-gate blocked'}
                  key={item.key}
                >
                  <Typography.Text strong>{item.label}</Typography.Text>
                  <StatusTag status={item.passed ? 'ready' : 'blocked'} />
                  <Typography.Text type="secondary">{item.detail}</Typography.Text>
                </div>
              ))}
            </div>
            <Divider titlePlacement="start">六字段正文</Divider>
            <Descriptions bordered column={1} size="small">
              {weeklyReportFields.map((field) => (
                <Descriptions.Item key={field.key} label={field.label}>
                  <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                    {version.fields[field.key] || '（空）'}
                  </Typography.Paragraph>
                </Descriptions.Item>
              ))}
            </Descriptions>
            <Divider titlePlacement="start">Warning 逐项知悉</Divider>
            {version.warnings.length === 0 ? (
              <Alert type="success" showIcon message="当前版本没有 warning" />
            ) : (
              <Checkbox.Group
                value={acknowledgedWarningIds}
                onChange={(values) => setAcknowledgedWarningIds(values)}
                style={{ width: '100%' }}
              >
                <Space direction="vertical" style={{ width: '100%' }}>
                  {version.warnings.map((warning) => (
                    <Card size="small" key={warning.id}>
                      <Checkbox value={warning.id} disabled={warning.blocking}>
                        <Space wrap>
                          <Tag color={warning.blocking ? 'red' : 'gold'}>{warning.code}</Tag>
                          <Typography.Text>
                            {warning.message ?? warningText(warning)}
                          </Typography.Text>
                        </Space>
                      </Checkbox>
                    </Card>
                  ))}
                </Space>
              </Checkbox.Group>
            )}
          </Space>
        )}
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
            message="规则版本始终是回退基线，AI 只能生成独立建议"
            description="模型只接收冻结快照重新构造的白名单元数据。源码、diff、环境变量、凭证和附件正文没有发送路径；失败、拒绝、安全拦截或事实校验不通过时，当前规则/人工正文保持不变。"
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
              <Alert
                type="warning"
                showIcon
                message="秘密扫描优先于凭证读取和外部请求"
                description="命中私钥、Authorization、token、连接串、凭证赋值、源码、diff 或客户高敏标记时会本地阻断；记录和页面只显示类别，不显示命中原文。"
                style={{ marginTop: 16, marginBottom: 16 }}
              />
              <Button
                type="primary"
                htmlType="submit"
                icon={<RobotOutlined />}
                loading={aiSuggestionMutation.isPending}
                disabled={
                  !report || !version || aiConnections.every((item) => item.status !== 'healthy')
                }
              >
                从当前冻结版本生成独立建议
              </Button>
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
                      disabled={item.id === version?.id || readOnly}
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

function idempotencyKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function statusLabel(status: WeeklyReport['status']): string {
  return {
    collecting: '采集中',
    generated: '已生成',
    editing: '编辑中',
    confirmed: '已确认',
  }[status];
}

function formatDateTime(value: string | null | undefined): string {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '—';
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
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

function warningText(warning: Record<string, unknown>): string {
  if (typeof warning.message === 'string') return warning.message;
  const refs = Array.isArray(warning.sourceRefs) ? warning.sourceRefs.length : 0;
  return refs > 0 ? `涉及 ${refs} 个来源事实` : '请核对该风险后再确认';
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
