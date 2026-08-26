import { ConfigManager, normalizePortalUrl } from "./config";
import { LauncherLogger } from "./logger";
import type {
  MinecraftServerState,
  OnlineMinecraftPlayer,
  PresenceFreshness,
  ServerStatus,
} from "./types";

export const SERVER_STATUS_TIMEOUT_MS = 5_000;

const SERVER_STATES: ReadonlySet<MinecraftServerState> = new Set([
  "starting",
  "online",
  "stopping",
  "offline",
  "unknown",
]);
const PRESENCE_FRESHNESS: ReadonlySet<PresenceFreshness> = new Set([
  "live",
  "stale",
  "unavailable",
]);

export interface ServerStatusRequestOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid server status response: ${name} must be an object`);
  return value;
}

function parsePlayer(value: unknown, index: number): OnlineMinecraftPlayer {
  const player = requireRecord(value, `players.list[${index}]`);
  if (typeof player.uuid !== "string" || !player.uuid.trim()) {
    throw new Error(`Invalid server status response: players.list[${index}].uuid must be a string`);
  }
  if (typeof player.username !== "string" || !player.username.trim()) {
    throw new Error(`Invalid server status response: players.list[${index}].username must be a string`);
  }
  return { uuid: player.uuid, username: player.username };
}

/** Validate and copy only the public fields in Portal's response contract. */
export function parseServerStatus(value: unknown): ServerStatus {
  const root = requireRecord(value, "root");
  const server = requireRecord(root.server, "server");
  const players = requireRecord(root.players, "players");
  const presence = requireRecord(root.presence, "presence");

  if (typeof server.state !== "string" || !SERVER_STATES.has(server.state as MinecraftServerState)) {
    throw new Error("Invalid server status response: server.state is not supported");
  }
  if (typeof server.managementConnected !== "boolean") {
    throw new Error("Invalid server status response: server.managementConnected must be a boolean");
  }

  const online = players.online;
  if (online !== null && (typeof online !== "number" || !Number.isInteger(online) || online < 0)) {
    throw new Error("Invalid server status response: players.online must be a non-negative integer or null");
  }
  if (!Array.isArray(players.list)) {
    throw new Error("Invalid server status response: players.list must be an array");
  }
  const list = players.list.map(parsePlayer);

  if (typeof presence.freshness !== "string" || !PRESENCE_FRESHNESS.has(presence.freshness as PresenceFreshness)) {
    throw new Error("Invalid server status response: presence.freshness is not supported");
  }
  if (presence.updatedAt !== null && typeof presence.updatedAt !== "string") {
    throw new Error("Invalid server status response: presence.updatedAt must be a string or null");
  }

  return {
    server: {
      state: server.state as MinecraftServerState,
      managementConnected: server.managementConnected,
    },
    players: { online, list },
    presence: {
      freshness: presence.freshness as PresenceFreshness,
      updatedAt: presence.updatedAt as string | null,
    },
  };
}

export class ServerStatusClient {
  static async getStatus(options: ServerStatusRequestOptions = {}): Promise<ServerStatus> {
    const config = ConfigManager.get();
    if (!config.token) throw new Error("Portal session is not available");

    const url = `${normalizePortalUrl(config.portalUrl)}/api/v1/server/status`;
    const timeoutMs = options.timeoutMs ?? SERVER_STATUS_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    LauncherLogger.logApiRequest("GET", url);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${config.token}`,
        },
        signal: controller.signal,
      });
      const durationMs = Date.now() - startedAt;
      if (!response.ok) {
        LauncherLogger.logApiResponse("GET", url, response.status, durationMs, response.statusText);
        throw new Error(`Server status request failed (${response.status})`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Server status response was not valid JSON");
      }

      const status = parseServerStatus(payload);
      LauncherLogger.logApiResponse("GET", url, response.status, durationMs, {
        state: status.server.state,
        players: status.players.online,
        freshness: status.presence.freshness,
      });
      LauncherLogger.info(`[ServerStatus] ${status.server.state}, players=${status.players.online ?? "unknown"}, freshness=${status.presence.freshness}`);
      return status;
    } catch (error: any) {
      const durationMs = Date.now() - startedAt;
      const message = error?.name === "AbortError"
        ? `Server status request timed out after ${timeoutMs}ms`
        : error?.message || String(error);
      const normalizedError = new Error(message, { cause: error });
      LauncherLogger.logApiError("GET", url, normalizedError, durationMs);
      throw normalizedError;
    } finally {
      clearTimeout(timer);
    }
  }
}
