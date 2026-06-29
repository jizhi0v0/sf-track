export interface Env {
  ASSETS: Fetcher;
  SF_TRACK_KV: KVNamespace;
  SF_ENV: "sandbox" | "production";
  SF_API_BASE_URL?: string;
  SF_PARTNER_ID: string;
  SF_CHECK_WORD: string;
  TRACKING_ACCESS_TOKENS: string;
  SESSION_SECRET: string;
  SESSION_TTL_SECONDS?: string;
  SESSION_COOKIE_SECURE?: string;
  PUSH_DATA_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

type AccessTokenConfig = {
  token: string;
  tokenHash: string;
  expiresAt: number;
  maxUses: number;
};

type SessionPayload = {
  tokenHash: string;
  exp: number;
};

type TrackRequest = {
  waybillNo: string;
  phoneLast4: string;
};

export type CleanRoute = {
  acceptTime: string;
  acceptAddress: string;
  remark: string;
  opCode?: string;
};

export type PushSubscriptionJson = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type WatchRecord = {
  subscription: PushSubscriptionJson;
  encryptedData: EncryptedValue;
  lastRouteFingerprint?: string;
  tokenHash: string;
  createdAt: string;
  updatedAt: string;
  failureCount: number;
};

type WatchSecretData = {
  waybillNo: string;
  phoneLast4: string;
};

export type ResumeShipment = {
  mailNo: string;
  routes: CleanRoute[];
};

type EncryptedValue = {
  iv: string;
  data: string;
};

const SESSION_COOKIE = "sf_track_session";
const SERVICE_CODE = "EXP_RECE_SEARCH_ROUTES";
const MAX_RESUME_WATCHES = 20;
const EMPTY_MESSAGE =
  "暂无轨迹，可能是手机号后四位不匹配、无查询权限、暂无路由或超过可查询时间范围。";
const GENERIC_ERROR = "查询失败，请稍后再试。";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPushPoll(env));
  },
};

async function handleFetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  try {
    if (url.pathname === "/sf-track") {
      return await handleTrackPage(request, env);
    }

    if (url.pathname === "/api/sf/track" && request.method === "POST") {
      return await handleTrackApi(request, env);
    }

    if (url.pathname === "/api/push/vapid-public-key" && request.method === "GET") {
      await requireSession(request, env);
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
      return await handlePushSubscribe(request, env);
    }

    if (url.pathname === "/api/push/unsubscribe" && request.method === "POST") {
      return await handlePushUnsubscribe(request, env);
    }

    if (url.pathname === "/api/push/status" && request.method === "POST") {
      return await handlePushStatus(request, env);
    }

    if (url.pathname === "/api/push/resume" && request.method === "POST") {
      return await handlePushResume(request, env);
    }

    return env.ASSETS.fetch(request);
  } catch (error) {
    if (error instanceof HttpError) {
      return json(
        { success: false, status: "error", message: error.publicMessage },
        error.status,
      );
    }

    console.warn("request failed", safeError(error));
    return json({ success: false, status: "error", message: GENERIC_ERROR }, 500);
  }
}

async function handleTrackPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim();

  if (token) {
    const config = await findToken(env, token);
    if (!config || config.expiresAt <= Date.now()) {
      return unauthorizedHtml(env);
    }

    const session = await signSession({ tokenHash: config.tokenHash, exp: sessionExp(env, config) }, env);
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/sf-track",
        "Set-Cookie": buildSessionCookie(session, env),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  await requireSession(request, env);
  const response = await env.ASSETS.fetch(request);
  return withNoStore(response);
}

async function handleTrackApi(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const payload = await request.json<TrackRequest>().catch(() => null);

  if (!payload) {
    throw new HttpError(400, "参数格式不正确。");
  }

  const waybillNo = payload.waybillNo?.trim().toUpperCase();
  const phoneLast4 = payload.phoneLast4?.trim();
  if (!isValidWaybillNo(waybillNo) || !isValidPhoneLast4(phoneLast4)) {
    throw new HttpError(400, "参数格式不正确。");
  }

  const clientIp = clientIpFromRequest(request);
  await checkRateLimits(env, session.tokenHash, clientIp, waybillNo);
  await consumeTokenUse(env, session.tokenHash);

  try {
    const result = await queryRoutes(env, waybillNo, phoneLast4);
    const tokenFailureKey = await failureKey("token", session.tokenHash, waybillNo);
    const ipFailureKey = await failureKey("ip", await sha256Hex(clientIp), waybillNo);

    if (result.routes.length === 0) {
      await recordBusinessFailure(env, tokenFailureKey);
      await recordBusinessFailure(env, ipFailureKey);
      return json({ success: true, status: "empty", message: EMPTY_MESSAGE });
    }

    await env.SF_TRACK_KV.delete(tokenFailureKey);
    await env.SF_TRACK_KV.delete(ipFailureKey);

    return json({
      success: true,
      status: "success",
      mailNo: result.mailNo,
      routes: result.routes,
    });
  } catch (error) {
    console.warn("sf query failed", safeError(error));
    return json({ success: false, status: "error", message: GENERIC_ERROR }, 502);
  }
}

async function handlePushSubscribe(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await request.json<{
    subscription: PushSubscriptionJson;
    waybillNo: string;
    phoneLast4: string;
    latestRoute?: CleanRoute;
  }>().catch(() => null);

  if (!body || !isValidSubscription(body.subscription)) {
    throw new HttpError(400, "推送订阅参数不正确。");
  }

  const waybillNo = body.waybillNo?.trim().toUpperCase();
  const phoneLast4 = body.phoneLast4?.trim();
  if (!isValidWaybillNo(waybillNo) || !isValidPhoneLast4(phoneLast4)) {
    throw new HttpError(400, "参数格式不正确。");
  }

  const endpointHash = await sha256Hex(body.subscription.endpoint);
  const waybillHash = await sha256Hex(waybillNo);
  const key = `watch:${endpointHash}:${waybillHash}`;
  const now = new Date().toISOString();

  const existing = await env.SF_TRACK_KV.get<WatchRecord>(key, "json");
  const encryptedData = await encryptJson<WatchSecretData>(
    { waybillNo, phoneLast4 },
    env.PUSH_DATA_SECRET,
  );

  const record: WatchRecord = {
    subscription: body.subscription,
    encryptedData,
    lastRouteFingerprint: body.latestRoute
      ? await routeFingerprint(body.latestRoute)
      : existing?.lastRouteFingerprint,
    tokenHash: session.tokenHash,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    failureCount: 0,
  };

  await env.SF_TRACK_KV.put(key, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 14,
  });

  return json({ success: true, status: "success" });
}

async function handlePushUnsubscribe(request: Request, env: Env): Promise<Response> {
  await requireSession(request, env);
  const body = await request.json<{ endpoint?: string; waybillNo?: string }>().catch(() => null);

  if (!body?.endpoint || !body.waybillNo) {
    throw new HttpError(400, "推送订阅参数不正确。");
  }

  const key = `watch:${await sha256Hex(body.endpoint)}:${await sha256Hex(
    body.waybillNo.trim().toUpperCase(),
  )}`;
  await env.SF_TRACK_KV.delete(key);
  return json({ success: true, status: "success" });
}

// 只读地判断「某设备是否已订阅某运单」，只查 KV、不调顺丰，供前端决定显示「开启」还是「已开启」。
async function handlePushStatus(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await request.json<{ endpoint?: string; waybillNo?: string }>().catch(() => null);
  const endpoint = body?.endpoint?.trim();
  const waybillNo = body?.waybillNo?.trim().toUpperCase();

  if (!endpoint || !endpoint.startsWith("https://") || !isValidWaybillNo(waybillNo)) {
    throw new HttpError(400, "推送订阅参数不正确。");
  }

  const key = `watch:${await sha256Hex(endpoint)}:${await sha256Hex(waybillNo)}`;
  const record = await env.SF_TRACK_KV.get<WatchRecord>(key, "json");
  const subscribed = Boolean(record && record.tokenHash === session.tokenHash);

  return json({ success: true, subscribed });
}

async function handlePushResume(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await request.json<{ endpoint?: string }>().catch(() => null);
  const endpoint = body?.endpoint?.trim();

  if (!endpoint || !endpoint.startsWith("https://")) {
    throw new HttpError(400, "推送订阅参数不正确。");
  }

  await checkResumeRateLimits(env, session.tokenHash, clientIpFromRequest(request));

  const shipments = await collectResumeShipments(env, endpoint, session.tokenHash);
  return json({
    success: true,
    status: shipments.length > 0 ? "success" : "empty",
    shipments,
  });
}

// 用设备的 push endpoint 找回该 token 订阅过的运单，解密后替用户重查顺丰，
// 全程不需要用户重新输入运单号和手机后四位，也不把敏感信息放进 URL。
export async function collectResumeShipments(
  env: Env,
  endpoint: string,
  tokenHash: string,
): Promise<ResumeShipment[]> {
  const prefix = `watch:${await sha256Hex(endpoint)}:`;
  const shipments: ResumeShipment[] = [];
  let cursor: string | undefined;
  let processed = 0;

  do {
    const page = await env.SF_TRACK_KV.list({ prefix, cursor, limit: 100 });
    cursor = page.list_complete ? undefined : page.cursor;

    for (const key of page.keys) {
      if (processed >= MAX_RESUME_WATCHES) {
        cursor = undefined;
        break;
      }

      const record = await env.SF_TRACK_KV.get<WatchRecord>(key.name, "json");
      if (!record || record.tokenHash !== tokenHash) {
        continue;
      }
      processed += 1;

      try {
        const secret = await decryptJson<WatchSecretData>(record.encryptedData, env.PUSH_DATA_SECRET);
        const result = await queryRoutes(env, secret.waybillNo, secret.phoneLast4);
        if (result.routes.length > 0) {
          shipments.push({ mailNo: result.mailNo, routes: result.routes });
        }
      } catch (error) {
        console.warn("push resume query failed", safeError(error));
      }
    }
  } while (cursor);

  return shipments.sort((left, right) =>
    (right.routes[0]?.acceptTime ?? "").localeCompare(left.routes[0]?.acceptTime ?? ""),
  );
}

async function checkResumeRateLimits(env: Env, tokenHash: string, clientIp: string): Promise<void> {
  const minute = Math.floor(Date.now() / 60000);
  const ipHash = await sha256Hex(clientIp);

  if (!(await incrementWindow(env, `rl:ip:${ipHash}:${minute}`, 10))) {
    throw new HttpError(429, "查询过于频繁，请稍后再试。");
  }

  if (!(await incrementWindow(env, `rl:token:${tokenHash}:${minute}`, 5))) {
    throw new HttpError(429, "查询过于频繁，请稍后再试。");
  }
}

async function runPushPoll(env: Env): Promise<void> {
  let cursor: string | undefined;

  do {
    const page = await env.SF_TRACK_KV.list({ prefix: "watch:", cursor, limit: 100 });
    cursor = page.list_complete ? undefined : page.cursor;

    for (const key of page.keys) {
      try {
        await pollWatch(env, key.name);
      } catch (error) {
        console.warn("push poll item failed", safeError(error));
      }
    }
  } while (cursor);
}

export async function pollWatch(env: Env, key: string): Promise<void> {
  const record = await env.SF_TRACK_KV.get<WatchRecord>(key, "json");
  if (!record) {
    return;
  }

  const secret = await decryptJson<WatchSecretData>(record.encryptedData, env.PUSH_DATA_SECRET);

  try {
    const result = await queryRoutes(env, secret.waybillNo, secret.phoneLast4);
    const latest = result.routes[0];
    if (!latest) {
      return;
    }

    const latestFingerprint = await routeFingerprint(latest);
    const fingerprintChanged = record.lastRouteFingerprint !== latestFingerprint;
    const changed = record.lastRouteFingerprint && fingerprintChanged;

    if (changed) {
      await sendWebPush(env, record.subscription, {
        title: "物流轨迹更新",
        body: `${latest.acceptTime} ${latest.remark}`.slice(0, 160),
        data: { url: "/sf-track?from=push" },
      });
    }

    // 只有出现新节点（指纹变化）或需要清掉历史失败计数时才重写记录并续期，
    // 否则保留原 TTL 继续倒计时：连续 14 天无新轨迹的订阅会自动过期清理。
    if (fingerprintChanged || record.failureCount > 0) {
      record.lastRouteFingerprint = latestFingerprint;
      record.updatedAt = new Date().toISOString();
      record.failureCount = 0;
      await env.SF_TRACK_KV.put(key, JSON.stringify(record), {
        expirationTtl: 60 * 60 * 24 * 14,
      });
    }
  } catch (error) {
    record.failureCount += 1;
    record.updatedAt = new Date().toISOString();

    if (record.failureCount >= 10) {
      await env.SF_TRACK_KV.delete(key);
    } else {
      await env.SF_TRACK_KV.put(key, JSON.stringify(record), {
        expirationTtl: 60 * 60 * 24 * 14,
      });
    }

    console.warn("push poll query failed", safeError(error));
  }
}

async function queryRoutes(
  env: Env,
  waybillNo: string,
  phoneLast4: string,
): Promise<{ mailNo: string; routes: CleanRoute[] }> {
  const baseUrl =
    env.SF_API_BASE_URL ??
    (env.SF_ENV === "sandbox"
      ? "https://sfapi-sbox.sf-express.com/std/service"
      : "https://sfapi.sf-express.com/std/service");
  const msgData = JSON.stringify({
    language: "0",
    trackingType: "1",
    trackingNumber: [waybillNo],
    methodType: "1",
    checkPhoneNo: phoneLast4,
  });
  const timestamp = Date.now().toString();
  const requestID = crypto.randomUUID();
  const msgDigest = buildMsgDigest(msgData, timestamp, env.SF_CHECK_WORD);
  const form = new URLSearchParams({
    partnerID: env.SF_PARTNER_ID,
    requestID,
    serviceCode: SERVICE_CODE,
    timestamp,
    msgDigest,
    msgData,
  });

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: form.toString(),
  });

  if (!response.ok) {
    throw new Error(`sf_http_${response.status}`);
  }

  const outer = await response.json<{
    apiErrorMsg?: string;
    apiResultCode: string;
    apiResultData?: string;
  }>();

  if (outer.apiResultCode !== "A1000") {
    throw new Error(`sf_api_${outer.apiResultCode}_${outer.apiErrorMsg ?? ""}`);
  }

  if (!outer.apiResultData) {
    throw new Error("sf_missing_result_data");
  }

  const inner = JSON.parse(outer.apiResultData) as {
    success: boolean;
    errorCode?: string;
    errorMsg?: string;
    msgData?: {
      routeResps?: Array<{
        mailNo?: string;
        routes?: Array<{
          acceptTime?: string;
          acceptAddress?: string;
          remark?: string;
          opCode?: string;
        }>;
      }>;
    };
  };

  if (!inner.success || inner.errorCode !== "S0000") {
    throw new Error(`sf_business_${inner.errorCode ?? "unknown"}`);
  }

  const first = inner.msgData?.routeResps?.[0];
  const routes = (first?.routes ?? [])
    .map((route) => ({
      acceptTime: route.acceptTime ?? "",
      acceptAddress: sanitizeAcceptAddress(route.acceptAddress ?? ""),
      remark: sanitizeRouteRemark(route.remark ?? ""),
      opCode: route.opCode || undefined,
    }))
    .sort((left, right) => right.acceptTime.localeCompare(left.acceptTime));

  return {
    mailNo: first?.mailNo ?? waybillNo,
    routes,
  };
}

function buildMsgDigest(msgData: string, timestamp: string, checkWord: string): string {
  const raw = `${msgData}${timestamp}${checkWord}`;
  const encoded = javaUrlEncode(raw);
  return base64(Array.from(md5Bytes(utf8(encoded))));
}

function javaUrlEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

async function findToken(env: Env, token: string): Promise<AccessTokenConfig | undefined> {
  const tokens = await parseAccessTokens(env);
  const tokenHash = await sha256Hex(token);
  return tokens.find((item) => item.tokenHash === tokenHash);
}

export async function parseAccessTokens(env: Env): Promise<AccessTokenConfig[]> {
  const entries = env.TRACKING_ACCESS_TOKENS.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const parsed: AccessTokenConfig[] = [];

  for (const entry of entries) {
    const first = entry.indexOf(":");
    const last = entry.lastIndexOf(":");
    if (first <= 0 || last <= first) {
      continue;
    }

    const token = entry.slice(0, first).trim();
    const expiresAt = parseExpiry(entry.slice(first + 1, last).trim());
    const maxUses = parseMaxUses(entry.slice(last + 1).trim());
    if (!token || expiresAt === null || maxUses === null) {
      continue;
    }

    parsed.push({
      token,
      tokenHash: await sha256Hex(token),
      expiresAt,
      maxUses,
    });
  }

  return parsed;
}

// 过期时间和最大次数都支持用 "*" 表示不限制（分别解析为 Infinity）。
function parseExpiry(raw: string): number | null {
  if (raw === "*") {
    return Infinity;
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseMaxUses(raw: string): number | null {
  if (raw === "*") {
    return Infinity;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function requireSession(request: Request, env: Env): Promise<SessionPayload> {
  const cookie = getCookie(request.headers.get("Cookie") ?? "", SESSION_COOKIE);
  if (!cookie) {
    throw new HttpError(401, "访问凭证无效或已过期。");
  }

  const payload = await verifySession(cookie, env);
  if (!payload || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, "访问凭证无效或已过期。");
  }

  const tokens = await parseAccessTokens(env);
  const config = tokens.find((token) => token.tokenHash === payload.tokenHash);
  if (!config || config.expiresAt <= Date.now()) {
    throw new HttpError(401, "访问凭证无效或已过期。");
  }

  if (config.maxUses !== Infinity) {
    const uses = Number((await env.SF_TRACK_KV.get(`tokenUse:${payload.tokenHash}`)) ?? "0");
    if (uses >= config.maxUses) {
      throw new HttpError(403, "访问凭证已过期或次数已用完。");
    }
  }

  return payload;
}

async function signSession(payload: SessionPayload, env: Env): Promise<string> {
  const body = base64Url(utf8(JSON.stringify(payload)));
  const signature = await hmacSha256Base64Url(env.SESSION_SECRET, body);
  return `${body}.${signature}`;
}

async function verifySession(value: string, env: Env): Promise<SessionPayload | undefined> {
  const [body, signature] = value.split(".");
  if (!body || !signature) {
    return undefined;
  }

  const expected = await hmacSha256Base64Url(env.SESSION_SECRET, body);
  if (!constantTimeEqual(signature, expected)) {
    return undefined;
  }

  try {
    return JSON.parse(text(base64UrlToBytes(body))) as SessionPayload;
  } catch {
    return undefined;
  }
}

function sessionExp(env: Env, config: AccessTokenConfig): number {
  const ttl = Number(env.SESSION_TTL_SECONDS ?? "1800");
  const expires = Math.floor(Date.now() / 1000) + (Number.isFinite(ttl) ? ttl : 1800);
  return Math.min(expires, Math.floor(config.expiresAt / 1000));
}

function buildSessionCookie(value: string, env: Env): string {
  const secure = env.SESSION_COOKIE_SECURE !== "false";
  const securePart = secure ? "; Secure" : "";
  const maxAge = Number(env.SESSION_TTL_SECONDS ?? "1800");
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${securePart}`;
}

export async function consumeTokenUse(env: Env, tokenHash: string): Promise<void> {
  const tokens = await parseAccessTokens(env);
  const config = tokens.find((token) => token.tokenHash === tokenHash);
  if (!config) {
    throw new HttpError(403, "访问凭证已过期或次数已用完。");
  }

  // 次数不限时不需要计数，省掉每次查询的 KV 写入。
  if (config.maxUses === Infinity) {
    return;
  }

  const key = `tokenUse:${tokenHash}`;
  const uses = Number((await env.SF_TRACK_KV.get(key)) ?? "0");
  if (uses >= config.maxUses) {
    throw new HttpError(403, "访问凭证已过期或次数已用完。");
  }

  // 计数键的 TTL 跟随 token 过期时间；永不过期时退化为固定一年。
  const ttl = Number.isFinite(config.expiresAt)
    ? Math.max(60, Math.ceil((config.expiresAt - Date.now()) / 1000))
    : 60 * 60 * 24 * 365;
  await env.SF_TRACK_KV.put(key, String(uses + 1), { expirationTtl: ttl });
}

async function checkRateLimits(
  env: Env,
  tokenHash: string,
  clientIp: string,
  waybillNo: string,
): Promise<void> {
  const minute = Math.floor(Date.now() / 60000);
  const ipHash = await sha256Hex(clientIp);

  if (!(await incrementWindow(env, `rl:ip:${ipHash}:${minute}`, 10))) {
    throw new HttpError(429, "查询过于频繁，请稍后再试。");
  }

  if (!(await incrementWindow(env, `rl:token:${tokenHash}:${minute}`, 5))) {
    throw new HttpError(429, "查询过于频繁，请稍后再试。");
  }

  const tokenFailureKey = await failureKey("token", tokenHash, waybillNo);
  const ipFailureKey = await failureKey("ip", ipHash, waybillNo);
  if ((await isFailureLocked(env, tokenFailureKey)) || (await isFailureLocked(env, ipFailureKey))) {
    throw new HttpError(429, "失败次数过多，请稍后再试。");
  }
}

async function incrementWindow(env: Env, key: string, limit: number): Promise<boolean> {
  const current = Number((await env.SF_TRACK_KV.get(key)) ?? "0");
  if (current >= limit) {
    return false;
  }

  await env.SF_TRACK_KV.put(key, String(current + 1), { expirationTtl: 120 });
  return true;
}

async function failureKey(kind: string, subjectHash: string, waybillNo: string): Promise<string> {
  return `fail:${kind}:${subjectHash}:${await sha256Hex(waybillNo)}`;
}

async function isFailureLocked(env: Env, key: string): Promise<boolean> {
  const counter = await env.SF_TRACK_KV.get<{ count: number; lockedUntil?: number }>(key, "json");
  return Boolean(counter?.lockedUntil && counter.lockedUntil > Date.now());
}

async function recordBusinessFailure(env: Env, key: string): Promise<void> {
  const current = (await env.SF_TRACK_KV.get<{ count: number; lockedUntil?: number }>(key, "json")) ?? {
    count: 0,
  };
  const count = current.count + 1;
  const lockedUntil = count >= 5 ? Date.now() + 30 * 60 * 1000 : undefined;
  await env.SF_TRACK_KV.put(key, JSON.stringify({ count, lockedUntil }), {
    expirationTtl: 30 * 60,
  });
}

async function sendWebPush(env: Env, subscription: PushSubscriptionJson, payload: unknown): Promise<void> {
  const encrypted = await encryptPushPayload(subscription, JSON.stringify(payload));
  const jwt = await vapidJwt(env, new URL(subscription.endpoint).origin);

  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      TTL: "3600",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body: toArrayBuffer(encrypted),
  });

  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new Error(`push_${response.status}`);
  }
}

async function encryptPushPayload(
  subscription: PushSubscriptionJson,
  payload: string,
): Promise<Uint8Array> {
  const uaPublic = base64UrlToBytes(subscription.keys.p256dh);
  const authSecret = base64UrlToBytes(subscription.keys.auth);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const uaKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, keyPair.privateKey, 256),
  );

  const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
  const ecdhPrk = await hmacSha256Bytes(authSecret, sharedSecret);
  const ikm = await hmacSha256Bytes(ecdhPrk, concat(keyInfo, new Uint8Array([1])));
  const prk = await hmacSha256Bytes(salt, ikm);
  const cek = (await hmacSha256Bytes(prk, concat(utf8("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmacSha256Bytes(prk, concat(utf8("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const aesKey = await crypto.subtle.importKey("raw", toArrayBuffer(cek), "AES-GCM", false, [
    "encrypt",
  ]);
  const plaintext = concat(utf8(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce) },
      aesKey,
      toArrayBuffer(plaintext),
    ),
  );
  const recordSize = new Uint8Array([0, 0, 16, 0]);

  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

async function vapidJwt(env: Env, audience: string): Promise<string> {
  const header = base64Url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64Url(
    utf8(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: env.VAPID_SUBJECT,
      }),
    ),
  );
  const input = `${header}.${payload}`;
  const publicKey = base64UrlToBytes(env.VAPID_PUBLIC_KEY);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: base64Url(publicKey.slice(1, 33)),
      y: base64Url(publicKey.slice(33, 65)),
      d: env.VAPID_PRIVATE_KEY,
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      toArrayBuffer(utf8(input)),
    ),
  );

  return `${input}.${base64Url(ecdsaJoseSignature(signature))}`;
}

export async function encryptJson<T>(value: T, secret: string): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKeyFromSecret(secret);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(utf8(JSON.stringify(value))),
    ),
  );
  return { iv: base64Url(iv), data: base64Url(encrypted) };
}

async function decryptJson<T>(value: EncryptedValue, secret: string): Promise<T> {
  const key = await aesKeyFromSecret(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64UrlToBytes(value.iv)) },
    key,
    toArrayBuffer(base64UrlToBytes(value.data)),
  );
  return JSON.parse(text(new Uint8Array(decrypted))) as T;
}

async function aesKeyFromSecret(secret: string): Promise<CryptoKey> {
  const keyBytes = await sha256Bytes(secret);
  return crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function sanitizeRouteRemark(input: string): string {
  return input
    .replace(/电联快递员/g, "联系快递员")
    .replace(/(?:\+?86[-\s]?)?1[3-9]\d{9}/g, "[已脱敏]")
    .replace(/(^|[^\d])((?:0\d{2,3}[-\s]?)?\d{7,8})([^\d]|$)/g, "$1[已脱敏]$3")
    .replace(/(地址|住址|收件地址|寄件地址)[:：][^，。,；;】\]]+/g, "$1：[已脱敏]");
}

function sanitizeAcceptAddress(input: string): string {
  const value = input.trim();
  if (!value) {
    return "";
  }

  for (const municipality of ["北京市", "上海市", "天津市", "重庆市"]) {
    if (value.startsWith(municipality)) {
      return municipality;
    }
  }

  const cityIndex = value.indexOf("市");
  if (cityIndex >= 0) {
    return value.slice(0, cityIndex + 1);
  }

  const countyIndex = value.indexOf("县");
  if (countyIndex >= 0) {
    return value.slice(0, countyIndex + 1);
  }

  const districtIndex = value.indexOf("区");
  if (districtIndex >= 0) {
    return value.slice(0, districtIndex + 1);
  }

  return Array.from(value).slice(0, 12).join("");
}

function isValidWaybillNo(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]{6,40}$/.test(value);
}

function isValidPhoneLast4(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}$/.test(value);
}

function isValidSubscription(value: unknown): value is PushSubscriptionJson {
  if (!value || typeof value !== "object") {
    return false;
  }

  const subscription = value as PushSubscriptionJson;
  return Boolean(
    subscription.endpoint &&
      subscription.keys?.p256dh &&
      subscription.keys?.auth &&
      subscription.endpoint.startsWith("https://"),
  );
}

function clientIpFromRequest(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function getCookie(cookieHeader: string, name: string): string | undefined {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function unauthorizedHtml(env: Env): Response {
  const secure = env.SESSION_COOKIE_SECURE !== "false";
  const securePart = secure ? "; Secure" : "";
  return new Response(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访问受限</title><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#20242a"><main style="max-width:420px;padding:28px;border:1px solid #d9dee7;background:#fff;border-radius:8px"><h1 style="font-size:20px;margin:0 0 12px">访问受限</h1><p style="line-height:1.7;margin:0;color:#59616f">该查询页仅供授权链接访问。请使用有效链接重新打开。</p></main></body></html>',
    {
      status: 401,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${securePart}`,
      },
    },
  );
}

export async function routeFingerprint(route: CleanRoute): Promise<string> {
  return sha256Hex(`${route.acceptTime}|${route.acceptAddress}|${route.remark}|${route.opCode ?? ""}`);
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  return base64Url(await hmacSha256Bytes(utf8(secret), utf8(value)));
}

async function hmacSha256Bytes(keyBytes: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(value)));
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await sha256Bytes(value));
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(utf8(value))));
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 180);
  }
  return String(error).slice(0, 180);
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function base64(bytes: number[] | Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function ecdsaJoseSignature(signature: Uint8Array): Uint8Array {
  if (signature.length === 64) {
    return signature;
  }

  let offset = 3;
  let rLength = signature[offset - 1];
  if (signature[offset] === 0) {
    offset += 1;
    rLength -= 1;
  }
  const r = signature.slice(offset, offset + rLength);
  offset += rLength + 2;
  let sLength = signature[offset - 1];
  if (signature[offset] === 0) {
    offset += 1;
    sLength -= 1;
  }
  const s = signature.slice(offset, offset + sLength);
  const out = new Uint8Array(64);
  out.set(r.slice(-32), 32 - Math.min(32, r.length));
  out.set(s.slice(-32), 64 - Math.min(32, s.length));
  return out;
}

function md5Bytes(input: Uint8Array): Uint8Array {
  const rotateLeft = (value: number, shift: number) => (value << shift) | (value >>> (32 - shift));
  const add = (left: number, right: number) => (left + right) >>> 0;
  const k = new Uint32Array(64);
  for (let index = 0; index < 64; index += 1) {
    k[index] = Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0;
  }
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const bitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) + 1) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(input);
  buffer[input.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let chunk = 0; chunk < paddedLength; chunk += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }

      const next = d;
      d = c;
      c = b;
      b = add(b, rotateLeft(add(add(a, f), add(k[index], view.getUint32(chunk + g * 4, true))), s[index]));
      a = next;
    }

    a0 = add(a0, a);
    b0 = add(b0, b);
    c0 = add(c0, c);
    d0 = add(d0, d);
  }

  const output = new Uint8Array(16);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(0, a0, true);
  outputView.setUint32(4, b0, true);
  outputView.setUint32(8, c0, true);
  outputView.setUint32(12, d0, true);
  return output;
}
