# ICEMEN 全局口令 API

这是 GitHub Pages 导航页的口令服务。一个 SQLite Durable Object 保存全站唯一的 PBKDF2 盐、摘要、口令版本和随机会话签名密钥。浏览器仅获得有时效的 token；服务没有返回口令摘要的接口。

## 发布

本目录保存口令服务源码，已部署到 Cloudflare Workers。更新服务时使用：

```powershell
cd auth-service
npm install
npx wrangler login
npx wrangler whoami
npx wrangler deploy
```

`wrangler login` 打开 Cloudflare OAuth 授权页面。若不能自动打开，可用 `npx wrangler login --browser=false` 查看授权地址，由账号本人完成授权。部署完成后，Wrangler 会输出 `https://icemen-auth.<账户子域>.workers.dev`，将该地址设置为前端 API 根地址。

`wrangler.jsonc` 已配置 `AUTH_STATE` 绑定和 `new_sqlite_classes` 首次迁移，不需要手动创建 KV 或 D1。首次初始化所需的认证参数仅保存在 Cloudflare，不写入本仓库。

初始配置仅在 Durable Object 没有存储状态时使用。部署前需要在 Cloudflare 配置 `INITIAL_PASSWORD_SALT` 和 `INITIAL_PASSWORD_HASH` 两项服务端参数；不要将值提交到仓库。已有对象中的口令不受这些初始化参数变更影响。请保持 Worker 名称、Durable Object 类名、绑定和对象名称稳定，以继续使用同一个存储。

生产站点必须通过 HTTPS 调用服务；前端白名单为 `https://icemen.bond`。本机调试额外允许 `http://127.0.0.1:8778`，不包含其他地址或端口。

## API

所有响应均为 JSON，带 `Cache-Control: no-store`。所有 POST 必须带白名单 Origin 和 `Content-Type: application/json`；请求体最多 4096 字节。错误结构为 `{ "error": "code", "message": "中文提示" }`。

| 路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /api/health` | 无认证 | `{ "ok": true }` |
| `POST /api/login` | `{ "password": "用户输入" }` | `{ "token": "...", "expiresAt": 毫秒时间戳 }` |
| `GET /api/session` | `Authorization: Bearer <token>` | `{ "ok": true, "expiresAt": 毫秒时间戳 }` |
| `POST /api/password` | Bearer 加 `{ "currentPassword": "用户输入", "newPassword": "用户输入" }` | `{ "ok": true, "requiresLogin": true }` |

登录会话有效期为 8 小时，服务校验 HMAC、到期时间和口令版本。改口令要求正确的当前口令，以及与当前不同的 8–64 字符新口令，不能全为空白。首尾空格不会被自动去掉。

口令保存成功后，同时更换随机盐与签名密钥、递增版本，使所有设备上的旧会话失效。前端收到成功后清除已有 token，并要求重新登录；其他已打开页面下一次校验 session 时也会失效。当前口令输入错误返回 403；过期或无效 Bearer 返回 401，便于前端区分。

同一个 Cloudflare 来源 IP 在 10 分钟窗口内失败 10 次后，后续验证返回 429 和 `Retry-After`。限制表保存在对象内存中，每次验证清理过期项并限制最多 10,000 项；实例回收会重置这些临时计数，口令和会话状态仍由 Durable Object 存储保留。

## 验证与费用条件

主任务已在目录之外运行 Node mock Durable Object 端点测试，覆盖认证、改口令、全部旧会话撤销、存储失败保护、对象重启保留新口令、并发更新、CORS、限流和请求长度限制。真实 Cloudflare 部署与网络测试须在发布后完成。

Cloudflare 官方资料确认 Workers Free 支持 SQLite Durable Objects；免费额度包含 Durable Object 请求 100,000 次/日、SQLite 读取 500 万行/日、写入 100,000 行/日及总计 5 GB 存储。实际使用仍受平台免费计划额度约束。

- [Durable Objects 价格与免费计划](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Wrangler OAuth 登录](https://developers.cloudflare.com/workers/wrangler/commands/general/#login)
- [Durable Objects 入门及部署](https://developers.cloudflare.com/durable-objects/get-started/)
- [Durable Object 存储迁移配置](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
