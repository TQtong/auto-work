import { Injectable } from '@nestjs/common';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

export type GitLabCachedResource =
  'branches' | 'commits' | 'merge-requests' | 'pipelines' | 'tags' | 'releases' | 'members';

@Injectable()
export class GitLabReadService {
  public constructor(private readonly prisma: PrismaService) {}

  public async list(
    connectionId: string,
    projectId: string,
    resource: GitLabCachedResource,
    offset: number,
    limit: number,
  ) {
    const project = await this.prisma.gitLabProject.findFirst({
      where: { id: projectId, connectionId, stale: false },
      select: { id: true },
    });
    if (!project) {
      throw new DomainError(errorCodes.notFound, 'GitLab 缓存项目不存在', { httpStatus: 404 });
    }
    const skip = offset;
    switch (resource) {
      case 'branches': {
        const where = { gitlabProjectId: projectId, stale: false };
        const [total, rows] = await this.prisma.$transaction([
          this.prisma.gitLabBranch.count({ where }),
          this.prisma.gitLabBranch.findMany({
            where,
            orderBy: { name: 'asc' },
            skip,
            take: limit,
          }),
        ]);
        return { total, items: rows.map((row) => this.serialize(row)) };
      }
      case 'commits': {
        const where = { gitlabProjectId: projectId };
        const [total, rows] = await this.prisma.$transaction([
          this.prisma.gitLabCommit.count({ where }),
          this.prisma.gitLabCommit.findMany({
            where,
            orderBy: { committedAt: 'desc' },
            skip,
            take: limit,
          }),
        ]);
        return { total, items: rows.map((row) => this.serialize(row)) };
      }
      case 'merge-requests': {
        const where = { gitlabProjectId: projectId };
        const [total, rows] = await this.prisma.$transaction([
          this.prisma.gitLabMergeRequest.count({ where }),
          this.prisma.gitLabMergeRequest.findMany({
            where,
            orderBy: { updatedExternalAt: 'desc' },
            skip,
            take: limit,
          }),
        ]);
        return {
          total,
          items: rows.map((row) => ({
            ...this.serialize(row),
            author: this.parseJson(row.authorJson),
            assignees: this.parseJson(row.assigneesJson),
            authorJson: undefined,
            assigneesJson: undefined,
          })),
        };
      }
      case 'pipelines': {
        const where = { gitlabProjectId: projectId };
        const [total, rows] = await this.prisma.$transaction([
          this.prisma.gitLabPipeline.count({ where }),
          this.prisma.gitLabPipeline.findMany({
            where,
            orderBy: { updatedExternalAt: 'desc' },
            skip,
            take: limit,
          }),
        ]);
        return { total, items: rows.map((row) => this.serialize(row)) };
      }
      case 'tags': {
        const where = { gitlabProjectId: projectId, stale: false };
        const [total, rows] = await this.prisma.$transaction([
          this.prisma.gitLabTag.count({ where }),
          this.prisma.gitLabTag.findMany({
            where,
            orderBy: [{ createdExternalAt: 'desc' }, { name: 'asc' }],
            skip,
            take: limit,
          }),
        ]);
        return { total, items: rows.map((row) => this.serialize(row)) };
      }
      case 'releases': {
        const where = { gitlabProjectId: projectId, stale: false };
        const [total, rows] = await this.prisma.$transaction([
          this.prisma.gitLabRelease.count({ where }),
          this.prisma.gitLabRelease.findMany({
            where,
            orderBy: { releasedAt: 'desc' },
            skip,
            take: limit,
          }),
        ]);
        return {
          total,
          items: rows.map((row) => ({
            ...this.serialize(row),
            assets: this.parseJson(row.assetsJson),
            assetsJson: undefined,
          })),
        };
      }
      case 'members': {
        const where = { gitlabProjectId: projectId, stale: false };
        const [total, rows] = await this.prisma.$transaction([
          this.prisma.gitLabProjectMember.count({ where }),
          this.prisma.gitLabProjectMember.findMany({
            where,
            orderBy: [{ accessLevel: 'desc' }, { username: 'asc' }],
            skip,
            take: limit,
          }),
        ]);
        return { total, items: rows.map((row) => this.serialize(row)) };
      }
    }
  }

  private serialize<T extends Record<string, unknown>>(row: T) {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value instanceof Date ? value.toISOString() : value,
      ]),
    );
  }

  private parseJson(value: string): unknown {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
}
