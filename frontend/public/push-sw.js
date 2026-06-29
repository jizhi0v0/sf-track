self.addEventListener("push", (event) => {
  let payload = {
    title: "物流轨迹更新",
    body: "你的快递有新的物流动态。",
    data: { url: "/sf-track" },
  };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      data: payload.data,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/sf-track";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            client.focus();
            if ("navigate" in client) {
              return client.navigate(targetUrl);
            }
            return undefined;
          }
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
