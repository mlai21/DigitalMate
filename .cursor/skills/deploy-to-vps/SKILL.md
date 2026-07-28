---
name: deploy-to-vps
description: Use when deploying DigitalMate to the production VPS, syncing code to the cloud, rebuilding containers, or diagnosing why ssh to the server drops instantly or the box becomes unresponsive during a build.
---

# 部署到生产 VPS

## 一句话

跑 `npm run deploy`。它会自己处理代理绕行、增量同步、限额构建和健康校验。不要手工 `scp` + `docker compose up -d --build`——下面每条“坑”都是那样踩出来的。

## 生产环境事实（不要凭记忆猜）

| 项 | 值 |
|---|---|
| 域名 | `ginkgo.xin`（Caddy 独占 80/443） |
| 服务器 IP | `47.88.93.94` |
| 登录 | `ecs-user@47.88.93.94`，密钥 `api-key-platform-demo.pem`，**不是 root** |
| 部署目录 | `/home/ecs-user/digitalmate` |
| 规格 | 2 vCPU / 3.5 GB RAM / 40 GB 盘（磁盘比内存更紧） |
| 容器 | `caddy` `postgres` `web` `agent`，均 `restart: unless-stopped` |
| 部署方式 | 从本地同步文件后在服务器上构建。**服务器上没有 git，也没有 rsync** |
| 部署标记 | `/home/ecs-user/digitalmate/.deployed-commit`，脚本用它算增量 |

`~/.ssh/config` 里的 `ecs-sh`（`47.102.126.206`）**不是这台机器**，是另一台无关主机。查线上问题时别对着它敲。

## 五个反复咬人的坑

**一、ssh 秒断 = 本地代理，不是服务器。** Clash Verge 跑 TUN 模式且持久化为**全局模式**，所有流量都进代理，而节点封了 22 端口，表现为 `Connection closed by 47.88.93.94 port 22`。基于规则的绕行没用，因为全局模式下规则根本不参与匹配，而且应用会不断把模式重置回 global。唯一稳的办法是在 TUN 层排除这个 IP（`tun.route-exclude-address`），这样它不进代理，任何模式都直连。脚本每次运行都会检查并补上。另外 `verge.yaml` 里 `auto_close_connection: true` 会在配置重载时掐掉所有在途连接，所以长命令可能断在中途——重试即可。

**二、ssh banner 超时 ≠ 秒断。** `Connection timed out during banner exchange` 说明服务器内存被压住、sshd 来不及握手。这时不要改代理，去看构建。

**三、构建堆上限必须小于物理内存。** `Dockerfile` 的 `NODE_HEAP_MB`（默认 2048）不要在这台机器上调高。曾经写死 `--max-old-space-size=4096`，Node 在额度用尽前不认真回收，整机颠簸 40 分钟、站点全挂。系统 `vm.swappiness` 也从 0 调成了 10（`/etc/sysctl.d/99-digitalmate-memory.conf`）：0 会让内核宁可碾碎页缓存也不用那 8 GB swap，反而更容易假死。

**四、构建期不要停服务。** 用 `docker compose build` 先构建、成功后再 `up -d`。直接 `up -d --build` 会在构建失败时留下停机窗口。

**五、macOS 打包会偷偷塞 AppleDouble。** 用 `tar` 传文件必须带 `COPYFILE_DISABLE=1`，否则服务器上会多出一堆 `._xxx.ts` 垃圾（现在 `src/` 下还残留 26 个，是历史遗留）。

## 常规流程

```bash
npm run deploy:check   # 只做代理绕行 + 可达性 + 状态检查，不改任何东西
npm run deploy         # 增量同步 → 构建 → 切换容器 → 健康校验 → 记录标记
npm run deploy -- --no-build   # 只同步，不重建
npm run deploy -- --all        # 忽略标记，同步全部部署路径
npm run deploy -- --dirty      # 连未提交改动一起部署（默认只部署已提交内容）
```

默认只部署已提交的内容。仓库里可能有并行进行的工作，未提交改动不会被顺手带上线；确实要带就显式加 `--dirty`。

部署完成后必须确认三件事，脚本会打印前两项：站点返回 200；四个容器都 `Up`；改动的文件在容器内指纹一致，例如

```bash
ssh -i api-key-platform-demo.pem ecs-user@47.88.93.94 \
  'sudo docker exec digitalmate-agent-1 sha1sum src/server/channels/runtime/agent-turn.ts'
```

跟本地 `shasum` 比对。只改源码不重建镜像是**不会生效**的——容器跑的是镜像里烘进去的副本。

## 出问题时

站点 502 或容器反复重启，先看日志：`sudo docker logs --tail 50 digitalmate-web-1`。要回滚就用上一个镜像：`sudo docker images` 找到前一个 `digitalmate-web`/`digitalmate-agent` 的镜像 ID，`docker tag` 回 `latest` 后 `up -d`。整机失联且 ssh 完全进不去时，只能到阿里云控制台强制重启；容器会自动用旧镜像拉起来，服务先恢复，再排查。

磁盘长期在 80% 上下，每个镜像 1.3 GB，构建几次就会顶到红线。定期 `sudo docker image prune -f` 清悬空镜像。

## 安全遗留

`api-key-platform-demo.pem` 是能登生产服务器的私钥，目前被 git 跟踪在仓库根目录。推到 GitHub 就等于公开服务器凭据，应尽快从版本库移除并换密钥。在那之前，不要把这个仓库设为公开，也不要把它的 tar 包发给别人。
