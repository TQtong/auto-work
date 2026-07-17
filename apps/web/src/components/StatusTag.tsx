import { Tag } from 'antd';

const colors: Record<string, string> = {
  ready: 'success',
  healthy: 'success',
  succeeded: 'success',
  verified: 'success',
  running: 'processing',
  testing: 'processing',
  queued: 'default',
  unknown: 'warning',
  degraded: 'warning',
  configuration_required: 'warning',
  failed: 'error',
  invalid: 'error',
  dead_letter: 'error',
  disabled: 'default',
  cancelled: 'default',
};

const labels: Record<string, string> = {
  ready: '就绪',
  healthy: '健康',
  succeeded: '成功',
  verified: '已校验',
  running: '运行中',
  testing: '测试中',
  queued: '排队中',
  unknown: '结果待核对',
  degraded: '已降级',
  configuration_required: '需配置',
  failed: '失败',
  invalid: '无效',
  dead_letter: '需人工处理',
  disabled: '已禁用',
  cancelled: '已取消',
};

export function StatusTag({ status }: { status: string }) {
  return <Tag color={colors[status] ?? 'default'}>{labels[status] ?? status}</Tag>;
}
