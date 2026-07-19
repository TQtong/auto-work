import {
  CheckCircleOutlined,
  EditOutlined,
  FileExcelOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import type { UploadFile } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../api/client.js';
import type {
  ExcelCommitResult,
  ExcelDiagnostic,
  ExcelDiagnosticSeverity,
  ExcelImportDetail,
  ExcelImportRow,
  ExcelImportSummary,
} from '../api/types.js';
import { actionLabel, diagnosticColor, filterExcelRows } from './excel-import-view-model.js';

interface ExcelImportModalProps {
  open: boolean;
  onClose: () => void;
}

interface ResolutionFormValue {
  action: 'create_excel' | 'link_jira' | 'skip';
  matchedTaskId?: string;
  parentIssueKey?: string | null;
  parentTitle?: string | null;
  title?: string | null;
  assigneeName?: string | null;
  plannedStartDate?: string | null;
  dueDate?: string | null;
  estimateHours?: number | null;
}

export function ExcelImportModal({ open, onClose }: ExcelImportModalProps) {
  const queryClient = useQueryClient();
  const [messageApi, holder] = message.useMessage();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [severity, setSeverity] = useState<ExcelDiagnosticSeverity>();
  const [sheetName, setSheetName] = useState<string>();
  const [action, setAction] = useState<ExcelImportRow['proposedAction']>();
  const [editingRow, setEditingRow] = useState<ExcelImportRow | null>(null);
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState(false);
  // 修正会产生新的预检版本，必须同时更换幂等键，避免把旧版本的提交响应错误重放到新版本。
  const [commitKey, setCommitKey] = useState(createCommitKey);

  const imports = useQuery({
    queryKey: ['excel-imports'],
    queryFn: () => apiRequest<ExcelImportSummary[]>('/api/v1/excel-imports'),
    enabled: open,
  });
  useEffect(() => {
    if (!selectedId && imports.data?.data[0]) setSelectedId(imports.data.data[0].id);
  }, [imports.data, selectedId]);
  const detail = useQuery({
    queryKey: ['excel-import-detail', selectedId],
    queryFn: () => {
      if (!selectedId) throw new Error('未选择 Excel 预检');
      return apiRequest<ExcelImportDetail>(`/api/v1/excel-imports/${selectedId}`);
    },
    enabled: open && Boolean(selectedId),
  });
  const current = detail.data?.data;

  const upload = useMutation({
    mutationFn: async () => {
      const file = fileList[0]?.originFileObj;
      if (!file) throw new Error('请先选择一个 XLSX 文件');
      const body = new FormData();
      body.append('file', file, file.name);
      return apiRequest<{ import: ExcelImportSummary; replayed: boolean }>(
        '/api/v1/excel-imports/preview',
        { method: 'POST', body },
      );
    },
    onSuccess: async (response) => {
      setSelectedId(response.data.import.id);
      setFileList([]);
      setAcknowledgedWarnings(false);
      setCommitKey(createCommitKey());
      await queryClient.invalidateQueries({ queryKey: ['excel-imports'] });
      await queryClient.invalidateQueries({
        queryKey: ['excel-import-detail', response.data.import.id],
      });
      void messageApi.success(
        response.data.replayed ? '已打开相同文件的历史预检' : '安全预检已完成',
      );
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const saveResolution = useMutation({
    mutationFn: async (input: { row: ExcelImportRow; values: ResolutionFormValue }) => {
      if (!current) throw new Error('预检详情尚未加载');
      return apiRequest<ExcelImportDetail>(`/api/v1/excel-imports/${current.id}/resolutions`, {
        method: 'PUT',
        body: JSON.stringify({
          version: current.version,
          rows: [
            {
              id: input.row.id,
              version: input.row.version,
              action: input.values.action,
              matchedTaskId:
                input.values.action === 'link_jira' ? input.values.matchedTaskId : null,
              fields: {
                parentIssueKey: emptyToNull(input.values.parentIssueKey),
                parentTitle: emptyToNull(input.values.parentTitle),
                title: emptyToNull(input.values.title),
                assigneeName: emptyToNull(input.values.assigneeName),
                plannedStartDate: emptyToNull(input.values.plannedStartDate),
                dueDate: emptyToNull(input.values.dueDate),
                estimateHours: input.values.estimateHours ?? null,
              },
            },
          ],
        }),
      });
    },
    onSuccess: async (response) => {
      queryClient.setQueryData(['excel-import-detail', response.data.id], response);
      await queryClient.invalidateQueries({ queryKey: ['excel-imports'] });
      setEditingRow(null);
      setAcknowledgedWarnings(false);
      setCommitKey(createCommitKey());
      void messageApi.success('本次预检修正已保存；源 Excel 未被改写');
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const commit = useMutation({
    mutationFn: async () => {
      if (!current) throw new Error('预检详情尚未加载');
      return apiRequest<ExcelCommitResult>(`/api/v1/excel-imports/${current.id}/commit`, {
        method: 'POST',
        headers: { 'Idempotency-Key': commitKey },
        body: JSON.stringify({
          previewVersion: current.version,
          acknowledgedWarnings,
        }),
      });
    },
    onSuccess: async (response) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['excel-imports'] }),
        queryClient.invalidateQueries({
          queryKey: ['excel-import-detail', response.data.importId],
        }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      ]);
      void messageApi.success(
        `导入已提交：创建 ${response.data.summary.created}，链接 ${response.data.summary.linked}，补充字段 ${response.data.summary.supplemented}`,
      );
    },
    onError: (error: Error) => void messageApi.error(error.message),
  });

  const filteredRows = useMemo(
    () =>
      filterExcelRows(current?.rows ?? [], {
        ...(severity ? { severity } : {}),
        ...(sheetName ? { sheetName } : {}),
        ...(action ? { action } : {}),
      }),
    [current?.rows, severity, sheetName, action],
  );
  const sheets = [...new Set((current?.rows ?? []).map((row) => row.sheetName))];
  // 前端门禁只负责及时反馈；服务端会再次校验版本、诊断计数和 warning 确认，不能绕过事务边界。
  const canCommit =
    current?.status === 'preview_ready' &&
    current.counts.blocking === 0 &&
    current.counts.conflict === 0 &&
    (current.counts.warning === 0 || acknowledgedWarnings);

  const chooseImport = (id: string) => {
    setSelectedId(id);
    setSeverity(undefined);
    setSheetName(undefined);
    setAction(undefined);
    setAcknowledgedWarnings(false);
    setCommitKey(createCommitKey());
  };

  return (
    <Modal
      title={
        <Space>
          <FileExcelOutlined />
          Excel 安全导入向导
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width="min(1500px, 96vw)"
      destroyOnHidden
    >
      {holder}
      <Alert
        type="info"
        showIcon
        message="只读源文件、先预检后提交"
        description="系统不会回写或保留原 Excel 字节；公式只读缓存值，不加载外部链接。所有修正仅作用于本次预检，Jira 已有字段不会被 Excel 覆盖。"
        style={{ marginBottom: 16 }}
      />
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Upload
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            maxCount={1}
            beforeUpload={() => false}
            fileList={fileList}
            onChange={({ fileList: next }) => setFileList(next.slice(-1))}
          >
            <Button icon={<UploadOutlined />}>选择 XLSX</Button>
          </Upload>
          <Button
            type="primary"
            icon={<FileExcelOutlined />}
            loading={upload.isPending}
            disabled={fileList.length !== 1}
            onClick={() => upload.mutate()}
          >
            安全解析并生成预检
          </Button>
          <Button
            icon={<ReloadOutlined />}
            loading={imports.isFetching || detail.isFetching}
            onClick={() => {
              void imports.refetch();
              void detail.refetch();
            }}
          >
            刷新
          </Button>
        </Space>
      </Card>

      <Row gutter={16} align="top">
        <Col xs={24} xl={6}>
          <Card title="导入历史" size="small">
            <Table<ExcelImportSummary>
              rowKey="id"
              size="small"
              loading={imports.isLoading}
              dataSource={imports.data?.data ?? []}
              pagination={{ pageSize: 8, hideOnSinglePage: true }}
              onRow={(row) => ({ onClick: () => chooseImport(row.id) })}
              rowClassName={(row) => (row.id === selectedId ? 'ant-table-row-selected' : '')}
              columns={[
                {
                  title: '文件 / 时间',
                  render: (_, row) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text
                        ellipsis={{ tooltip: row.fileName }}
                        style={{ maxWidth: 210 }}
                      >
                        {row.fileName}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {new Date(row.createdAt).toLocaleString('zh-CN')}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: '状态',
                  width: 92,
                  render: (_, row) => <ImportStatus status={row.status} />,
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={18}>
          {!current ? (
            <Card loading={detail.isLoading}>选择或上传 Excel 文件以查看预检</Card>
          ) : (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <ImportHeader value={current} />
              {current.status === 'failed' && (
                <Alert
                  type="error"
                  showIcon
                  message={current.errorCode ?? '预检失败'}
                  description={current.errorSummary ?? '文件未通过安全解析'}
                />
              )}
              {current.diagnostics.length > 0 && (
                <DiagnosticList title="文件与工作表诊断" diagnostics={current.diagnostics} />
              )}
              <Card size="small" title="逐行预检与冲突处理">
                <Space wrap style={{ marginBottom: 12 }}>
                  <Select
                    allowClear
                    placeholder="严重度"
                    value={severity}
                    onChange={setSeverity}
                    style={{ width: 150 }}
                    options={[
                      { value: 'blocking', label: 'Blocking' },
                      { value: 'conflict', label: 'Conflict' },
                      { value: 'warning', label: 'Warning' },
                      { value: 'info', label: 'Info' },
                    ]}
                  />
                  <Select
                    allowClear
                    placeholder="工作表"
                    value={sheetName}
                    onChange={setSheetName}
                    style={{ width: 190 }}
                    options={sheets.map((sheet) => ({ value: sheet, label: sheet }))}
                  />
                  <Select
                    allowClear
                    placeholder="建议动作"
                    value={action}
                    onChange={setAction}
                    style={{ width: 190 }}
                    options={['create_excel', 'link_jira', 'skip', 'conflict', 'blocked'].map(
                      (value) => ({
                        value,
                        label: actionLabel(value as ExcelImportRow['proposedAction']),
                      }),
                    )}
                  />
                  <Typography.Text type="secondary">
                    显示 {filteredRows.length}/{current.rows.length} 行
                  </Typography.Text>
                </Space>
                <Table<ExcelImportRow>
                  rowKey="id"
                  size="small"
                  loading={detail.isLoading}
                  dataSource={filteredRows}
                  scroll={{ x: 1250 }}
                  pagination={{ pageSize: 15, showSizeChanger: true }}
                  expandable={{ expandedRowRender: (row) => <RawRowDetail row={row} /> }}
                  columns={[
                    {
                      title: '坐标',
                      width: 145,
                      fixed: 'left',
                      render: (_, row) => (
                        <Space direction="vertical" size={0}>
                          <Typography.Text strong>{row.sheetName}</Typography.Text>
                          <Typography.Text type="secondary">第 {row.rowNumber} 行</Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: '父任务 / 子任务',
                      width: 300,
                      render: (_, row) => (
                        <Space direction="vertical" size={0}>
                          <Typography.Text>
                            {row.normalized.parentIssueKey ?? '无父 ID'} ·{' '}
                            {row.normalized.parentTitle ?? '无父名称'}
                          </Typography.Text>
                          <Typography.Text strong>
                            {row.normalized.title ?? '容器/缺失标题'}
                          </Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: '经办人',
                      width: 130,
                      render: (_, row) => (
                        <Space direction="vertical" size={0}>
                          <Typography.Text>
                            {row.normalized.assigneeName ?? '未分配'}
                          </Typography.Text>
                          {row.normalized.isCurrentUser && <Tag color="green">当前用户</Tag>}
                        </Space>
                      ),
                    },
                    {
                      title: '排期 / 工时',
                      width: 210,
                      render: (_, row) => (
                        <Space direction="vertical" size={0}>
                          <Typography.Text>
                            {row.normalized.plannedStartDate ?? '—'} →{' '}
                            {row.normalized.dueDate ?? '—'}
                          </Typography.Text>
                          <Typography.Text>
                            {row.normalized.estimateHours === null
                              ? '工时为空'
                              : `${row.normalized.estimateHours} h / ${formatNumber(row.normalized.personDays)} 人日`}
                          </Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: '匹配 / 动作',
                      width: 210,
                      render: (_, row) => (
                        <Space direction="vertical" size={2}>
                          <ActionTag action={row.proposedAction} />
                          <Typography.Text type="secondary">
                            {row.matchedTask
                              ? `${row.matchedTask.issueKey ?? 'Jira'} · ${row.matchedTask.title}`
                              : row.candidates.length > 0
                                ? `${row.candidates.length} 个候选`
                                : '无 Jira 匹配'}
                          </Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: '诊断',
                      width: 260,
                      render: (_, row) =>
                        row.diagnostics.length === 0 ? (
                          <Tag color="success">无问题</Tag>
                        ) : (
                          <Space size={[0, 4]} wrap>
                            {row.diagnostics.map((diagnostic) => (
                              <Tag
                                key={`${diagnostic.code}:${diagnostic.cell ?? ''}`}
                                color={diagnosticColor(diagnostic.severity)}
                              >
                                {diagnostic.cell ? `${diagnostic.cell} · ` : ''}
                                {diagnostic.code}
                              </Tag>
                            ))}
                          </Space>
                        ),
                    },
                    {
                      title: '处理',
                      width: 100,
                      fixed: 'right',
                      render: (_, row) => (
                        <Button
                          size="small"
                          icon={<EditOutlined />}
                          disabled={current.status !== 'preview_ready'}
                          onClick={() => setEditingRow(row)}
                        >
                          修正
                        </Button>
                      ),
                    },
                  ]}
                />
              </Card>
              <Card size="small" title="确认提交">
                <Space direction="vertical" style={{ width: '100%' }}>
                  {(current.counts.blocking > 0 || current.counts.conflict > 0) && (
                    <Alert
                      type="error"
                      showIcon
                      message={`仍有 ${current.counts.blocking} 个阻断、${current.counts.conflict} 个冲突`}
                      description="逐行修正、选择 Jira 候选或明确跳过后才能提交。"
                    />
                  )}
                  {current.counts.warning > 0 && current.status === 'preview_ready' && (
                    <Checkbox
                      checked={acknowledgedWarnings}
                      onChange={(event) => setAcknowledgedWarnings(event.target.checked)}
                    >
                      我已查看并确认 {current.counts.warning} 个
                      warning；确认只影响本地统一任务视图，不回写 Jira 或源 Excel
                    </Checkbox>
                  )}
                  {current.status === 'committed' ? (
                    <Alert
                      type="success"
                      showIcon
                      icon={<CheckCircleOutlined />}
                      message="该预检已提交"
                      description={<CommitSummary value={current.commitSummary} />}
                    />
                  ) : (
                    <Button
                      type="primary"
                      danger
                      size="large"
                      loading={commit.isPending}
                      disabled={!canCommit}
                      onClick={() => commit.mutate()}
                    >
                      确认并单事务提交
                    </Button>
                  )}
                </Space>
              </Card>
            </Space>
          )}
        </Col>
      </Row>
      <ResolutionModal
        row={editingRow}
        loading={saveResolution.isPending}
        onCancel={() => setEditingRow(null)}
        onSave={(values) => {
          if (editingRow) saveResolution.mutate({ row: editingRow, values });
        }}
      />
    </Modal>
  );
}

function ImportHeader({ value }: { value: ExcelImportDetail }) {
  return (
    <Card size="small">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {value.fileName}
          </Typography.Title>
          <ImportStatus status={value.status} />
          <Tag>{(value.fileSizeBytes / 1024).toFixed(1)} KiB</Tag>
          <Tag>日期系统 {value.dateSystem}</Tag>
          <Tag>{value.workdayHours} h/人日</Tag>
        </Space>
        <Typography.Text type="secondary">
          SHA-256 {value.fileSha256} · 解析器 {value.parserVersion} · 版本 {value.version}
        </Typography.Text>
        <Row gutter={12}>
          <Metric title="任务行" value={value.counts.tasks} />
          <Metric title="容器行" value={value.counts.containers} />
          <Metric title="Blocking" value={value.counts.blocking} color="#cf1322" />
          <Metric title="Conflict" value={value.counts.conflict} color="#d46b08" />
          <Metric title="Warning" value={value.counts.warning} color="#d48806" />
          <Metric title="Info" value={value.counts.info} color="#1677ff" />
        </Row>
      </Space>
    </Card>
  );
}

function Metric({ title, value, color }: { title: string; value: number; color?: string }) {
  return (
    <Col xs={12} sm={8} lg={4}>
      <Statistic title={title} value={value} {...(color ? { valueStyle: { color } } : {})} />
    </Col>
  );
}

function ResolutionModal({
  row,
  loading,
  onCancel,
  onSave,
}: {
  row: ExcelImportRow | null;
  loading: boolean;
  onCancel: () => void;
  onSave: (values: ResolutionFormValue) => void;
}) {
  const [form] = Form.useForm<ResolutionFormValue>();
  const action = Form.useWatch('action', form);
  useEffect(() => {
    if (!row) return;
    const proposed = ['create_excel', 'link_jira', 'skip'].includes(row.proposedAction)
      ? row.proposedAction
      : undefined;
    form.resetFields();
    form.setFieldsValue({
      ...(proposed ? { action: proposed as ResolutionFormValue['action'] } : {}),
      ...(row.matchedTask?.id ? { matchedTaskId: row.matchedTask.id } : {}),
      parentIssueKey: row.normalized.parentIssueKey,
      parentTitle: row.normalized.parentTitle,
      title: row.normalized.title,
      assigneeName: row.normalized.assigneeName,
      plannedStartDate: row.normalized.plannedStartDate,
      dueDate: row.normalized.dueDate,
      estimateHours: row.normalized.estimateHours,
    });
  }, [form, row]);
  return (
    <Modal
      title={row ? `修正 ${row.sheetName} 第 ${row.rowNumber} 行` : '修正预检行'}
      open={Boolean(row)}
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={loading}
      okText="保存并重新校验"
      width={820}
      destroyOnHidden
    >
      {row && (
        <>
          <Alert
            type="warning"
            showIcon
            message="修正仅作用于本次导入预检"
            description="清空无效值也是明确修正；系统不会回写原单元格。选择跳过时，本行不会创建或补充任务。"
            style={{ marginBottom: 16 }}
          />
          <DiagnosticList title="当前诊断" diagnostics={row.diagnostics} />
          <Divider />
          <Form<ResolutionFormValue>
            form={form}
            layout="vertical"
            onFinish={onSave}
            preserve={false}
          >
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="action" label="确认动作" rules={[{ required: true }]}>
                  <Select
                    options={[
                      { value: 'create_excel', label: '创建/更新 Excel 独立任务' },
                      ...(row.candidates.length > 0
                        ? [{ value: 'link_jira', label: '链接 Jira 并逐字段补充' }]
                        : []),
                      { value: 'skip', label: '明确跳过本行' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                {action === 'link_jira' && (
                  <Form.Item name="matchedTaskId" label="Jira 候选" rules={[{ required: true }]}>
                    <Select
                      options={row.candidates.map((candidate) => ({
                        value: candidate.id,
                        label: `${candidate.issueKey ?? 'Jira'} · ${candidate.title} · ${candidate.assigneeName ?? '未分配'}`,
                      }))}
                    />
                  </Form.Item>
                )}
              </Col>
              <Col span={12}>
                <Form.Item name="parentIssueKey" label="父任务 ID">
                  <Input placeholder="例如 PROJ-100" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="parentTitle" label="父任务名称">
                  <Input />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item name="title" label="子任务标题">
                  <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="assigneeName" label="经办人">
                  <Input />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="estimateHours" label="预估工时（小时）">
                  <InputNumber min={0} max={10_000} precision={4} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="plannedStartDate"
                  label="开始日期"
                  extra="严格 YYYY-MM-DD；留空表示明确清除无效值"
                >
                  <Input placeholder="YYYY-MM-DD" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="dueDate" label="到期日期" extra="严格 YYYY-MM-DD">
                  <Input placeholder="YYYY-MM-DD" />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </>
      )}
    </Modal>
  );
}

function RawRowDetail({ row }: { row: ExcelImportRow }) {
  // 原值、公式和公式缓存必须并列展示，不能把缓存结果伪装成用户在单元格中填写的原值。
  const rawCells = Object.entries(row.raw).map(([field, cell]) => ({ field, cell }));
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Text strong>原始单元格（公式与缓存值分开展示）</Typography.Text>
      <Table
        rowKey="field"
        size="small"
        pagination={false}
        dataSource={rawCells}
        columns={[
          { title: '字段', dataIndex: 'field', width: 160 },
          {
            title: '坐标 / 类型',
            width: 160,
            render: (_, item) =>
              item.cell ? `${item.cell.address} · ${item.cell.type}` : '无单元格',
          },
          {
            title: '原值',
            render: (_, item) => (item.cell ? displayValue(item.cell.value) : '—'),
          },
          {
            title: '公式',
            render: (_, item) => item.cell?.formula ?? '—',
          },
          {
            title: '缓存结果',
            render: (_, item) => (item.cell ? displayValue(item.cell.cachedResult) : '—'),
          },
          {
            title: '格式',
            render: (_, item) => item.cell?.numberFormat ?? '—',
          },
        ]}
      />
      <Descriptions bordered size="small" column={2} title="规范化结果">
        {Object.entries(row.normalized).map(([key, value]) => (
          <Descriptions.Item key={key} label={key}>
            {displayValue(value)}
          </Descriptions.Item>
        ))}
      </Descriptions>
      {row.candidates.length > 0 && (
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={row.candidates}
          columns={[
            { title: '候选 Jira', dataIndex: 'issueKey' },
            { title: '标题', dataIndex: 'title' },
            { title: '经办人', dataIndex: 'assigneeName' },
            {
              title: 'Jira 主字段',
              dataIndex: 'jiraValues',
              render: (value: ExcelImportRow['candidates'][number]['jiraValues']) =>
                displayValue(value),
            },
          ]}
        />
      )}
    </Space>
  );
}

function DiagnosticList({ title, diagnostics }: { title: string; diagnostics: ExcelDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <Alert
      type={diagnostics.some((item) => item.severity === 'blocking') ? 'error' : 'warning'}
      showIcon
      message={title}
      description={
        <Space direction="vertical" size={4}>
          {diagnostics.map((diagnostic) => (
            <Typography.Text key={`${diagnostic.code}:${diagnostic.cell ?? ''}`}>
              <Tag color={diagnosticColor(diagnostic.severity)}>{diagnostic.severity}</Tag>
              {diagnostic.cell ? `${diagnostic.cell} · ` : ''}
              {diagnostic.message}
              {diagnostic.suggestedAction ? `；建议：${diagnostic.suggestedAction}` : ''}
            </Typography.Text>
          ))}
        </Space>
      }
    />
  );
}

function ImportStatus({ status }: { status: ExcelImportSummary['status'] }) {
  const view = {
    preview_ready: { color: 'processing', text: '待确认' },
    committed: { color: 'success', text: '已提交' },
    failed: { color: 'error', text: '失败' },
  }[status];
  return <Tag color={view.color}>{view.text}</Tag>;
}

function ActionTag({ action }: { action: ExcelImportRow['proposedAction'] }) {
  const color = {
    create_excel: 'green',
    link_jira: 'blue',
    skip: 'default',
    conflict: 'orange',
    blocked: 'red',
  }[action];
  return <Tag color={color}>{actionLabel(action)}</Tag>;
}

function CommitSummary({ value }: { value: unknown }) {
  const result = value as Partial<ExcelCommitResult>;
  if (!result.summary) return <Typography.Text>提交摘要已保存</Typography.Text>;
  return (
    <Space wrap>
      <Tag color="green">创建 {result.summary.created}</Tag>
      <Tag color="blue">链接 {result.summary.linked}</Tag>
      <Tag color="cyan">补充字段 {result.summary.supplemented}</Tag>
      <Tag>保留 Jira {result.summary.keptJira}</Tag>
      <Tag>跳过 {result.summary.skipped}</Tag>
    </Space>
  );
}

function emptyToNull(value: string | null | undefined): string | null {
  const cleaned = value?.trim() ?? '';
  return cleaned || null;
}

function formatNumber(value: number | null): string {
  if (value === null) return '—';
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '');
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[无法显示]';
  }
}

function createCommitKey(): string {
  // 同一次按钮重试复用该键；上传、切换预检或保存修正时由上层显式轮换。
  return `excel-${globalThis.crypto.randomUUID()}`;
}
