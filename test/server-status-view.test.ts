import { describe, expect, test } from "bun:test";
import { getServerStatusView } from "../ui/src/views/server-status-view";

describe("server status UI view model", () => {
  test("shows online count and first eight players with an overflow label", () => {
    const view = getServerStatusView({
      server: { state: "online" },
      players: {
        online: 12,
        list: Array.from({ length: 12 }, (_, index) => ({
          uuid: String(index),
          username: `Player${index}`,
        })),
      },
    });

    expect(view.label).toBe("Server online");
    expect(view.count).toBe("12 players");
    expect(view.players).toHaveLength(8);
    expect(view.players[0]).toEqual({ username: "Player0", initial: "P" });
    expect(view.more).toBe(4);
  });

  test("gives explicit guidance for starting, stopping, offline, and unknown states", () => {
    expect(
      getServerStatusView({
        server: { state: "starting" },
        players: { online: null, list: [] },
      }).detail,
    ).toBe(
      "The server is starting. It should be ready by the time the game loads.",
    );
    expect(
      getServerStatusView({
        server: { state: "stopping" },
        players: { online: null, list: [] },
      }).detail,
    ).toBe("The server is shutting down, maybe for a restart.");
    expect(
      getServerStatusView({
        server: { state: "offline" },
        players: { online: null, list: [] },
      }).detail,
    ).toBe(
      "The server is down. You can start the game, but you can't join until it's back.",
    );
    expect(getServerStatusView(null)).toEqual(
      expect.objectContaining({
        state: "unknown",
        label: "Status unknown",
        count: "",
        detail:
          "Couldn't check the server just now. You can still start the game.",
      }),
    );
  });

  test("a signed-out player is asked to sign in, not told the server check failed", () => {
    const view = getServerStatusView(
      { server: { state: "online" }, players: { online: 5, list: [] } },
      false,
    );
    expect(view).toEqual({
      state: "unknown",
      label: "Status unknown",
      count: "",
      detail: "Sign in to see the server status.",
      players: [],
      more: 0,
    });
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
