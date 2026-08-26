// Pure presentation model for the live server instrument. Keeping this out
// of the DOM code makes state wording and the eight-player cap testable.
(function (root) {
  function getServerStatusView(status) {
    const state = status?.server?.state || "unknown";
    const online = status?.players?.online;
    const players = Array.isArray(status?.players?.list) ? status.players.list : [];
    const labels = {
      online: "SERVER ONLINE",
      starting: "SERVER STARTING",
      stopping: "SERVER STOPPING",
      offline: "SERVER OFFLINE",
      unknown: "STATUS UNAVAILABLE",
    };
    let detail = "Unable to verify server status right now. You can still launch.";
    if (state === "online") detail = online === 0 ? "No one is online right now." : "Players currently online";
    else if (state === "starting") detail = "The server is still loading. You can launch while it starts.";
    else if (state === "stopping") detail = "The server is stopping. You can still launch.";
    else if (state === "offline") detail = "The server appears offline. You can still launch.";

    return {
      state: labels[state] ? state : "unknown",
      label: labels[state] || labels.unknown,
      count: online === null || online === undefined
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

  if (typeof module !== "undefined" && module.exports) module.exports = { getServerStatusView };
  else root.LampasServerStatusView = { getServerStatusView };
})(typeof globalThis !== "undefined" ? globalThis : this);
