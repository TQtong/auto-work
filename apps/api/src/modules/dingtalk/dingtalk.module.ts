import { Module } from '@nestjs/common';
import { DingTalkLogClient } from './dingtalk-log.client.js';
import { DingTalkLogProbeService } from './dingtalk-log-probe.service.js';
import { DingTalkRobotClient } from './dingtalk-robot.client.js';
import { DingTalkRobotProbeService } from './dingtalk-robot-probe.service.js';

@Module({
  providers: [
    DingTalkLogClient,
    DingTalkLogProbeService,
    DingTalkRobotClient,
    DingTalkRobotProbeService,
  ],
  exports: [DingTalkLogClient, DingTalkRobotClient],
})
export class DingTalkModule {}
