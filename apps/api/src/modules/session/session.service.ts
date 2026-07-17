import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { newId } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

const execFileAsync = promisify(execFile);

@Injectable()
export class SessionService implements OnApplicationBootstrap {
  private profileId = '';
  private sid = '';
  private displayName = '';

  public constructor(private readonly prisma: PrismaService) {}

  public async onApplicationBootstrap(): Promise<void> {
    const identity = await this.readWindowsIdentity();
    this.sid = identity.sid;
    this.displayName = identity.displayName;

    const existing = await this.prisma.userProfile.findUnique({
      where: { windowsSid: identity.sid },
    });
    if (existing) {
      this.profileId = existing.id;
      if (existing.displayName !== identity.displayName) {
        await this.prisma.userProfile.update({
          where: { id: existing.id },
          data: { displayName: identity.displayName, version: { increment: 1 } },
        });
      }
      return;
    }

    const created = await this.prisma.userProfile.create({
      data: {
        id: newId(),
        windowsSid: identity.sid,
        displayName: identity.displayName,
        timezone: 'Asia/Shanghai',
        workdayHours: 8,
      },
    });
    this.profileId = created.id;
  }

  public get currentProfileId(): string {
    if (!this.profileId) throw new Error('本机用户身份尚未初始化');
    return this.profileId;
  }

  public describe(csrfToken: string): {
    profileId: string;
    windowsSidSummary: string;
    displayName: string;
    timezone: string;
    csrfToken: string;
  } {
    return {
      profileId: this.currentProfileId,
      windowsSidSummary: `${this.sid.slice(0, 6)}…${this.sid.slice(-4)}`,
      displayName: this.displayName,
      timezone: 'Asia/Shanghai',
      csrfToken,
    };
  }

  private async readWindowsIdentity(): Promise<{ sid: string; displayName: string }> {
    const info = userInfo();
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
          windowsHide: true,
          timeout: 5_000,
          maxBuffer: 16 * 1024,
        });
        const fields = stdout.trim().replace(/^"|"$/g, '').split('","');
        const sid = fields.at(-1);
        if (sid && /^S-\d-(?:\d+-)+\d+$/.test(sid)) {
          return { sid, displayName: info.username };
        }
      } catch {
        // 受限环境可能禁用 whoami；回退标识只用于启动诊断，正式 Windows 部署应能取得 SID。
      }
    }
    const fallback = `${process.platform}:${info.username}:${info.homedir}`;
    return {
      sid: `fallback-${createHash('sha256').update(fallback).digest('hex')}`,
      displayName: info.username,
    };
  }
}
