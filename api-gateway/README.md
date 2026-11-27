# 自有 API 域名入口

这个 Cloudflare Pages 项目只将请求通过 Service binding `AUTH` 转发给现有的 `icemen-auth` Worker。它不保存口令、GitHub 令牌或业务数据，不向公开的 `workers.dev` 地址发起请求。

计划入口为 `https://api.icemen.bond`。主网站仍由 GitHub Pages 托管，域名注册和 DNS 仍保留在阿里云；不需要迁移整个域名的 NS。

## 配置与部署

在本目录运行 Wrangler。配置文件中的 `pages_build_output_dir` 和 `services` 分别指定静态目录和现有 Worker；不要修改原 Worker 的名称、Durable Object 绑定、迁移记录或存储。

```sh
wrangler pages project create icemen-api-gateway --production-branch main
wrangler pages deploy public --project-name icemen-api-gateway --branch main
```

首次操作需要登录账号具有 `pages:write` 权限。若现有 Wrangler 授权不足，通过 Wrangler 官方登录页增加此权限，保留已有的 `user:read`、`account:read`、`workers_scripts:write` 等所需权限。不要读取凭据文件、打印令牌或把令牌复制到聊天与代码中。

如果项目已经存在，先检查是否属于本工作台，再部署；不要删除或覆盖其他项目。项目的真实 `*.pages.dev` 域名以 Cloudflare 创建结果为准，名称冲突时可能含额外后缀。

`public/_worker.js` 是 Pages Advanced mode 服务端入口。所有方法、请求体、Authorization 和 Origin 都原样送到已有 Worker；业务路由、口令校验、CORS 和数据持久化继续由该 Worker 处理。绑定缺失或内部调用失败时返回不缓存的 503 JSON，不重试公开网络地址，也不返回异常详情。

## 绑定阿里云 DNS 下的子域名

1. 在 Cloudflare 的 **Workers & Pages → icemen-api-gateway → Custom domains → Set up a custom domain** 中，先关联 `api.icemen.bond`。
2. 在阿里云 **云解析 DNS → icemen.bond → 添加记录** 中新增记录：记录类型 `CNAME`，主机记录 `api`，记录值为此 Pages 项目的真实 `*.pages.dev` 域名；不要包含 `https://` 或路径。保留已有根域名 A 记录和 `www` 记录。
3. 等待 Cloudflare 显示域名已激活、证书签发完成。
4. 确认生产环境 Service binding `AUTH` 指向 `icemen-auth`。如在控制台改动绑定，重新部署后才生效。不要给 API 增加 Cloudflare Access 登录拦截，现有工作台已处理口令登录。

先关联 Pages 域名，再添加 CNAME。只添加 CNAME 而未关联 Pages 项目会产生错误。当前 Wrangler 没有专用的 Pages 域名关联子命令；可以使用已登录控制台，也可以在已获 `pages:write` 授权后使用下面的官方 API 辅助脚本。

### 通过受限 API 辅助脚本关联域名

`scripts/domain.mjs` 通过官方文档支持的 `wrangler auth token --json` 获取当前已授权 OAuth 的短期访问上下文；子进程输出只进入内存管道，不打印、不保存，且关闭 Wrangler 磁盘日志与遥测。脚本本身不读取凭据文件，不复制或迁移存储中的令牌。

将任务专用环境变量 `ICEMEN_WRANGLER_JS` 设为已安装 Wrangler 的 JavaScript 入口绝对路径后，在本目录执行：

```sh
node scripts/domain.mjs status
node scripts/domain.mjs attach
```

脚本固定使用此工作台的 Cloudflare 账号、`icemen-api-gateway` 项目和 `api.icemen.bond` 域名，只能读取 Pages 域名列表、在未关联时新增这一个域名。它不接受其他账号、项目、域名或 API 地址，也不跟随重定向；只输出固定域名、域名状态和验证状态。Cloudflare 的原始错误正文、验证 TXT 内容、凭据和子进程诊断都不会输出。

`attach` 不修改 DNS。关联完成后，仍需在阿里云添加上述单条 CNAME，并完成健康检查。此脚本不会自动修改主网站 API 配置。

## 验证后切换

在修改主网站 `site-config.json` 之前，验证新入口：

- `GET https://api.icemen.bond/api/health` 返回 200 和 `{"ok":true}`。
- 携带 `Origin: https://icemen.bond` 的请求返回对应 `Access-Control-Allow-Origin`；登录 POST 的 OPTIONS 预检返回 204。
- 未携带登录令牌的 `GET /api/session` 返回正常 401 JSON，而不是 HTML、证书错误或 Cloudflare 登录页。
- 手机上使用普通网络也能访问健康检查。

全部通过后，将 `site-config.json` 的 `authApi` 改为 `https://api.icemen.bond` 并发布主网站。不要提前切换到尚未就绪的域名。

现有 Worker 及其 Durable Object 保持不变，因此无需重置口令、迁移业务数据或重新连接 GitHub。旧 `workers.dev` 地址可以暂时保留以便回退，但前端不应自动重试它，以免重放保存、上传等请求。

## 本地测试

```sh
node --test tests/gateway.test.mjs tests/domain.test.mjs
```

测试使用内存绑定及模拟子进程/API，验证请求体和鉴权头原样转发、响应/CORS/错误状态不变、绑定失败时安全返回、域名 API 的固定范围与不泄露凭据。测试不会获取真实令牌或调用生产 API。

## 官方参考

- [Pages 自定义子域名与外部 DNS](https://developers.cloudflare.com/pages/configuration/custom-domains/#add-a-custom-subdomain)
- [Pages Service bindings](https://developers.cloudflare.com/pages/functions/bindings/#service-bindings)
- [Pages Wrangler 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/#service-bindings)
- [Pages Advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)
- [Direct Upload 对 `_worker.js` 的支持](https://developers.cloudflare.com/pages/get-started/direct-upload/#functions)
- [Wrangler 官方 `auth token` 命令](https://developers.cloudflare.com/workers/wrangler/commands/general/#auth-token)
- [Pages 自定义域名关联 API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/create/)
