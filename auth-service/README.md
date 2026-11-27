# ICEMEN 工作台服务

Cloudflare Workers 为 GitHub Pages 工作台提供统一口令、网站内文件上传、更新与删除，以及价格测算表和经营驾驶舱的数据云同步。一个 SQLite Durable Object 保存认证状态、GitHub 专用连接和各模块最新完整数据；浏览器使用有时效的 Bearer token 调用服务。

## 使用流程

### 连接仓库并上传、更新、删除文件

在工作台「设置 → GitHub 连接」创建并连接仓库专用的 **Fine-grained personal access token**：

- 账号与资源所有者：`icemen-wu`。
- **Repository access → Only select repositories → icemen-site**，仅选择此仓库。创建链接不能代替这一步手动选择。
- **Repository permissions → Contents: Read and write**。
- **Repository permissions → Actions: Read-only**。

将生成的令牌粘贴到工作台并点击「连接仓库」。服务固定操作 `icemen-wu/icemen-site` 的 `main` 分支；连接时验证仓库读取、Contents 写入及 Actions 读取权限，成功后才保存连接。令牌只存储在服务端，不写入前端配置或返回给浏览器。令牌过期、撤销或权限变化后，在相同设置位置更新连接。

连接完成后，点击文件工具栏的「上传文件」新增文件和导航入口，或点击文件旁「更新」替换原文件内容。新增文件进入 `files/`，`navigation.json` 与文件通过同一个 Git 提交发布。更新保留既有导航元数据，且只允许更新已配置的本站模块文件，不能覆盖首页、脚本或服务配置。

删除时点击文件旁「删除」或详情中的「删除文件」，核对名称和路径后点击「删除并发布」。文件与导航入口在同一个提交中移除；此操作不清除价格测算表的云端业务数据。网站没有回收站或撤销入口，操作前应下载备份；旧文件仍可通过 GitHub 提交历史找回。首页、脚本、服务及配置受保护，不开放删除。多个入口共用同一文件、目标不存在或不是普通文件时会停止删除，避免破坏其他入口或特殊 Git 对象。

文件保存成功和 GitHub Pages 发布成功分别显示。若发布失败，仓库中的文件仍已保存，应查看发布记录，而不是直接重复上传。

### 价格表全部版本云同步

价格表的「保存更新」先保留本机修改，再将当前工作区的 `app`、`initial` 和完整 `versions` 一起保存到云端，包含各版本备注、图片、月份数据和设置。业务数据存于 Durable Object，不提交到 GitHub；代码文件更新仍使用上传与发布流程。

首次启用时，必须先在保留最新全部版本数据的电脑和浏览器上核对内容，使用工作台口令登录同步，点击「保存更新」并确认同步成功。之后其他电脑再登录并加载云端。初次迁移前可使用价格表的「导出完整备份」另存完整数据。

打开价格表时会检查云端；页面已打开时每隔约 30 秒检查云端修订号，发现其他设备更新后提示「加载云端」。未点击「保存更新」的本机修改不会自动同步。存在未同步修改时不会直接用云端覆盖；手动加载前先保存完整本机备份，备份失败则停止替换。

云端版本冲突返回 `409 revision_conflict`，拒绝覆盖：先导出本机完整备份，再加载云端，手动合并需要保留的修改，最后重新保存。不执行字段或版本的自动合并。「恢复本机备份」只恢复当前浏览器，核对后再次「保存更新」才会同步。服务只保留最新完整数据，本机备份由当前浏览器的 IndexedDB 保存。

### 经营驾驶舱保存更新

在经营驾驶舱中「上传更新 Excel」后，点击顶部「保存更新」，看到云端保存成功提示后，其他电脑打开驾驶舱会自动加载这份数据。保存包含整份预算明细，筛选、搜索和当前展示的行数不会缩小保存范围。使用工作台同一个口令登录，无需单独配置 GitHub 令牌。

上传 Excel 和「恢复内置数据」先影响当前浏览器，再点击「保存更新」才会同步。登录或重新打开驾驶舱时会自动加载云端最新数据；页面已打开时也会定期检查，发现新修订后自动加载，无需点击按钮。本机内容与云端不同时，先保存完整本机备份，备份失败则停止替换。正在导入或保存时会暂停加载，完成后再检查。

未保存修改遇到其他电脑的新修订时，也会先备份再切换到最新数据。需要找回时点击「恢复本机备份」，核对后再点击「保存更新」发布；同一云端修订的重复检查不会再次替换刚导入或恢复的本机内容。保存发生版本冲突时，停止写入并自动备份、加载最新内容，不自动合并或再次提交本机修改。

驾驶舱数据使用独立存储空间，与价格测算表互不覆盖。业务数据保存不产生 GitHub 提交，也不需要重新发布 HTML；离线页面仍可本地读取 Excel，但云同步需要打开网站并登录。

## 部署与存储

```powershell
cd auth-service
npm install
npx wrangler login
npx wrangler whoami
npx wrangler deploy
```

OAuth 授权由账号本人完成。若无法自动打开授权页，可使用 `npx wrangler login --browser=false`。部署输出的 Worker 地址应与仓库根目录 `site-config.json` 的 `authApi` 一致。

`wrangler.jsonc` 已配置 `AUTH_STATE` 绑定与 SQLite Durable Object 迁移，无需手动创建 KV 或 D1。认证初始化参数在 Cloudflare 配置，不在仓库中保存任何实际口令、令牌或初始化密钥。已初始化对象中的口令独立于初始化参数；保持 Worker 名称、Durable Object 类名、绑定及对象名称稳定，才能继续使用原有认证、连接和数据。

生产白名单为 `https://icemen.bond`，本机调试额外允许 `http://127.0.0.1:8778`；其他来源或端口不在白名单。线上前端必须使用 HTTPS。

## API 约定

响应均为 JSON，带 `Cache-Control: no-store`。POST 必须使用白名单 Origin 与 `Content-Type: application/json`。除了健康检查和登录，以下接口都要求 `Authorization: Bearer <token>`。错误格式为 `{ "error": "code", "message": "中文提示" }`。

| 路径 | 请求 | 成功响应要点 |
|---|---|---|
| `GET /api/health` | 无认证 | `{ "ok": true }` |
| `POST /api/login` | `{ password }` | `{ token, expiresAt }`，到期值为毫秒时间戳 |
| `GET /api/session` | Bearer | `{ ok, expiresAt }` |
| `POST /api/password` | `{ currentPassword, newPassword }` | `{ ok, requiresLogin: true }` |
| `GET /api/github/status` | Bearer | `{ configured, repository, branch, connectedAt? }`，不含令牌 |
| `POST /api/github/connect` | `{ token }` | 连接状态，不含令牌 |
| `GET /api/files` | Bearer | `{ modules, headSha }`，来自当前仓库 |
| `POST /api/files/upload` | 见下文 | `{ ok, sha, module, mode, publishStatus }` |
| `POST /api/files/delete` | `{ moduleId, expectedHead, requestId, expectedPath? }` | `{ ok, sha, module, mode, publishStatus }`，`mode` 为 `delete` |
| `GET /api/publish-status?sha=<commit>` | Bearer | `{ status, sha, url }`；状态为 `pending/success/failure` |
| `GET /api/data/price-calculator` | Bearer | `{ exists, revision, updatedAt?, document? }` |
| `GET /api/data/price-calculator?metadata=1` | Bearer | 只返回存在状态、修订号和时间 |
| `POST /api/data/price-calculator` | `{ baseRevision, requestId, document }` | `{ ok, revision, updatedAt }` |
| `GET /api/data/operating-dashboard` | Bearer | `{ exists, revision, updatedAt?, document? }` |
| `GET /api/data/operating-dashboard?metadata=1` | Bearer | 只返回存在状态、修订号和时间 |
| `POST /api/data/operating-dashboard` | `{ baseRevision, requestId, document }` | `{ ok, revision, updatedAt }` |

### 长度与格式

普通 JSON 请求上限为 4096 字节；文件上传请求上限约为 14.1 MiB，原文件上限为 10 MiB；测算数据请求上限为 20 MiB，完整 `document` 上限为 19 MiB。限额会拒绝整个请求，不会删减图片或版本。

允许文件扩展名：`html htm pdf txt csv xlsx xls docx pptx zip png jpg jpeg webp gif`。文件名不得包含路径、控制字符或以点开头。新增接口将原文件名放入 `files/`；更新只接受与目标相同类型的文件，`htm/html`、`jpeg/jpg` 按同一类型处理。

上传请求公共字段为 `mode`（`create/update`）、`filename`、`contentBase64`、`expectedHead` 和 `requestId`。新增时发送 `name`、`description`、`category`；更新时发送 `moduleId` 并省略元数据字段，从而保留原导航名称、说明和分类。

删除请求必须发送 `moduleId`、`expectedHead`、`requestId`；可选的 `expectedPath` 必须与用户确认时的原导航路径完全一致，用于防止目标路径在操作期间改变。服务端仍从当前导航解析实际目标，不接受客户端任意指定删除路径。只允许删除导航中配置的安全普通文件，不允许首页、隐藏路径、脚本目录、服务目录或配置；共用文件返回 `409 shared_file`，目标不存在返回 `409 file_not_found`。文件删除与导航移除通过 Git tree 的 `sha: null` 和新的导航 blob 原子提交，分支引用更新禁止强推。

`document` 包含 `app`、`initial`（可为 `null`）及至少含一个版本的 `versions.items`。浏览器在上传前同步当前活动版本状态，服务按完整文档保存和校验。

经营驾驶舱的 `document` 为 `{ schemaVersion: 1, sourceName, rows }`，`rows` 保存全部预算明细，保留 Excel 行中的各字段。该接口同样采用 20 MiB 请求、19 MiB 文档上限及修订号并发检查；数据与测算表使用不同的存储键。

### 并发、重试与发布

文件上传、更新与删除使用 `expectedHead` 检查仓库版本；发生并发提交时返回 `409`，不强制覆盖分支。客户端应重新读取并核对目标后再提交。`requestId` 与请求内容绑定，超时后使用原请求重试可以恢复已经准备或完成的提交；改变请求内容必须生成新标识。仓库操作完成只说明提交已保存，Pages 状态需通过发布状态接口单独查询。删除重试复用相同请求标识；409 冲突后须刷新目标并重新确认。

测算数据使用 `baseRevision` 进行乐观并发检查；首存从 `0` 开始，成功后修订号递增。旧修订写入返回 `409 revision_conflict`。重试相同 `requestId` 与内容可以返回已完成结果；同一标识对应不同内容返回 `409 request_id_reused`。文档分块、校验摘要及当前修订指针在存储事务内一起更新，保存失败保留上一份完整数据。

### 会话与口令

会话有效期为 8 小时，校验 HMAC、到期时间和口令版本。修改口令要求正确的当前口令，以及不同于原口令的 8–64 字符新口令，不能全为空白；首尾空格不自动删除。

改口令成功后，更新盐、会话签名密钥及口令版本，使所有设备旧会话失效。导航和价格表同步均使用同一套登录。无效会话返回 `401`；修改口令时当前口令错误返回 `403`。

同一来源 IP 在 10 分钟内验证失败 10 次后返回 `429` 与 `Retry-After`。临时限流计数存于对象内存；对象持久存储保存口令、GitHub 连接和完整云端数据。

## 访问边界与维护

导航口令控制工作台入口；GitHub Pages 上独立静态文件的直接链接仍可访问。文件写入与删除、连接管理及云端测算数据读写需要有效登录。定期保留价格表导出的完整备份；浏览器备份与云端最新文档用途不同。

日常操作和手动导航配置见根目录 [导航配置说明](../导航配置说明.md)。开发验证应覆盖认证与口令撤销、上传同名冲突与幂等重试、删除路径保护与原子提交、Pages 发布失败反馈，以及测算数据完整往返、并发冲突与存储失败保留旧数据。真实服务与网站发布后再验证完整操作流程。

Cloudflare 使用额度以当前账户计划为准：

- [Durable Objects 价格与免费计划](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Wrangler OAuth 登录](https://developers.cloudflare.com/workers/wrangler/commands/general/#login)
- [Durable Object 存储迁移配置](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
