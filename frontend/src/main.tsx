import React from "react";
import ReactDOM from "react-dom/client";
import {
  ArrowRight,
  Copy,
  LoaderCircle,
  PackageCheck,
  Search,
  Truck,
} from "lucide-react";
import "./styles.css";

type RouteItem = {
  acceptTime: string;
  acceptAddress: string;
  remark: string;
  opCode?: string;
};

type Shipment = {
  mailNo: string;
  routes: RouteItem[];
};

type ResumeResponse = {
  status: "success" | "empty";
  shipments: Shipment[];
};

type TrackResponse =
  | {
      success: true;
      status: "success";
      mailNo: string;
      routes: RouteItem[];
    }
  | {
      success: true;
      status: "empty";
      message: string;
    }
  | {
      success: false;
      status: "error";
      message: string;
    };

type QueryState =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "empty"; message: string }
  | { type: "error"; message: string }
  | { type: "success"; mailNo: string; routes: RouteItem[] };

type PushState =
  | { type: "checking" }
  | { type: "unavailable" }
  | { type: "idle"; publicKey: string }
  | { type: "subscribing"; publicKey: string }
  | { type: "subscribed" }
  | { type: "denied" }
  | { type: "error"; message: string };

function App() {
  const [waybillNo, setWaybillNo] = React.useState("");
  const [phoneLast4, setPhoneLast4] = React.useState("");
  const [queryState, setQueryState] = React.useState<QueryState>({ type: "idle" });
  const [resumedShipments, setResumedShipments] = React.useState<Shipment[]>([]);

  const canSubmit = waybillNo.trim().length > 0 && /^\d{4}$/.test(phoneLast4.trim());
  const summary = buildSummary(queryState, waybillNo);
  const activeFromResume =
    queryState.type === "success" &&
    resumedShipments.some((shipment) => shipment.mailNo === queryState.mailNo);

  // 从推送通知点进来（/sf-track?from=push）时，用本机订阅找回运单并直接展示轨迹，
  // 不需要重新输入运单号和手机后四位。
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("from") !== "push") {
      return;
    }

    let cancelled = false;

    async function resumeFromPush() {
      try {
        if (!("serviceWorker" in navigator)) {
          return;
        }

        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          return;
        }

        const response = await fetch("/api/push/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as ResumeResponse;
        const first = data.shipments?.[0];
        if (cancelled || data.status !== "success" || !first) {
          return;
        }

        setResumedShipments(data.shipments);
        setWaybillNo(first.mailNo);
        setQueryState({ type: "success", mailNo: first.mailNo, routes: first.routes });
      } catch {
        // 恢复失败就保持空白页，用户仍可手动查询。
      } finally {
        // 无论成败都洗掉 ?from=push，不留在地址栏和历史里。
        window.history.replaceState(null, "", "/sf-track");
      }
    }

    resumeFromPush();
    return () => {
      cancelled = true;
    };
  }, []);

  function selectShipment(shipment: Shipment) {
    setWaybillNo(shipment.mailNo);
    setQueryState({ type: "success", mailNo: shipment.mailNo, routes: shipment.routes });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || queryState.type === "loading") {
      return;
    }

    setResumedShipments([]);
    setQueryState({ type: "loading" });

    try {
      const response = await fetch("/api/sf/track", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          waybillNo: waybillNo.trim(),
          phoneLast4: phoneLast4.trim(),
        }),
      });
      const data = (await response.json()) as TrackResponse;

      if (!response.ok || !data.success) {
        setQueryState({
          type: "error",
          message: data.status === "error" ? data.message : "查询失败，请稍后再试。",
        });
        return;
      }

      if (data.status === "empty") {
        setQueryState({ type: "empty", message: data.message });
        return;
      }

      setQueryState({
        type: "success",
        mailNo: data.mailNo,
        routes: data.routes,
      });
    } catch {
      setQueryState({ type: "error", message: "网络异常，请稍后再试。" });
    }
  }

  function handleCopyWaybill() {
    if (!summary.mailNo || !navigator.clipboard) {
      return;
    }

    navigator.clipboard.writeText(summary.mailNo).catch(() => undefined);
  }

  return (
    <main className="app-shell">
      <div className="page-content">
        <section className="shipment-hero" aria-label="运单摘要">
          <form className="shipment-card" onSubmit={handleSubmit}>
            <div className="card-tabs">
              <div className="waybill-strip">
                <span>运单号：</span>
                <strong>{summary.mailNo}</strong>
                <button
                  className="copy-button"
                  type="button"
                  aria-label="复制运单号"
                  onClick={handleCopyWaybill}
                >
                  <Copy size={17} />
                </button>
              </div>
            </div>

            <div className="route-summary">
              <div className="delivery-state">
                <strong>{summary.statusText}</strong>
                <span>{summary.subText}</span>
              </div>

              <div className="city-route" aria-label="路由城市">
                <span>{summary.fromCity}</span>
                <ArrowRight aria-hidden="true" className="route-arrow" size={38} strokeWidth={2.1} />
                <span>{summary.toCity}</span>
              </div>
            </div>

            <div className="query-dock">
              <label className="query-input waybill-input">
                <span>运单号</span>
                <input
                  value={waybillNo}
                  onChange={(event) => setWaybillNo(event.target.value)}
                  inputMode="text"
                  autoComplete="off"
                  placeholder="SF0213844341359"
                  maxLength={40}
                />
              </label>

              <label className="query-input phone-input">
                <span>后四位</span>
                <input
                  value={phoneLast4}
                  onChange={(event) =>
                    setPhoneLast4(event.target.value.replace(/\D/g, "").slice(0, 4))
                  }
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="1234"
                  maxLength={4}
                />
              </label>

              <button
                className="query-button"
                type="submit"
                disabled={!canSubmit || queryState.type === "loading"}
              >
                {queryState.type === "loading" ? (
                  <LoaderCircle aria-hidden="true" className="spin" size={18} />
                ) : (
                  <Search aria-hidden="true" size={18} />
                )}
                <span>{queryState.type === "loading" ? "查询中" : "查询"}</span>
              </button>
            </div>
          </form>
        </section>

        <section className="tracking-panel" aria-labelledby="route-title">
          <h1 id="route-title">物流详情</h1>
          {resumedShipments.length > 1 ? (
            <div className="shipment-switch" role="tablist" aria-label="已订阅的运单">
              {resumedShipments.map((shipment) => (
                <button
                  key={shipment.mailNo}
                  type="button"
                  role="tab"
                  aria-selected={queryState.type === "success" && queryState.mailNo === shipment.mailNo}
                  className={`shipment-chip${
                    queryState.type === "success" && queryState.mailNo === shipment.mailNo ? " active" : ""
                  }`}
                  onClick={() => selectShipment(shipment)}
                >
                  {shipment.mailNo}
                </button>
              ))}
            </div>
          ) : null}
          <PushPanel
            state={queryState}
            waybillNo={waybillNo}
            phoneLast4={phoneLast4}
            assumeSubscribed={activeFromResume}
          />
          <ResultView state={queryState} />
        </section>
      </div>
    </main>
  );
}

function PushPanel({
  state,
  waybillNo,
  phoneLast4,
  assumeSubscribed,
}: {
  state: QueryState;
  waybillNo: string;
  phoneLast4: string;
  assumeSubscribed: boolean;
}) {
  const [pushState, setPushState] = React.useState<PushState>({ type: "checking" });

  React.useEffect(() => {
    let cancelled = false;

    async function checkPushApi() {
      if (state.type !== "success") {
        setPushState({ type: "checking" });
        return;
      }

      // 从通知恢复出来的运单本就处于订阅中，直接显示已订阅，避免再次索要手机后四位。
      if (assumeSubscribed) {
        setPushState({ type: "subscribed" });
        return;
      }

      const activeMailNo = state.mailNo;

      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setPushState({ type: "unavailable" });
        return;
      }

      // 这个运单在本设备已经订阅过的话，直接显示已订阅，不再显示开启按钮。
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          const statusResponse = await fetch("/api/push/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ endpoint: subscription.endpoint, waybillNo: activeMailNo }),
          });
          if (statusResponse.ok) {
            const status = (await statusResponse.json()) as { subscribed?: boolean };
            if (!cancelled && status.subscribed) {
              setPushState({ type: "subscribed" });
              return;
            }
          }
        }
      } catch {
        // 查询订阅状态失败就按未订阅处理，继续走开启流程。
      }

      if (cancelled) {
        return;
      }

      try {
        const response = await fetch("/api/push/vapid-public-key", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const contentType = response.headers.get("Content-Type") || "";
        if (!response.ok || !contentType.includes("application/json")) {
          setPushState({ type: "unavailable" });
          return;
        }

        const data = (await response.json()) as { publicKey?: string };
        if (!cancelled && data.publicKey) {
          setPushState({ type: "idle", publicKey: data.publicKey });
        }
      } catch {
        if (!cancelled) {
          setPushState({ type: "unavailable" });
        }
      }
    }

    checkPushApi();
    return () => {
      cancelled = true;
    };
  }, [state.type, state.type === "success" ? state.mailNo : null, assumeSubscribed]);

  if (state.type !== "success" || pushState.type === "checking" || pushState.type === "unavailable") {
    return null;
  }

  if (pushState.type === "subscribed") {
    return (
      <div className="push-panel success">
        已开启物流推送，有新轨迹会提醒你。若连续 14 天无新轨迹，订阅会自动停止。
      </div>
    );
  }

  if (pushState.type === "denied") {
    return <div className="push-panel error">浏览器已禁止通知，请在站点设置里重新允许。</div>;
  }

  if (pushState.type === "error") {
    return <div className="push-panel error">{pushState.message}</div>;
  }

  const publicKey = pushState.publicKey;

  async function enablePush() {
    if (state.type !== "success") {
      return;
    }

    if (Notification.permission === "denied") {
      setPushState({ type: "denied" });
      return;
    }

    setPushState({ type: "subscribing", publicKey });

    try {
      const permission =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState({ type: "denied" });
        return;
      }

      const registration = await navigator.serviceWorker.register("/push-sw.js");
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(publicKey),
        });
      }

      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          waybillNo: state.mailNo || waybillNo.trim(),
          phoneLast4: phoneLast4.trim(),
          latestRoute: state.routes[0],
        }),
      });

      if (!response.ok) {
        throw new Error("subscribe_failed");
      }

      setPushState({ type: "subscribed" });
    } catch {
      setPushState({ type: "error", message: "开启推送失败，请稍后再试。" });
    }
  }

  return (
    <div className="push-panel">
      <span>订阅后，有新物流轨迹时会发送浏览器通知。</span>
      <button
        className="push-button"
        type="button"
        onClick={enablePush}
        disabled={pushState.type === "subscribing"}
      >
        {pushState.type === "subscribing" ? "开启中" : "开启物流推送"}
      </button>
    </div>
  );
}

function ResultView({ state }: { state: QueryState }) {
  if (state.type === "idle") {
    return (
      <div className="state-card muted">
        <Truck size={26} />
        <span>输入运单号和手机号后四位后查询</span>
      </div>
    );
  }

  if (state.type === "loading") {
    return (
      <div className="state-card active">
        <LoaderCircle aria-hidden="true" className="spin" size={24} />
        <span>正在查询顺丰路由</span>
      </div>
    );
  }

  if (state.type === "error") {
    return (
      <div className="state-card error">
        <span>{state.message}</span>
      </div>
    );
  }

  if (state.type === "empty") {
    return (
      <div className="state-card empty">
        <span>{state.message}</span>
      </div>
    );
  }

  return <TimelineView routes={state.routes} />;
}

function TimelineView({ routes }: { routes: RouteItem[] }) {
  return (
    <ol className="timeline" aria-label="物流轨迹，时间倒序">
      {routes.map((route, index) => {
        const isLatest = index === 0;
        const isPickup = isPickupRoute(route, index, routes.length);
        const title = isLatest ? "运送中" : isPickup ? "已揽收" : "";

        return (
          <li
            key={`${route.acceptTime}-${index}`}
            className={`timeline-item${isLatest ? " latest" : ""}${isPickup ? " pickup" : ""}`}
          >
            <div className="timeline-rail" aria-hidden="true">
              <span className="timeline-marker">
                {isLatest ? (
                  <Truck size={23} strokeWidth={2.4} />
                ) : isPickup ? (
                  <PackageCheck size={22} strokeWidth={2.2} />
                ) : null}
              </span>
            </div>

            <article className="timeline-content">
              {title ? <h3>{title}</h3> : null}
              <time>{formatRouteTime(route.acceptTime)}</time>
              <p>{route.remark || route.acceptAddress || "暂无轨迹备注"}</p>
              {route.opCode ? <span className="opcode">opCode {route.opCode}</span> : null}
            </article>
          </li>
        );
      })}
    </ol>
  );
}

function buildSummary(state: QueryState, waybillNo: string) {
  if (state.type === "success") {
    const latestRoute = state.routes[0];
    const fromCity = latestRoute?.acceptAddress || "当前位置";
    const toCity = extractDestinationCity(state.routes) || "下一站";

    return {
      mailNo: state.mailNo,
      statusText: "运送中",
      subText: latestRoute?.acceptTime ? `更新至 ${formatSummaryTime(latestRoute.acceptTime)}` : "轨迹已更新",
      fromCity,
      toCity,
    };
  }

  if (state.type === "loading") {
    return {
      mailNo: waybillNo.trim(),
      statusText: "查询中",
      subText: "正在获取顺丰路由",
      fromCity: "始发地",
      toCity: "目的地",
    };
  }

  if (state.type === "empty") {
    return {
      mailNo: waybillNo.trim(),
      statusText: "暂无轨迹",
      subText: "请核对信息或稍后再试",
      fromCity: "始发地",
      toCity: "目的地",
    };
  }

  if (state.type === "error") {
    return {
      mailNo: waybillNo.trim(),
      statusText: "查询失败",
      subText: "请稍后再试",
      fromCity: "始发地",
      toCity: "目的地",
    };
  }

  return {
    mailNo: waybillNo.trim() || "待输入",
    statusText: "待查询",
    subText: "输入信息后查询",
    fromCity: "始发地",
    toCity: "目的地",
  };
}

function extractDestinationCity(routes: RouteItem[]) {
  // 顺丰备注措辞多样，按可靠性从高到低匹配；动词和【之间可能有空格。
  // 只匹配指向下一程/终点的写法；「已到达/抵达/运抵【X】」是当前到站位置，故意不收。
  const patterns = [
    /预计[^，。；]*?(?:到达|送达)\s*【([^】]+)】/, // 预计在【29日下午】到达【北京市】
    /(?:准备发往|即将发往|发往|送往|运往|转运至|中转至|派送至|派往)\s*【([^】]+)】/, // 发往 【北京顺航转运中心】
    /下一站\s*【([^】]+)】/, // 下一站【南京中转场】
  ];

  for (const route of routes) {
    for (const pattern of patterns) {
      const match = route.remark.match(pattern);
      if (match?.[1]) {
        const city = normalizeCity(match[1]);
        if (city) {
          return city;
        }
      }
    }
  }

  return "";
}

function normalizeCity(value: string) {
  const cityMatch = value.match(/([\u4e00-\u9fa5]{2,12}?市)/);
  if (cityMatch?.[1]) {
    return cityMatch[1];
  }

  for (const city of ["北京", "上海", "天津", "重庆"]) {
    if (value.includes(city)) {
      return `${city}市`;
    }
  }

  return value.slice(0, 6);
}

function formatSummaryTime(value: string) {
  return value.replace(/-/g, "−").slice(5, 16);
}

function formatRouteTime(value: string) {
  return value.replace(/-/g, "−").slice(0, 16);
}

function isPickupRoute(route: RouteItem, index: number, routeCount: number) {
  if (index === routeCount - 1) {
    return true;
  }

  return /揽收|收取快件|已收取|已揽/.test(route.remark);
}

function base64UrlToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const normalized = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(normalized);
  const output = new Uint8Array(rawData.length);
  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index);
  }
  return output;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
