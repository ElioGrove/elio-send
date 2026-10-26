# elio-send

一个部署在 Cloudflare Workers 上的临时文本传输工具。

打开接收页面后，页面会生成一个二维码；手机扫码进入发送页面，输入文本后会通过 WebSocket 实时发送回接收页面。适合在电脑和手机之间临时传输一小段文字、链接、验证码或命令。

## 功能

- 接收端生成一次性会话二维码
- 发送端扫码后输入文本
- 通过 Cloudflare Durable Objects 维持同一个会话的 WebSocket 连接
- 文本在接收页面显示 60 秒后自动清除
- 不需要登录，不需要数据库

## 数据安全说明

这个仓库是公开仓库，代码中不包含私钥、Token 或任何需要保密的配置。

传输的数据只通过当前会话的 WebSocket 做实时中转，不写入数据库，也不会保存到仓库或静态文件中。Durable Object 只负责把同一个会话中的发送端和接收端连接起来；当前实现没有把用户发送的文本持久化存储。

需要注意：这个工具适合临时传输普通文本，不建议发送长期敏感信息、密码、私钥、身份证件等高敏感数据。二维码链接里包含会话 ID，拿到链接的人可以向该接收端发送文本，因此不要把二维码或链接公开分享。

接收端使用独立的随机凭证；会话 ID 是该凭证的 SHA-256 摘要。二维码只包含会话 ID，不能用于建立接收连接。接收凭证只保留在接收页面内存中，通过 WebSocket 子协议传递，不进入 URL、二维码或持久化存储。浏览器恢复后台页面时会按实际时间检查 60 秒清除期限；已复制的剪贴板内容仍由用户自行管理。

服务端限制每个角色在一个会话内最多 64 个连接，每个连接每 10 秒最多 30 条入站消息；超大文本帧和二进制帧会在 JSON 解析前拒绝。这些限制用于抑制滥用，不代表公网接口已具备全局/IP 级限流。会话当前没有服务端固定有效期。

## 技术栈

- Cloudflare Workers
- Cloudflare Durable Objects
- Worker static assets
- Browser WebSocket API

## 本地开发

使用 Node.js 24.22.1（`.nvmrc`）或 `package.json` 中支持的安全补丁版本。2026-10-21 的 Node.js 安全更新影响本地工具链；生产 Worker 使用 Cloudflare workerd。

```bash
nvm install
nvm use
npm ci
npm run dev
```

打开 `http://localhost:8787`。

## 部署

```bash
npm ci
npm run deploy
```

Cloudflare Workers Git 集成建议配置：

- Build command: `npm ci`
- Deploy command: `npm run deploy`
- Root directory: 仓库根目录

Workers Builds 支持读取 `.nvmrc`。若 Dashboard 设置了 `NODE_VERSION`，请同步设为 `24.22.1`，避免覆盖仓库的版本选择。

计划使用域名：`send.thus.chat`

## 验证

```bash
npm run check
npm test
npm audit
npm run deploy -- --dry-run --outdir dist
```

`npm test` 包含真实 Workers/Durable Objects 运行时测试，以及前端会话竞态、消息确认和过期清除的回归测试。测试使用本地资源，不访问生产 Durable Objects。

鉴权升级发布后，已打开的旧版接收页面需要刷新以获得独立接收凭证。

<!-- cloudflare-git-config:start -->
## Cloudflare Git 集成建议配置

核对日期：2026-10-26。

使用 **Cloudflare Workers Builds / GitHub**，连接 `ElioGrove/elio-send`。

| 配置项 | 建议值 |
| --- | --- |
| Worker 名称 | `elio-send` |
| 生产分支 | `main` |
| 根目录 | `/` |
| 配置文件 | `wrangler.jsonc`（由部署脚本选择） |
| 构建命令 | `npm ci` |
| 部署命令 | `npm run deploy` |
| 启用预览构建 | 关闭；传输会话位于生产 Durable Objects |
| 预览命令 | 留空/不适用（预览构建关闭） |
| 构建监视路径 | 包含 `*`，排除项留空 |
| 输出目录 | 无需填写，由 Wrangler/框架配置管理 |

构建环境使用 `NODE_VERSION=24.22.1`；如有 package-lock.json，保留自动依赖安装。

无需额外 Secret。保留 `ASSETS` 和 `SESSIONS` → `TransferSession`，现有 namespace `874796a7200b414cb33b24b9944b25c4` 及 migration `v1` 不变。保留生产自定义域名。

构建变量与运行时变量分开配置。Secrets 仅保存在 Cloudflare 的运行时密钥设置，不能提交值到 Git。Workers Builds 使用现有构建令牌；不需要把 Cloudflare API token 写入 README 或仓库。原地更名后保留资源 ID，不删除再创建数据资源。

部署验证：推送 main 后，在 Worker → Deployments / Build history 找到相同提交 SHA，确认构建与发布成功；再验证自定义域名和必要的鉴权。空提交命令：`git commit --allow-empty -m "chore: verify Cloudflare Git deployment"`，然后 `git push origin main`。若未连接 Git 仓库，空提交不会触发部署，需先在 Settings → Builds 完成连接。

参考：[Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)。

<!-- cloudflare-git-config:end -->
