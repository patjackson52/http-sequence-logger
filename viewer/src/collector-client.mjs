// One-way notifications prompt cursor-based catch-up; reconnect never invents capture events.
export class CollectorClient {
  constructor({
    token,
    fetcher = (...args) => fetch(...args),
    onCapture = () => {},
    onStatus = () => {},
    onPairing = () => {},
    retryMs = 1000,
  }) {
    Object.assign(this, {
      token,
      fetcher,
      onCapture,
      onStatus,
      onPairing,
      retryMs,
    });
    this.cursor = 0;
    this.lines = [];
    this.collectorId = null;
    this.controller = null;
  }
  async request(path, signal) {
    const response = await this.fetcher(path, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      const error = new Error(
        response.status === 401
          ? "Open the collector’s viewer link to pair this browser."
          : `Collector returned HTTP ${response.status}`,
      );
      error.permanent = response.status === 401 || response.status === 403;
      throw error;
    }
    return response;
  }
  async catchUp(signal) {
    for (;;) {
      const page = await (
        await this.request(`/api/v1/events?after=${this.cursor}`, signal)
      ).json();
      if (this.collectorId && page.collector_id !== this.collectorId)
        throw Object.assign(
          new Error("Collector identity changed. Reopen its viewer link."),
          { permanent: true },
        );
      this.collectorId = page.collector_id;
      if (
        !Array.isArray(page.lines) ||
        page.cursor !== this.cursor + page.lines.length ||
        !Number.isSafeInteger(page.cursor) ||
        page.cursor > 100000 ||
        (page.has_more && !page.lines.length)
      )
        throw new Error("Invalid collector page");
      if (page.lines.length) {
        this.lines.push(...page.lines);
        this.cursor = page.cursor;
        this.onCapture(this.lines.join("\n") + "\n", this.cursor);
      }
      if (!page.has_more) break;
    }
  }
  async run() {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    let delay = this.retryMs;
    while (!signal.aborted) {
      try {
        this.onStatus({
          state: this.cursor ? "reconnecting" : "connecting",
          count: this.cursor,
        });
        // Open notification stream before fetching backlog, so arrivals during catch-up aren't missed.
        const response = await this.request("/api/v1/stream", signal);
        const reader = response.body.getReader();
        try {
          await this.catchUp(signal);
          this.onPairing(
            (await (await this.request("/api/v1/pairing", signal)).json())
              .connections,
          );
          this.onStatus({ state: "live", count: this.cursor });
          delay = this.retryMs;
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) throw new Error("Collector disconnected");
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 65536)
              throw new Error("Invalid collector notification");
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
              const message = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (/^event: (ready|changed)$/m.test(message)) {
                await this.catchUp(signal);
                this.onStatus({ state: "live", count: this.cursor });
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch (error) {
        if (signal.aborted) break;
        this.onStatus({
          state: error.permanent ? "error" : "reconnecting",
          count: this.cursor,
          error: error.message,
        });
        if (error.permanent) break;
        await new Promise((ok) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            ok();
          };
          const timer = setTimeout(finish, delay);
          signal.addEventListener("abort", finish, { once: true });
        });
        delay = Math.min(delay * 2, 15000);
      }
    }
  }
  stop() {
    this.controller?.abort();
    this.controller = null;
  }
  async download() {
    const response = await this.request("/api/v1/download");
    return response.blob();
  }
}
