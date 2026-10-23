# 1024 吞噬大战 · Cloudflare 部署

游戏地址：<https://agar-1024-game.pubuzhixing.workers.dev/>

Cloudflare Worker 将所有请求（包括 Socket.IO WebSocket）转发到同一个 Container，因此所有玩家共享一张地图。容器 30 分钟无活动后可休眠；重启时地图和排行榜会重置。

## 重新部署

需要 Node.js 22+、正在运行的 Docker，以及已登录的 Wrangler：

```sh
cd cloudflare
npm ci
npm run deploy
```

Wrangler 会根据根目录的 Dockerfile 构建和推送镜像。部署命令结束后，Cloudflare 仍可能需要几分钟替换旧容器；检查线上页面后再通知玩家。

活动前可让两位玩家同时进入，确认能在同一局中看到彼此。Cloudflare Containers 会按运行资源计费；当前配置允许最多两台 `basic` 容器，但 Worker 只把玩家送入同一个命名实例。容器位置约束为亚太地区。

## 卡顿诊断

访问 `/__diag/summary?seconds=60` 获取最近 60 秒的服务端逐秒指标和最近的客户端报告；`seconds` 范围为 1–300。接口目前不鉴权，供内部压测使用。返回内容不包含昵称、聊天或恢复令牌。

`history` 中重点看 `tick`、`send`、`eventLoop` 的 p95/最大耗时，以及 `sentSnapshots`、`droppedSnapshots`、`maxQueuedPackets`、`maxBufferedBytes`、`rttP95Ms`、`cpuPercentOfCore`。`clients[].networkReports` 每秒记录连接的可写状态、队列、缓冲字节、输入间隔和应用层往返延迟；超时后 RTT 显示为 `null`，超时次数记在 `rttTimeouts`。`clients[].reports` 是每 5 秒一次的浏览器报告，含收到的更新数、绘制帧数、发送的移动输入数和最大间隔。`estimatedSnapshotBytes` 根据已发送快照的采样大小推算，不能当成实际网络发送字节数；WebSocket 缓冲字节也不包括代理或链路中的积压。真实浏览器开发者工具会打印 `[game-diagnostics]`；当前报告可在 `window.__agarDiagnostics` 查看。

在仓库根目录模拟本地或线上连接：`node scripts/diag-load.js <地址> <玩家数> <持续秒数>`，例如 `node scripts/diag-load.js https://agar-1024-game.pubuzhixing.workers.dev 50 20`。脚本发送与游戏类似的 20 次/秒移动输入，但不执行浏览器绘制；绘制指标需要用真实浏览器报告判断。

游戏状态快照使用 Socket.IO 的 `volatile` 发送；当连接不可写时，该帧会丢弃，下一帧继续提供完整状态。欢迎、排行榜、聊天等事件保持原有发送方式。Cloudflare 的结果用于对照，不能直接代表 `1024.pingcode.live:3000` 原服务器的负载。
