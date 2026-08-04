import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const BRIDGE_HEARTBEAT_MAX_AGE_MS = 15_000;

const bridgeHeartbeatSchema = z
  .object({
    version: z.literal(1),
    processId: z.number().int().positive(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const dingTalkDesktopConfigSchema = z
  .object({
    organizationName: z.string().trim().min(1).max(200),
    templateName: z.string().trim().min(1).max(200).default('uTwin产研创新部周报'),
    recipientGroupName: z.string().trim().min(1).max(200),
    executablePath: z.string().trim().min(1).max(1_024).optional(),
    timeoutSeconds: z.number().int().min(5).max(180).default(45),
    fieldLabels: z
      .object({
        reportDate: z.string().trim().min(1).max(200),
        recentGoals: z.string().trim().min(1).max(200),
        weeklyWork: z.string().trim().min(1).max(200),
        nextWeekPlans: z.string().trim().min(1).max(200),
        problems: z.string().trim().min(1).max(200),
        other: z.string().trim().min(1).max(200),
      })
      .optional(),
  })
  .strict();

export type DingTalkDesktopConfig = z.infer<typeof dingTalkDesktopConfigSchema>;

const runnerResultSchema = z
  .object({
    success: z.boolean(),
    status: z.enum(['healthy', 'succeeded', 'failed', 'unknown']),
    errorCode: z.string().optional(),
    message: z.string().optional(),
    runId: z.string().optional(),
    receipt: z.string().optional(),
    successText: z.string().optional(),
    processId: z.number().int().optional(),
    windowTitle: z.string().optional(),
    organizationVisible: z.boolean().optional(),
    templateVisible: z.boolean().optional(),
    recipientVisible: z.boolean().optional(),
    observedFields: z.array(z.string()).optional(),
    beforeScreenshot: z.string().nullable().optional(),
    afterScreenshot: z.string().nullable().optional(),
  })
  .passthrough();

export type DingTalkDesktopRunnerResult = z.infer<typeof runnerResultSchema>;

export interface DingTalkDesktopSubmission {
  reportDate: string;
  recentGoals: string;
  weeklyWork: string;
  nextWeekPlans: string;
  problems: string;
  other: string;
}

@Injectable()
export class DingTalkDesktopClient {
  public async assertReady(
    platform: NodeJS.Platform = process.platform,
    bridgeRoot = process.env.AUTO_WORK_DINGTALK_DESKTOP_BRIDGE_DIR,
    now = Date.now(),
  ): Promise<void> {
    if (platform === 'win32') return;
    if (!bridgeRoot) {
      throw new DomainError(
        'DINGTALK_DESKTOP_BRIDGE_REQUIRED',
        '当前运行在 Docker/Linux 中，必须启动 Windows 钉钉桌面桥接程序',
        { httpStatus: 503, retryable: true, suggestedAction: 'reconfigure' },
      );
    }

    let heartbeat: unknown;
    try {
      heartbeat = JSON.parse(await readFile(join(bridgeRoot, 'heartbeat.json'), 'utf8'));
    } catch {
      throw new DomainError(
        'DINGTALK_DESKTOP_BRIDGE_UNAVAILABLE',
        'Windows 钉钉桌面桥接未运行，或 Docker 无法访问桥接目录',
        { httpStatus: 503, retryable: true, suggestedAction: 'reconfigure' },
      );
    }
    const parsed = bridgeHeartbeatSchema.safeParse(heartbeat);
    const heartbeatAt = parsed.success ? Date.parse(parsed.data.updatedAt) : Number.NaN;
    if (
      !parsed.success ||
      !Number.isFinite(heartbeatAt) ||
      heartbeatAt > now + BRIDGE_HEARTBEAT_MAX_AGE_MS ||
      now - heartbeatAt > BRIDGE_HEARTBEAT_MAX_AGE_MS
    ) {
      throw new DomainError(
        'DINGTALK_DESKTOP_BRIDGE_UNAVAILABLE',
        'Windows 钉钉桌面桥接心跳已失效，请恢复桥接后再提交',
        { httpStatus: 503, retryable: true, suggestedAction: 'reconfigure' },
      );
    }
  }

  public async probe(config: DingTalkDesktopConfig): Promise<DingTalkDesktopRunnerResult> {
    return this.run({ operation: 'probe', ...config });
  }

  public async submit(
    config: DingTalkDesktopConfig,
    content: DingTalkDesktopSubmission,
  ): Promise<DingTalkDesktopRunnerResult> {
    const runId = newId().replaceAll('-', '');
    return this.run({
      operation: 'submit',
      runId,
      ...config,
      ...content,
      evidenceDirectory: this.evidenceDirectory(),
    });
  }

  private async run(request: Record<string, unknown>): Promise<DingTalkDesktopRunnerResult> {
    const timeoutSeconds = typeof request.timeoutSeconds === 'number' ? request.timeoutSeconds : 45;
    // timeoutSeconds is a per-OCR-stage limit. A full submit traverses several independent
    // stages, so treating it as the whole bridge timeout reports a false failure while the
    // Windows runner is still active.
    const stageMultiplier = request.operation === 'submit' ? 8 : 4;
    const timeoutMs = Math.min((timeoutSeconds * stageMultiplier + 30) * 1_000, 10 * 60_000);
    const result =
      process.platform === 'win32'
        ? await this.runDirect(request, timeoutMs)
        : await this.runThroughBridge(request, timeoutMs);
    const parsed = runnerResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new DomainError(
        'DINGTALK_DESKTOP_RESULT_INVALID',
        '钉钉桌面自动化返回了无法识别的结果',
        { details: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) } },
      );
    }
    return parsed.data;
  }

  private async runDirect(request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const working = await mkdtemp(join(tmpdir(), 'auto-work-dingtalk-'));
    const inputPath = join(working, 'input.json');
    const outputPath = join(working, 'output.json');
    try {
      await writeFile(inputPath, JSON.stringify(request), { encoding: 'utf8', mode: 0o600 });
      try {
        await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Sta',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            this.runnerScript(),
            '-InputPath',
            inputPath,
            '-OutputPath',
            outputPath,
          ],
          { timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1_024 },
        );
      } catch (error) {
        const output = await readFile(outputPath, 'utf8').catch(() => null);
        if (output) return JSON.parse(output) as unknown;
        if (this.isTimeout(error)) {
          throw new DomainError(
            'DINGTALK_DESKTOP_SUBMISSION_RESULT_UNKNOWN',
            '钉钉桌面自动化超时，无法确认是否已经提交；禁止自动重试',
            { retryable: false, suggestedAction: 'manual_review' },
          );
        }
        throw new DomainError(
          'DINGTALK_DESKTOP_RUNNER_FAILED',
          error instanceof Error ? error.message : '无法启动钉钉桌面自动化',
          { retryable: false, suggestedAction: 'reconfigure' },
        );
      }
      return JSON.parse(await readFile(outputPath, 'utf8')) as unknown;
    } finally {
      await rm(working, { recursive: true, force: true });
    }
  }

  private async runThroughBridge(
    request: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const bridgeRoot = process.env.AUTO_WORK_DINGTALK_DESKTOP_BRIDGE_DIR;
    await this.assertReady(process.platform, bridgeRoot);
    if (!bridgeRoot) throw new Error('Bridge root must exist after readiness validation.');
    const requestRoot = join(bridgeRoot, 'requests');
    const responseRoot = join(bridgeRoot, 'responses');
    await mkdir(requestRoot, { recursive: true });
    await mkdir(responseRoot, { recursive: true });
    const id = `${Date.now()}-${newId()}`;
    const temporaryPath = join(requestRoot, `.${id}.tmp`);
    const requestPath = join(requestRoot, `${id}.json`);
    const responsePath = join(responseRoot, `${id}.json`);
    const requestedAt = Date.now();
    const deadline = requestedAt + timeoutMs;
    await writeFile(
      temporaryPath,
      JSON.stringify({
        ...request,
        bridgeRequestedAt: new Date(requestedAt).toISOString(),
        bridgeExpiresAt: new Date(deadline).toISOString(),
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporaryPath, requestPath);
    try {
      while (Date.now() < deadline) {
        const response = await readFile(responsePath, 'utf8').catch(() => null);
        if (response) return JSON.parse(response) as unknown;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      throw new DomainError(
        'DINGTALK_DESKTOP_SUBMISSION_RESULT_UNKNOWN',
        '等待 Windows 钉钉桌面桥接响应超时，无法确认是否已经提交；禁止自动重试',
        { retryable: false, suggestedAction: 'manual_review' },
      );
    } finally {
      await rm(requestPath, { force: true });
      await rm(responsePath, { force: true });
    }
  }

  private runnerScript(): string {
    const configured = process.env.AUTO_WORK_DINGTALK_DESKTOP_SCRIPT;
    if (configured) return resolve(configured);
    return resolve(process.cwd(), 'scripts/windows/Invoke-DingTalkDesktopAutomation.ps1');
  }

  private evidenceDirectory(): string {
    const dataRoot = process.env.AUTO_WORK_DATA_DIR ?? resolve(process.cwd(), 'data');
    return resolve(dataRoot, 'dingtalk-desktop-evidence');
  }

  private isTimeout(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      ('killed' in error || ('code' in error && (error as { code?: unknown }).code === 'ETIMEDOUT'))
    );
  }
}
