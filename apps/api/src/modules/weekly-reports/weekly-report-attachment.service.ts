import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';

const maxAttachmentBytes = 8 * 1024 * 1024;
const allowedTypes = new Map([
  ['.pdf', new Set(['application/pdf'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
  ['.xlsx', new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])],
  ['.png', new Set(['image/png'])],
  ['.jpg', new Set(['image/jpeg'])],
  ['.jpeg', new Set(['image/jpeg'])],
  ['.txt', new Set(['text/plain'])],
]);

interface UploadContext {
  correlationId: string;
  sessionId: string;
}

@Injectable()
export class WeeklyReportAttachmentService {
  private readonly attachmentRoot: string;

  public constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
  ) {
    this.attachmentRoot = join(config.dataDir, 'weekly-report-attachments');
  }

  public async list(reportId: string) {
    await this.assertOwnedReport(reportId);
    const rows = await this.prisma.weeklyReportAttachment.findMany({
      where: { reportId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map((row) => this.serialize(row));
  }

  public async upload(
    reportId: string,
    input: { buffer: Buffer; fileName: string; mimeType: string },
    context: UploadContext,
  ) {
    await this.assertOwnedReport(reportId);
    if (input.buffer.length === 0 || input.buffer.length > maxAttachmentBytes) {
      throw new DomainError(
        'WEEKLY_REPORT_ATTACHMENT_SIZE_INVALID',
        '附件必须大于 0 字节且不超过 8 MiB',
        {
          httpStatus: 422,
        },
      );
    }
    const originalName = input.fileName.trim().normalize('NFKC');
    if (
      !originalName ||
      originalName.length > 255 ||
      Array.from(originalName).some((character) => character.charCodeAt(0) < 32)
    ) {
      throw new DomainError('WEEKLY_REPORT_ATTACHMENT_NAME_INVALID', '附件文件名无效', {
        httpStatus: 422,
      });
    }
    const extension = extname(originalName).toLowerCase();
    if (!allowedTypes.get(extension)?.has(input.mimeType)) {
      throw new DomainError(
        'WEEKLY_REPORT_ATTACHMENT_TYPE_UNSUPPORTED',
        '附件扩展名与 MIME 类型必须匹配，支持 PDF、DOCX、XLSX、PNG、JPEG、TXT',
        { httpStatus: 415 },
      );
    }
    this.assertMagicBytes(extension, input.buffer);
    const id = newId();
    const storedName = `${id}${extension}`;
    const reportDirectory = join(this.attachmentRoot, reportId);
    const storedPath = join(reportDirectory, storedName);
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(storedPath, input.buffer, { flag: 'wx' });
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.weeklyReportAttachment.create({
          data: {
            id,
            reportId,
            originalName,
            storedName,
            mimeType: input.mimeType,
            extension,
            sizeBytes: input.buffer.length,
            contentHash: createHash('sha256').update(input.buffer).digest('hex'),
            createdBy: this.sessions.currentProfileId,
          },
        });
        await this.audit.recordInTransaction(tx, {
          actorId: this.sessions.currentProfileId,
          action: 'weekly_report.attachment_uploaded',
          targetType: 'weekly_report_attachment',
          targetId: created.id,
          correlationId: context.correlationId,
          outcome: 'succeeded',
          after: {
            reportId,
            originalName,
            sizeBytes: created.sizeBytes,
            contentHash: created.contentHash,
          },
          clientSessionHash: this.security.sessionHash(context.sessionId),
        });
        return created;
      });
      return this.serialize(row);
    } catch (error) {
      await unlink(storedPath).catch(() => undefined);
      throw error;
    }
  }

  public async remove(reportId: string, attachmentId: string, context: UploadContext) {
    return this.prisma.$transaction(async (tx) => {
      const report = await tx.weeklyReport.findFirst({
        where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
        include: { currentVersion: true },
      });
      if (!report) throw new DomainError(errorCodes.notFound, '周报不存在', { httpStatus: 404 });
      const attachment = await tx.weeklyReportAttachment.findFirst({
        where: { id: attachmentId, reportId },
      });
      if (!attachment) {
        throw new DomainError(errorCodes.notFound, '周报附件不存在', { httpStatus: 404 });
      }
      if (attachment.status === 'deleted') {
        return { replayed: true, attachment: this.serialize(attachment) };
      }
      if (
        report.currentVersion &&
        this.parseAttachmentIds(report.currentVersion.attachmentsJson).includes(attachmentId)
      ) {
        throw new DomainError(
          'WEEKLY_REPORT_ATTACHMENT_IN_USE',
          '附件仍被当前周报版本引用，请先保存一个移除该附件的新版本',
          { httpStatus: 409, suggestedAction: 'manual_review' },
        );
      }
      const deletedAt = new Date();
      const row = await tx.weeklyReportAttachment.update({
        where: { id: attachmentId },
        data: { status: 'deleted', deletedAt },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'weekly_report.attachment_removed',
        targetType: 'weekly_report_attachment',
        targetId: row.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        before: { status: attachment.status },
        after: { status: row.status, deletedAt: deletedAt.toISOString() },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return { replayed: false, attachment: this.serialize(row) };
    });
  }

  public storedPath(reportId: string, storedName: string): string {
    return join(this.attachmentRoot, reportId, storedName);
  }

  private assertMagicBytes(extension: string, buffer: Buffer): void {
    const valid =
      (extension === '.pdf' && buffer.subarray(0, 5).toString('ascii') === '%PDF-') ||
      (extension === '.png' &&
        buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ||
      ((extension === '.jpg' || extension === '.jpeg') &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer.at(-2) === 0xff &&
        buffer.at(-1) === 0xd9) ||
      ((extension === '.docx' || extension === '.xlsx') &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        [0x03, 0x05, 0x07].includes(buffer[2] ?? -1) &&
        [0x04, 0x06, 0x08].includes(buffer[3] ?? -1)) ||
      (extension === '.txt' && !buffer.includes(0));
    if (!valid) {
      throw new DomainError(
        'WEEKLY_REPORT_ATTACHMENT_SIGNATURE_INVALID',
        '附件内容签名与扩展名不一致，文件可能损坏或被伪装',
        { httpStatus: 422 },
      );
    }
  }

  private parseAttachmentIds(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.flatMap((item) =>
            typeof item === 'object' && item !== null && 'id' in item
              ? [String((item as { id: unknown }).id)]
              : [],
          )
        : [];
    } catch {
      return [];
    }
  }

  private async assertOwnedReport(reportId: string) {
    const report = await this.prisma.weeklyReport.findFirst({
      where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      select: { id: true },
    });
    if (!report) throw new DomainError(errorCodes.notFound, '周报不存在', { httpStatus: 404 });
  }

  private serialize(row: {
    id: string;
    originalName: string;
    mimeType: string;
    extension: string;
    sizeBytes: number;
    contentHash: string;
    status: string;
    createdAt: Date;
    deletedAt: Date | null;
  }) {
    return {
      id: row.id,
      originalName: row.originalName,
      mimeType: row.mimeType,
      extension: row.extension,
      sizeBytes: row.sizeBytes,
      contentHash: row.contentHash,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
    };
  }
}
