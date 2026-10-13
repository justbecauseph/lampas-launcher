import type { ServerStatus } from "../types";

export interface ServerStatusViewModel {
  state: string;
  label: string;
  count: string;
  detail: string;
  players: Array<{ username: string; initial: string }>;
  more: number;
}

export function getServerStatusView(
  status: ServerStatus | null | undefined,
): ServerStatusViewModel {
  const state = status?.server?.state || "unknown";
  const online = status?.players?.online;
  const players = Array.isArray(status?.players?.list)
    ? status.players.list
    : [];
  const labels: Record<string, string> = {
    online: "Server online",
    starting: "Server starting",
    stopping: "Server stopping",
    offline: "Server offline",
    unknown: "Status unavailable",
  };
  let detail =
    "Unable to verify server status right now. You can still launch.";
  if (state === "online")
    detail = online === 0 ? "No one is online right now." : "";
  else if (state === "starting")
    detail = "The server is still loading. You can launch while it starts.";
  else if (state === "stopping")
    detail = "The server is stopping. You can still launch.";
  else if (state === "offline")
    detail = "The server appears offline. You can still launch.";

  return {
    state: labels[state] ? state : "unknown",
    label: labels[state] || labels.unknown,
    count:
      online === null || online === undefined
        ? "— players"
        : `${online} player${online === 1 ? "" : "s"}`,
    detail,
    players: players.slice(0, 8).map((player) => ({
      username: player.username || "Unknown player",
      initial: (player.username || "?").slice(0, 1).toUpperCase(),
    })),
    more: Math.max(0, players.length - 8),
  };
}

export function initServerStatusView(getIsLoggedIn: () => boolean): () => void {
  const serverPresence = document.getElementById(
    "server-presence",
  ) as HTMLElement | null;
  const serverPresenceDot = document.getElementById(
    "server-presence-dot",
  ) as HTMLElement | null;
  const serverPresenceState = document.getElementById(
    "server-presence-state",
  ) as HTMLElement | null;
  const serverPresenceCount = document.getElementById(
    "server-presence-count",
  ) as HTMLElement | null;
  const serverPresenceDetail = document.getElementById(
    "server-presence-detail",
  ) as HTMLElement | null;
  const serverPresencePlayers = document.getElementById(
    "server-presence-players",
  ) as HTMLElement | null;

  let serverStatusRequest: Promise<ServerStatus | null> | null = null;
  let serverStatusInterval: ReturnType<typeof setInterval> | null = null;

  function renderServerStatus(status: ServerStatus | null | undefined): void {
    const view = getServerStatusView(status);
    const state = view.state;

    if (serverPresence) serverPresence.dataset.state = state;
    if (serverPresenceDot)
      serverPresenceDot.className = `presence-dot presence-dot-${state}`;
    if (serverPresenceState) serverPresenceState.innerText = view.label;
    if (serverPresenceCount) serverPresenceCount.innerText = view.count;
    if (serverPresenceDetail) serverPresenceDetail.innerText = view.detail;

    if (!serverPresencePlayers) return;
    serverPresencePlayers.replaceChildren();
    if (state !== "online" || view.players.length === 0) return;

    view.players.forEach((player) => {
      const head = document.createElement("span");
      head.className = "presence-head";
      head.title = player.username;
      head.innerText = player.initial;
      head.setAttribute("aria-hidden", "true");
      serverPresencePlayers.appendChild(head);
    });

    const names = document.createElement("span");
    names.className = "presence-names";
    const listed = view.players.map((player) => player.username).join(", ");
    names.innerText =
      view.more > 0 ? `${listed} and ${view.more} more` : listed;
    serverPresencePlayers.appendChild(names);
  }

  async function refreshServerStatus(): Promise<ServerStatus | null> {
    if (!window.lampas.server?.getStatus) return null;
    if (!getIsLoggedIn()) {
      renderServerStatus(null);
      return null;
    }
    if (serverStatusRequest) return serverStatusRequest;

    serverStatusRequest = window.lampas.server
      .getStatus()
      .then((status) => {
        renderServerStatus(status);
        return status;
      })
      .catch((err) => {
        renderServerStatus(null);
        console.warn("Server presence unavailable:", err?.message || err);
        return null;
      })
      .finally(() => {
        serverStatusRequest = null;
      });

    return serverStatusRequest;
  }

  function startPolling(): void {
    if (serverStatusInterval) clearInterval(serverStatusInterval);
    void refreshServerStatus();
    serverStatusInterval = setInterval(() => {
      if (!document.hidden) void refreshServerStatus();
    }, 15_000);
  }

  const onFocus = () => void refreshServerStatus();
  const onVisibilityChange = () => {
    if (!document.hidden) void refreshServerStatus();
  };

  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  startPolling();

  return () => {
    if (serverStatusInterval) clearInterval(serverStatusInterval);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
