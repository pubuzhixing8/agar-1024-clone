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
