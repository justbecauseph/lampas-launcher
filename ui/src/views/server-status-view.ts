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
  signedIn = true,
): ServerStatusViewModel {
  if (!signedIn) {
    return {
      state: "unknown",
      label: "Status unknown",
      count: "",
      detail: "Sign in to see the server status.",
      players: [],
      more: 0,
    };
  }
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
    unknown: "Status unknown",
  };
  let detail =
    "Couldn't check the server just now. You can still start the game.";
  if (state === "online")
    detail = online === 0 ? "No one is online right now." : "";
  else if (state === "starting")
    detail =
      "The server is starting. It should be ready by the time the game loads.";
  else if (state === "stopping")
    detail = "The server is shutting down, maybe for a restart.";
  else if (state === "offline")
    detail =
      "The server is down. You can start the game, but you can't join until it's back.";

  return {
    state: labels[state] ? state : "unknown",
    label: labels[state] || labels.unknown,
    count:
      online === null || online === undefined
        ? ""
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

  function renderServerStatus(
    status: ServerStatus | null | undefined,
    signedIn = true,
  ): void {
    const view = getServerStatusView(status, signedIn);
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
      renderServerStatus(null, false);
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
