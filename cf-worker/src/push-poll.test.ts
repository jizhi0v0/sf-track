import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  collectResumeShipments,
  consumeTokenUse,
  encryptJson,
  parseAccessTokens,
  pollWatch,
  routeFingerprint,
  type CleanRoute,
  type Env,
  type PushSubscriptionJson,
  type WatchRecord,
} from "./index";

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const TTL_14_DAYS = 60 * 60 * 24 * 14;
const WATCH_KEY = "watch:endpointhash:waybillhash";
const SF_BASE = "https://sf.test/route";
const PUSH_ORIGIN = "https://push.test";
const PUSH_ENDPOINT = `${PUSH_ORIGIN}/ep/123`;

// 一条经过 sanitize 后保持原样的轨迹，让 fingerprint 计算可预测。
const LATEST_ROUTE: CleanRoute = {
  acceptTime: "2026-06-29 10:00:00",
  acceptAddress: "深圳市",
  remark: "快件已到达深圳集散中心",
  opCode: "630",
};

let env: Env;
let subscription: PushSubscriptionJson;
let currentFingerprint: string;
const realFetch = globalThis.fetch;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function makeVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: base64Url(rawPublic), privateKey: jwk.d as string };
}

async function makeSubscription(): Promise<PushSubscriptionJson> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint: PUSH_ENDPOINT,
    keys: { p256dh: base64Url(rawPublic), auth: base64Url(auth) },
  };
}

type FakeKv = {
  puts: Array<{ key: string; options?: { expirationTtl?: number } }>;
  deletes: string[];
  store: Map<string, unknown>;
} & Pick<KVNamespace, "get" | "put" | "delete" | "list">;

function makeKv(seed: Record<string, unknown>): FakeKv {
  const store = new Map<string, unknown>(Object.entries(seed));
  const puts: Array<{ key: string; options?: { expirationTtl?: number } }> = [];
  const deletes: string[] = [];
  return {
    store,
    puts,
    deletes,
    get: (async (key: string) => (store.has(key) ? store.get(key) : null)) as KVNamespace["get"],
    put: (async (key: string, value: string, options?: { expirationTtl?: number }) => {
      puts.push({ key, options });
      store.set(key, JSON.parse(value));
    }) as KVNamespace["put"],
    delete: (async (key: string) => {
      deletes.push(key);
      store.delete(key);
    }) as KVNamespace["delete"],
    list: (async (options?: { prefix?: string }) => {
      const prefix = options?.prefix ?? "";
      const keys = [...store.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    }) as KVNamespace["list"],
  };
}

// 模拟顺丰返回指定 routes；apiResultCode 非 A1000 时模拟上游失败。
function buildSfResponse(routes: CleanRoute[], apiResultCode = "A1000", mailNo = "SF123") {
  const inner = {
    success: true,
    errorCode: "S0000",
    msgData: { routeResps: [{ mailNo, routes }] },
  };
  return {
    ok: true,
    status: 200,
    async json() {
      return { apiResultCode, apiResultData: JSON.stringify(inner) };
    },
  };
}

function installFetch(sfResponseFactory: () => unknown) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith(SF_BASE)) {
      return sfResponseFactory();
    }
    if (url.startsWith(PUSH_ORIGIN)) {
      return { ok: true, status: 201 };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

function pushCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).startsWith(PUSH_ORIGIN)).length;
}

async function seedRecord(
  overrides: Partial<WatchRecord> = {},
  secret = { waybillNo: "SF123", phoneLast4: "1234" },
): Promise<WatchRecord> {
  const encryptedData = await encryptJson(secret, env.PUSH_DATA_SECRET);
  return {
    subscription,
    encryptedData,
    lastRouteFingerprint: currentFingerprint,
    tokenHash: "token-hash",
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
    failureCount: 0,
    ...overrides,
  };
}

beforeAll(async () => {
  const vapid = await makeVapidKeys();
  subscription = await makeSubscription();
  currentFingerprint = await routeFingerprint(LATEST_ROUTE);
  env = {
    SF_TRACK_KV: undefined as unknown as KVNamespace,
    SF_ENV: "production",
    SF_API_BASE_URL: SF_BASE,
    SF_PARTNER_ID: "PID",
    SF_CHECK_WORD: "CHECKWORD",
    PUSH_DATA_SECRET: "push-data-secret",
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: "mailto:ops@test.dev",
  } as unknown as Env;
});

afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
  vi.restoreAllMocks();
});

describe("pollWatch 自动清理规则", () => {
  it("轨迹无变化时不续期、不推送（让 14 天 TTL 继续倒计时）", async () => {
    const kv = makeKv({ [WATCH_KEY]: await seedRecord() });
    env.SF_TRACK_KV = kv as unknown as KVNamespace;
    const fetchMock = installFetch(() => buildSfResponse([LATEST_ROUTE]));

    await pollWatch(env, WATCH_KEY);

    // 关键：没有任何 put → 原 TTL 不被刷新 → 14 天无新轨迹会自然过期。
    expect(kv.puts).toHaveLength(0);
    expect(kv.deletes).toHaveLength(0);
    expect(pushCallCount(fetchMock)).toBe(0);
  });

  it("出现新节点时推送，并用 14 天 TTL 续期", async () => {
    const kv = makeKv({
      [WATCH_KEY]: await seedRecord({ lastRouteFingerprint: "stale-fingerprint" }),
    });
    env.SF_TRACK_KV = kv as unknown as KVNamespace;
    const fetchMock = installFetch(() => buildSfResponse([LATEST_ROUTE]));

    await pollWatch(env, WATCH_KEY);

    expect(pushCallCount(fetchMock)).toBe(1);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].options?.expirationTtl).toBe(TTL_14_DAYS);
    const stored = kv.store.get(WATCH_KEY) as WatchRecord;
    expect(stored.lastRouteFingerprint).toBe(currentFingerprint);
    expect(stored.failureCount).toBe(0);
  });

  it("轨迹无变化但存在历史失败计数时，重写记录以清零失败计数", async () => {
    const kv = makeKv({ [WATCH_KEY]: await seedRecord({ failureCount: 3 }) });
    env.SF_TRACK_KV = kv as unknown as KVNamespace;
    const fetchMock = installFetch(() => buildSfResponse([LATEST_ROUTE]));

    await pollWatch(env, WATCH_KEY);

    expect(pushCallCount(fetchMock)).toBe(0);
    expect(kv.puts).toHaveLength(1);
    expect((kv.store.get(WATCH_KEY) as WatchRecord).failureCount).toBe(0);
  });

  it("顺丰返回空轨迹时直接返回，不续期也不删除", async () => {
    const kv = makeKv({ [WATCH_KEY]: await seedRecord() });
    env.SF_TRACK_KV = kv as unknown as KVNamespace;
    installFetch(() => buildSfResponse([]));

    await pollWatch(env, WATCH_KEY);

    expect(kv.puts).toHaveLength(0);
    expect(kv.deletes).toHaveLength(0);
  });

  it("连续失败累计到 10 次时删除订阅", async () => {
    const kv = makeKv({ [WATCH_KEY]: await seedRecord({ failureCount: 9 }) });
    env.SF_TRACK_KV = kv as unknown as KVNamespace;
    installFetch(() => buildSfResponse([LATEST_ROUTE], "B0001"));

    await pollWatch(env, WATCH_KEY);

    expect(kv.deletes).toContain(WATCH_KEY);
  });
});

// 按运单号返回不同 routes，并把每个运单的失败码区分开。
function installResumeFetch(
  routesByWaybill: Record<string, CleanRoute[]>,
  failWaybills: Set<string> = new Set(),
) {
  const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.startsWith(SF_BASE)) {
      const params = new URLSearchParams(String(init?.body ?? ""));
      const msgData = JSON.parse(params.get("msgData") ?? "{}");
      const waybill = msgData.trackingNumber?.[0] ?? "";
      if (failWaybills.has(waybill)) {
        return buildSfResponse([], "B0001", waybill);
      }
      return buildSfResponse(routesByWaybill[waybill] ?? [], "A1000", waybill);
    }
    if (url.startsWith(PUSH_ORIGIN)) {
      return { ok: true, status: 201 };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

const TOKEN_HASH = "token-hash";
const RESUME_ENDPOINT = PUSH_ENDPOINT;
const ROUTE_OLD: CleanRoute = { ...LATEST_ROUTE, acceptTime: "2026-06-20 08:00:00" };
const ROUTE_NEW: CleanRoute = { ...LATEST_ROUTE, acceptTime: "2026-06-29 09:00:00" };

async function watchKeyFor(suffix: string): Promise<string> {
  return `watch:${await sha256Hex(RESUME_ENDPOINT)}:${suffix}`;
}

describe("collectResumeShipments 从通知恢复", () => {
  it("返回本设备本 token 订阅的运单，最新的排在前面", async () => {
    const kv = makeKv({
      [await watchKeyFor("a")]: await seedRecord(
        { tokenHash: TOKEN_HASH },
        { waybillNo: "SFAAA", phoneLast4: "1111" },
      ),
      [await watchKeyFor("b")]: await seedRecord(
        { tokenHash: TOKEN_HASH },
        { waybillNo: "SFBBB", phoneLast4: "2222" },
      ),
    });
    env.SF_TRACK_KV = kv as unknown as KVNamespace;
    installResumeFetch({ SFAAA: [ROUTE_OLD], SFBBB: [ROUTE_NEW] });

    const shipments = await collectResumeShipments(env, RESUME_ENDPOINT, TOKEN_HASH);

    expect(shipments.map((s) => s.mailNo)).toEqual(["SFBBB", "SFAAA"]);
    expect(shipments[0].routes[0].acceptTime).toBe("2026-06-29 09:00:00");
  });

  it("排除其它 token 创建的订阅", async () => {
    const kv = makeKv({
      [await watchKeyFor("a")]: await seedRecord(
        { tokenHash: TOKEN_HASH },
        { waybillNo: "SFAAA", phoneLast4: "1111" },
      ),
      [await watchKeyFor("b")]: await seedRecord(
        { tokenHash: "other-token" },
        { waybillNo: "SFBBB", phoneLast4: "2222" },
      ),
    });
    env.SF_TRACK_KV = kv as unknown as KVNamespace;
    installResumeFetch({ SFAAA: [ROUTE_OLD], SFBBB: [ROUTE_NEW] });

    const shipments = await collectResumeShipments(env, RESUME_ENDPOINT, TOKEN_HASH);

    expect(shipments.map((s) => s.mailNo)).toEqual(["SFAAA"]);
  });

  it("某个运单上游查询失败时跳过它，其它照常返回", async () => {
    const kv = makeKv({
      [await watchKeyFor("a")]: await seedRecord(
        { tokenHash: TOKEN_HASH },
        { waybillNo: "SFAAA", phoneLast4: "1111" },
      ),
      [await watchKeyFor("b")]: await seedRecord(
        { tokenHash: TOKEN_HASH },
        { waybillNo: "SFBBB", phoneLast4: "2222" },
      ),
    });
    env.SF_TRACK_KV = kv as unknown as KVNamespace;
    installResumeFetch({ SFAAA: [ROUTE_OLD], SFBBB: [ROUTE_NEW] }, new Set(["SFAAA"]));

    const shipments = await collectResumeShipments(env, RESUME_ENDPOINT, TOKEN_HASH);

    expect(shipments.map((s) => s.mailNo)).toEqual(["SFBBB"]);
  });
});

function tokenEnv(tokens: string): Env {
  return { TRACKING_ACCESS_TOKENS: tokens } as unknown as Env;
}

describe("token 不限次 / 不过期", () => {
  it("把 * 解析为 Infinity（永不过期 + 不限次）", async () => {
    const configs = await parseAccessTokens(tokenEnv("tk:*:*"));
    expect(configs).toHaveLength(1);
    expect(configs[0].expiresAt).toBe(Infinity);
    expect(configs[0].maxUses).toBe(Infinity);
  });

  it("可单独不限次但仍带过期时间", async () => {
    const configs = await parseAccessTokens(tokenEnv("tk:2026-12-31T23:59:59Z:*"));
    expect(configs[0].maxUses).toBe(Infinity);
    expect(Number.isFinite(configs[0].expiresAt)).toBe(true);
  });

  it("过期或次数字段非法时丢弃该条", async () => {
    expect(await parseAccessTokens(tokenEnv("tk:notadate:5"))).toHaveLength(0);
    expect(await parseAccessTokens(tokenEnv("tk:*:0"))).toHaveLength(0);
    expect(await parseAccessTokens(tokenEnv("tk:*:abc"))).toHaveLength(0);
  });

  it("不限次时 consumeTokenUse 完全不写计数", async () => {
    const kv = makeKv({});
    const env = { TRACKING_ACCESS_TOKENS: "tk:*:*", SF_TRACK_KV: kv } as unknown as Env;
    const tokenHash = await sha256Hex("tk");

    await consumeTokenUse(env, tokenHash);
    await consumeTokenUse(env, tokenHash);

    expect(kv.puts).toHaveLength(0);
  });

  it("限次时 consumeTokenUse 累加计数，用完后抛错", async () => {
    const kv = makeKv({});
    const env = { TRACKING_ACCESS_TOKENS: "tk:*:2", SF_TRACK_KV: kv } as unknown as Env;
    const tokenHash = await sha256Hex("tk");

    await consumeTokenUse(env, tokenHash);
    await consumeTokenUse(env, tokenHash);
    expect(kv.puts).toHaveLength(2);

    await expect(consumeTokenUse(env, tokenHash)).rejects.toThrow();
  });
});
