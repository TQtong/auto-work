#!/bin/sh
set -eu

# 每次启动先应用已签入的幂等迁移；失败时立即退出，绝不带着未知 schema 启动服务。
node /app/apps/api/scripts/prisma-cli.mjs migrate deploy

# exec 让 Node 接收容器停止信号，配合 tini 完成优雅退出和僵尸进程回收。
exec node /app/apps/api/dist/main.js
