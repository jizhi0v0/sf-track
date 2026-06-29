# 顺丰快递轨迹查询

Rust 后端代理顺丰开放平台，React 页面只提交运单号和手机号后四位。顺丰 `PARTNER_ID` / `CHECK_WORD` 只从服务端环境变量读取，不会进入前端构建产物。

## 本地启动

```bash
cp .env.example .env
# 编辑 .env：顾客编码填 SF_PARTNER_ID，校验码填 SF_CHECK_WORD

cd frontend
npm install
npm run build

cd ..
cargo run
```

打开：

```text
http://localhost:3000/sf-track?token=dev-token-change-me
```

首次访问会换成 HttpOnly session cookie，并重定向到不带 token 的 `/sf-track`。

### 前端演示数据

直接运行 Vite 开发服务器时，页面会自动填入 3 个演示运单，方便截图和调 UI：

```bash
cd frontend
npm run dev
```

打开 `http://localhost:5173/sf-track` 即可看到假物流轨迹。该演示数据只在 `import.meta.env.DEV` 为真时启用，生产构建仍保持真实查询流程。

## 测试

```bash
cargo test
cd frontend && npm run build
```

## curl 示例

先用授权 token 换 session cookie：

```bash
curl -i -c /tmp/sf-track.cookie -L \
  'http://localhost:3000/sf-track?token=dev-token-change-me'
```

再查询轨迹：

```bash
curl -i -b /tmp/sf-track.cookie \
  -H 'Content-Type: application/json' \
  -d '{"waybillNo":"SF0213844341359","phoneLast4":"1234"}' \
  http://localhost:3000/api/sf/track
```

## 环境变量

见 `.env.example`。

`TRACKING_ACCESS_TOKENS` 格式 `token:过期时间:最大次数`，逗号分隔多个：

```text
token1:2026-12-31T23:59:59Z:20,token2:2026-07-31T23:59:59Z:5
```

仅 Cloudflare Worker 推送版支持把过期时间或次数写成 `*` 表示不限制（如 `token:*:*` 永久不限次、`token:*:20` 不过期但限 20 次）。Rust 本地版暂不支持 `*`，必须填具体时间和正整数次数。

## 安全点

- 顺丰密钥只在 Rust 服务端读取，前端和浏览器请求不会包含密钥。
- URL token 只用于换取 HttpOnly session cookie，不等同于顺丰密钥。
- token 支持过期时间和最大查询次数，成功、空结果、上游失败都会消耗查询次数。
- `/sf-track?token=xxx` 会 303 重定向到 `/sf-track`，降低 token 留在地址栏、历史、Referer 的概率。
- 不记录完整手机号后四位，也不把顺丰原始响应写入日志。
- 返回前会脱敏手机号、座机号、电话字段和详细地址；`acceptAddress` 默认保留到市级。
- 内存频控包含 IP 每分钟 10 次、token 每分钟 5 次、同一 token/IP 对同一运单号连续业务失败 5 次锁定 30 分钟。
- 当前频控和 token 使用次数是进程内存版本，生产多实例或需重启保留状态时应换成 Redis 或数据库。

## Cloudflare Worker 推送版

`cf-worker/` 是可部署到 Cloudflare Workers 的版本：它可以托管 `frontend/dist`，提供同样的顺丰轨迹查询 API，并通过 KV + Cron + Web Push 发送物流更新提醒。

```bash
cd frontend
npm run build

cd ../cf-worker
npm install
npm run gen:vapid
cp .dev.vars.example .dev.vars
npm run typecheck
npx wrangler kv namespace create SF_TRACK_KV
npm run deploy
```

更多配置见 `cf-worker/README.md`。生产环境请使用 `wrangler secret put` 写入顺丰顾客编码、校验码、token、session 密钥、推送加密密钥和 VAPID keys。
