import { Injectable } from '@nestjs/common';

export type IntegrationType = 'gitlab' | 'jira' | 'dingtalk_log' | 'dingtalk_robot' | 'ai';

export interface ProbeTarget {
  id: string;
  type: IntegrationType;
  baseUrl: string | null;
  config: Record<string, unknown>;
  credential: Record<string, string> | null;
}

export interface ProbeResult {
  healthy: boolean;
  status: 'healthy' | 'degraded' | 'invalid' | 'configuration_required';
  identity?: Record<string, string | number | null>;
  capabilities: Record<string, unknown>;
  errorCode?: string;
  message?: string;
}

export interface IntegrationProbe {
  type: IntegrationType;
  probe(target: ProbeTarget): Promise<ProbeResult>;
}

@Injectable()
export class IntegrationProbeRegistry {
  private readonly probes = new Map<IntegrationType, IntegrationProbe>();

  public register(probe: IntegrationProbe): void {
    if (this.probes.has(probe.type)) throw new Error(`集成探测器重复注册：${probe.type}`);
    this.probes.set(probe.type, probe);
  }

  public async probe(target: ProbeTarget): Promise<ProbeResult> {
    const probe = this.probes.get(target.type);
    if (!probe) {
      return {
        healthy: false,
        status: 'configuration_required',
        capabilities: { adapterRegistered: false },
        errorCode: 'CAPABILITY_PROBE_NOT_REGISTERED',
        message: '对应平台适配器尚未完成能力探测注册',
      };
    }
    return probe.probe(target);
  }
}
