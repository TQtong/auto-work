const port = process.env.AUTO_WORK_PORT ?? '3760';
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 4_000);

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    headers: { host: `127.0.0.1:${port}` },
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  // 健康容器必须不仅能接受 TCP，还要完成数据库与调度器就绪检查。
  if (body?.data?.status !== 'ready') throw new Error('应用尚未就绪');
} catch (error) {
  console.error('Auto Work 健康检查失败：', error instanceof Error ? error.message : '未知错误');
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
