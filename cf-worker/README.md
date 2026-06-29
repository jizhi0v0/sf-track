# Cloudflare Worker 推送版

这个 Worker 可以托管 `frontend/dist`，提供顺丰轨迹查询 API，并用 Web Push 做物流更新提醒。

## 准备

```bash
cd frontend
npm install
npm run build

cd ../cf-worker
npm install
npm run gen:vapid
cp .dev.vars.example .dev.vars
```

把 `.dev.vars` 填好：

- `SF_PARTNER_ID`：顺丰顾客编码
- `SF_CHECK_WORD`：顺丰校验码
- `TRACKING_ACCESS_TOKENS`：页面访问 token
- `SESSION_SECRET`：session 签名密钥
- `PUSH_DATA_SECRET`：KV 内敏感字段加密密钥
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`：`npm run gen:vapid` 生成

## Cloudflare 资源

```bash
npx wrangler kv namespace create SF_TRACK_KV
```

把返回的 namespace id 写入 `wrangler.toml`。
同时把 `VAPID_SUBJECT` 改成你的站点 URL 或运维邮箱，例如 `mailto:ops@example.com`。

生产 secrets：

```bash
npx wrangler secret put SF_PARTNER_ID
npx wrangler secret put SF_CHECK_WORD
npx wrangler secret put TRACKING_ACCESS_TOKENS
npx wrangler secret put SESSION_SECRET
npx wrangler secret put PUSH_DATA_SECRET
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

## 本地和部署

```bash
npm run typecheck
npm run dev
npm run deploy
```

部署后访问：

```text
https://<worker-domain>/sf-track?token=<your-token>
```

## 安全说明

- 顺丰密钥只在 Worker secrets 中。
- URL token 只用来换取 HttpOnly session cookie。
- KV 中的运单号和手机号后四位会用 `PUSH_DATA_SECRET` 加密。
- Worker Cron 默认每 10 分钟轮询一次订阅轨迹，有新节点才推送；只有出现新节点时才刷新 14 天 TTL，连续 14 天无新轨迹的订阅会自动过期清理。
- 推送通知点进来时跳转到 `/sf-track?from=push`，前端用本机订阅调 `/api/push/resume`，服务端凭加密数据替用户重查并展示轨迹，无需重新输入运单号和手机后四位，URL 里也不出现敏感信息。
- KV 计数不是强原子，较高并发生产场景建议把 token 使用次数和频控换成 D1 或 Durable Object。
