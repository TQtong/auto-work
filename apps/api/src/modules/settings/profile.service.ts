import { Injectable } from '@nestjs/common';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';

export interface RequestAuditContext {
  correlationId: string;
  sessionId: string;
}

export interface UpdateProfileInput {
  version: number;
  displayName?: string | undefined;
  timezone?: string | undefined;
  workdayHours?: number | undefined;
}

export interface AddAliasInput {
  aliasType:
    | 'git_name'
    | 'git_email'
    | 'gitlab_user_id'
    | 'gitlab_username'
    | 'jira_account_id'
    | 'jira_username';
  value: string;
  source: 'user' | 'git_config' | 'gitlab_connection' | 'jira_connection';
  enabled: boolean;
}

@Injectable()
export class ProfileService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
  ) {}

  public async get() {
    return this.prisma.userProfile.findUniqueOrThrow({
      where: { id: this.sessions.currentProfileId },
      include: { aliases: { orderBy: [{ aliasType: 'asc' }, { normalizedValue: 'asc' }] } },
    });
  }

  public async update(input: UpdateProfileInput, context: RequestAuditContext) {
    if (input.timezone) this.assertTimezone(input.timezone);
    const before = await this.get();
    const updateData: {
      displayName?: string;
      timezone?: string;
      workdayHours?: number;
      version: { increment: number };
    } = {
      version: { increment: 1 },
    };
    if (input.displayName !== undefined) updateData.displayName = input.displayName;
    if (input.timezone !== undefined) updateData.timezone = input.timezone;
    if (input.workdayHours !== undefined) updateData.workdayHours = input.workdayHours;
    const updated = await this.prisma.userProfile.updateMany({
      where: { id: this.sessions.currentProfileId, version: input.version },
      data: updateData,
    });
    if (updated.count !== 1) {
      throw new DomainError(errorCodes.versionConflict, '个人设置已被其他页面修改，请刷新后重试', {
        httpStatus: 409,
        suggestedAction: 'refresh',
      });
    }
    const after = await this.get();
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'profile.updated',
      targetType: 'user_profile',
      targetId: this.sessions.currentProfileId,
      correlationId: context.correlationId,
      outcome: 'succeeded',
      before: {
        version: before.version,
        displayName: before.displayName,
        timezone: before.timezone,
        workdayHours: before.workdayHours,
      },
      after: {
        version: after.version,
        displayName: after.displayName,
        timezone: after.timezone,
        workdayHours: after.workdayHours,
      },
      clientSessionHash: this.security.sessionHash(context.sessionId),
    });
    return after;
  }

  public async addAlias(input: AddAliasInput, context: RequestAuditContext) {
    const normalizedValue = this.normalizeAlias(input.aliasType, input.value);
    const alias = await this.prisma.identityAlias.create({
      data: {
        id: newId(),
        profileId: this.sessions.currentProfileId,
        aliasType: input.aliasType,
        value: input.value.trim(),
        normalizedValue,
        source: input.source,
        enabled: input.enabled,
        verifiedAt: input.source === 'user' ? new Date() : null,
      },
    });
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'identity_alias.created',
      targetType: 'identity_alias',
      targetId: alias.id,
      correlationId: context.correlationId,
      outcome: 'succeeded',
      after: {
        aliasType: alias.aliasType,
        normalizedValue: alias.normalizedValue,
        enabled: alias.enabled,
        source: alias.source,
      },
      clientSessionHash: this.security.sessionHash(context.sessionId),
    });
    return alias;
  }

  public async setAliasEnabled(aliasId: string, enabled: boolean, context: RequestAuditContext) {
    const before = await this.prisma.identityAlias.findFirst({
      where: { id: aliasId, profileId: this.sessions.currentProfileId },
    });
    if (!before) throw new DomainError(errorCodes.notFound, '身份别名不存在', { httpStatus: 404 });
    const after = await this.prisma.identityAlias.update({
      where: { id: aliasId },
      data: {
        enabled,
        verifiedAt: enabled ? (before.verifiedAt ?? new Date()) : before.verifiedAt,
      },
    });
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: enabled ? 'identity_alias.enabled' : 'identity_alias.disabled',
      targetType: 'identity_alias',
      targetId: aliasId,
      correlationId: context.correlationId,
      outcome: 'succeeded',
      before: { enabled: before.enabled },
      after: { enabled: after.enabled },
      clientSessionHash: this.security.sessionHash(context.sessionId),
    });
    return after;
  }

  private assertTimezone(timezone: string): void {
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format();
    } catch {
      throw new DomainError('TIMEZONE_INVALID', '时区不是有效的 IANA 标识', { httpStatus: 422 });
    }
  }

  private normalizeAlias(type: AddAliasInput['aliasType'], value: string): string {
    const normalized = value.trim().normalize('NFKC');
    return type === 'git_email' || type.endsWith('_username') || type.startsWith('jira_')
      ? normalized.toLowerCase()
      : normalized;
  }
}
