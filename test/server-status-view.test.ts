import { describe, expect, test } from "bun:test";
import { getServerStatusView } from "../ui/server-status-view.js";

describe("server status UI view model", () => {
  test("shows online count and first eight players with an overflow label", () => {
    const view = getServerStatusView({
      server: { state: "online" },
      players: {
        online: 12,
        list: Array.from({ length: 12 }, (_, index) => ({ uuid: String(index), username: `Player${index}` })),
      },
    });

    expect(view.label).toBe("SERVER ONLINE");
    expect(view.count).toBe("12 players");
    expect(view.players).toHaveLength(8);
    expect(view.players[0]).toEqual({ username: "Player0", initial: "P" });
    expect(view.more).toBe(4);
  });

  test("gives explicit guidance for starting, offline, and unknown states", () => {
    expect(getServerStatusView({ server: { state: "starting" }, players: { online: null, list: [] } }).detail)
      .toContain("launch while it starts");
    expect(getServerStatusView({ server: { state: "offline" }, players: { online: null, list: [] } }).detail)
      .toContain("still launch");
    expect(getServerStatusView(null)).toEqual(expect.objectContaining({
      state: "unknown",
      label: "STATUS UNAVAILABLE",
      count: "— players",
    }));
  });

  test("uses the empty-state copy when nobody is online", () => {
    const view = getServerStatusView({
      server: { state: "online" },
      players: { online: 0, list: [] },
    });
    expect(view.detail).toBe("No one is online right now.");
    expect(view.players).toEqual([]);
    expect(view.more).toBe(0);
  });
});
