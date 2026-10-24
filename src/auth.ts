import * as http from "node:http";
import * as net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { shell } from "electron";
import {
  ConfigManager,
  normalizePortalUrl,
  portalFetch,
  PortalRedirectPolicyError,
} from "./config";
import { SessionManager, isValidMinecraftUuid } from "./session-manager";
import {
  type ClearCredentialsResult,
  type SaveCredentialsResult,
} from "./credential-store";
import type { UserProfile } from "./types";
import { LauncherLogger } from "./logger";
import {
  AuthRequiredError,
  MainIpcError,
  OperationConflictError,
  UserCancelledError,
} from "./ipc-boundary";
import { renderErrorHtml, renderSuccessHtml } from "./callback-page";

export const LOGIN_TIMEOUT_MS = 120_000; // 120 seconds (2 minutes) timeout

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePkce() {
  const verifier = base64Url(randomBytes(32));
  const hash = createHash("sha256").update(verifier).digest();
  const challenge = base64Url(hash);
  return { verifier, challenge };
}

const SIGN_IN_FAILED_MESSAGE = "Couldn't finish signing in. Try again.";
const UNREACHABLE_MESSAGE =
  "Couldn't reach the Lampas website. Check your internet connection, then try again.";
const NOT_LINKED_MESSAGE =
  "Your Lampas account isn't linked to a Minecraft account yet. Link one on the Lampas website, then sign in again.";

/**
 * The player-facing sentence for a sign-in that ended with no error of its own.
 */
function signInStoppedMessage(reason: string): string {
  switch (reason) {
    case "timeout":
      return "Sign-in took too long. Try again.";
    case "cancelled":
    case "denied":
      return "Sign-in was cancelled.";
    case "superseded":
      return "A newer sign-in replaced this one.";
    case "shutdown":
      return "The launcher closed before sign-in finished.";
    case "server_error":
      return SIGN_IN_FAILED_MESSAGE;
    case "browser_error":
      return "The browser couldn't finish sign-in. Try again.";
    default:
      return "Sign-in stopped. Try again.";
  }
}

interface LoginOperationContext {
  readonly id: string;
  readonly epoch: number;
  readonly deadline: number;
  readonly abortController: AbortController;
  authUrl?: string;
  callbackPort?: number;
  isTerminal(): boolean;
  terminate(
    reason:
      | "timeout"
      | "cancelled"
      | "superseded"
      | "denied"
      | "shutdown"
      | "server_error"
      | "browser_error"
      | "error",
    err?: Error,
  ): void;
  settleSuccess(data: { token: string; user: UserProfile }): void;
}

export class LauncherAuth {
  private static activeLoginContext: LoginOperationContext | null = null;

  static getActiveLoginContext(): LoginOperationContext | null {
    return this.activeLoginContext;
  }

  /**
   * Cancels any in-flight loopback OAuth login server, aborts requests, and terminates context.
   */
  static cancelLogin(): void {
    if (this.activeLoginContext) {
      this.activeLoginContext.terminate(
        "cancelled",
        new UserCancelledError("Sign-in was cancelled."),
      );
      this.activeLoginContext = null;
    }
    SessionManager.advanceSessionEpoch();
  }

  static async loginWithPortal(
    _portalUrlOverride?: string,
  ): Promise<{ token: string; user: UserProfile }> {
    // 1. Supersede any existing in-flight login operation
    if (this.activeLoginContext) {
      this.activeLoginContext.terminate(
        "superseded",
        new OperationConflictError("A newer sign-in replaced this one."),
      );
      this.activeLoginContext = null;
    }

    const loginEpoch = SessionManager.nextLoginEpoch();
    const config = ConfigManager.get();
    const portalUrl = normalizePortalUrl(config.portalUrl);
    const generationSnapshot = SessionManager.getSessionEpoch();
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString("hex");

    return new Promise((resolve, reject) => {
      let isSettled = false;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let exchanged = false;
      const abortController = new AbortController();
      const clientSockets = new Set<net.Socket>();
      // Sockets carrying a final page written just before an immediate abort.
      const pageSockets = new Set<net.Socket>();
      let closeServerWhenIdle = false;
      let serverClosed = false;
      const closeServer = () => {
        if (serverClosed) return;
        serverClosed = true;
        try {
          server.close();
        } catch {}
      };

      const settleOnce = (
        result:
          | { success: true; data: { token: string; user: UserProfile } }
          | { success: false; error: Error },
        reason?: string,
      ) => {
        if (isSettled) return;
        isSettled = true;

        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }

        if (LauncherAuth.activeLoginContext === opContext) {
          LauncherAuth.activeLoginContext = null;
        }

        // Separate immediate logical settlement from bounded transport cleanup:
        // Immediate termination reasons (cancelled, timeout, superseded, shutdown):
        // Destroy client sockets immediately so aborted / hung operations terminate.
        const isImmediateAbort =
          !result.success &&
          (reason === "timeout" ||
            reason === "cancelled" ||
            reason === "superseded" ||
            reason === "shutdown");

        if (isImmediateAbort) {
          for (const socket of clientSockets) {
            // A socket still sending this login's final page is left to the
            // fallback timer below; destroying it would cut the page off.
            if (pageSockets.has(socket)) continue;
            try {
              socket.destroy();
            } catch {}
            clientSockets.delete(socket);
          }
        }
        // Stop listening once the remaining sockets have closed. Closing the
        // server earlier cuts off a page that is still sending under Bun's
        // node:http; requests that arrive meanwhile hit the terminal barrier.
        closeServerWhenIdle = true;
        if (clientSockets.size === 0) closeServer();
        if (clientSockets.size > 0) {
          // Intentional terminal response delivery (200 success, 409 conflict, etc.):
          // All HTTP responses set 'Connection: close' and call res.end(). Node's HTTP engine owns
          // transmission and graceful socket closure. We do NOT call socket.end() here.
          // We provide a bounded fallback fail-safe timer (1000ms unref'd) to destroy any lingering socket.
          const lingeringTimer = setTimeout(() => {
            for (const socket of clientSockets) {
              try {
                socket.destroy();
              } catch {}
            }
            clientSockets.clear();
            closeServer();
          }, 1000);
          if (lingeringTimer.unref) lingeringTimer.unref();
        }

        if (result.success) {
          resolve(result.data);
        } else {
          reject(result.error);
        }
      };

      const opContext: LoginOperationContext = {
        id: randomBytes(8).toString("hex"),
        epoch: loginEpoch,
        deadline: Date.now() + LOGIN_TIMEOUT_MS,
        abortController,
        isTerminal: () => isSettled,
        terminate: (reason, err) => {
          if (isSettled) return;
          abortController.abort();
          const finalError =
            err || new MainIpcError(signInStoppedMessage(reason));
          settleOnce({ success: false, error: finalError }, reason);
        },
        settleSuccess: (data) => {
          settleOnce({ success: true, data }, "success");
        },
      };

      LauncherAuth.activeLoginContext = opContext;

      // 120-second terminal deadline
      timeoutTimer = setTimeout(() => {
        LauncherLogger.warn("[Auth] Portal login timed out after 120 seconds.");
        opContext.terminate("timeout");
      }, LOGIN_TIMEOUT_MS);

      const server = http.createServer(async (req, res) => {
        try {
          // Terminal barrier: ignore requests if already settled
          if (opContext.isTerminal()) {
            try {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Sign-in session is no longer active");
            } catch {}
            return;
          }

          // 1. Method constraint
          if (req.method !== "GET") {
            res.writeHead(405, {
              "Content-Type": "text/plain",
              Connection: "close",
            });
            res.end("Method Not Allowed");
            return;
          }

          // 2. Request URI length limit
          if ((req.url || "").length > 2048) {
            res.writeHead(414, {
              "Content-Type": "text/plain",
              Connection: "close",
            });
            res.end("URI Too Long");
            return;
          }

          // 3. Host header validation (reject DNS rebinding)
          const port = (server.address() as any)?.port;
          const hostHeader = (req.headers.host || "").toLowerCase();
          const expectedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
          if (!expectedHosts.includes(hostHeader)) {
            res.writeHead(400, {
              "Content-Type": "text/plain",
              Connection: "close",
            });
            res.end("Bad Request: Host header mismatch");
            return;
          }

          let reqUrl: URL;
          try {
            reqUrl = new URL(req.url || "", `http://127.0.0.1:${port}`);
          } catch {
            res.writeHead(400, {
              "Content-Type": "text/plain",
              Connection: "close",
            });
            res.end("Bad Request: Malformed URL");
            return;
          }

          // 4. Noise handling: ignore non-callback paths without closing server
          if (reqUrl.pathname !== "/callback") {
            res.writeHead(404, {
              "Content-Type": "text/plain",
              Connection: "close",
            });
            res.end("Not Found");
            return;
          }

          const code = reqUrl.searchParams.get("code");
          const returnedState = reqUrl.searchParams.get("state");
          const oauthError = reqUrl.searchParams.get("error");

          // Handle legitimate OAuth denial/cancellation from portal
          if (oauthError && returnedState === state) {
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8",
              Connection: "close",
            });
            res.end(
              renderErrorHtml(
                "Sign-in was cancelled. Go back to the launcher and try again.",
              ),
            );
            LauncherLogger.warn(
              "[Auth] OAuth login denied or cancelled by user on portal.",
            );
            opContext.terminate(
              "denied",
              new UserCancelledError("Sign-in was cancelled."),
            );
            return;
          }

          // Noise or invalid state probe: reject request without terminating valid pending server
          if (!code || returnedState !== state) {
            res.writeHead(400, {
              "Content-Type": "text/plain",
              Connection: "close",
            });
            res.end("Bad Request: Invalid callback state or missing code");
            return;
          }

          // 5. Single-use exchange enforcement
          if (exchanged) {
            res.writeHead(409, {
              "Content-Type": "text/plain",
              Connection: "close",
            });
            res.end("Conflict: Authorization code already processed");
            return;
          }
          exchanged = true;

          // 6. Check session snapshot before performing network exchange
          const currentConfig = ConfigManager.get();
          if (
            opContext.isTerminal() ||
            loginEpoch !== SessionManager.getActiveLoginEpoch() ||
            SessionManager.getSessionEpoch() !== generationSnapshot ||
            normalizePortalUrl(currentConfig.portalUrl) !== portalUrl
          ) {
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8",
              Connection: "close",
            });
            res.end(
              renderErrorHtml(
                "This sign-in was replaced by a newer one. Go back to the launcher.",
              ),
            );
            pageSockets.add(req.socket);
            opContext.terminate(
              "superseded",
              new OperationConflictError("A newer sign-in replaced this one."),
            );
            return;
          }

          // 7. Exchange authorization code for token
          const exchangeUrl = `${portalUrl}/api/v1/auth/exchange`;
          const startTime = Date.now();
          LauncherLogger.logApiRequest("POST", exchangeUrl, {
            code: "[REDACTED]",
          });

          let resp: Response;
          try {
            resp = await portalFetch(exchangeUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code, code_verifier: verifier }),
              signal: abortController.signal,
            });
          } catch (netErr: any) {
            LauncherLogger.error(
              `[Auth] Token exchange request failed: ${netErr?.message || netErr}`,
            );
            if (opContext.isTerminal()) return;
            res.writeHead(502, {
              "Content-Type": "text/html; charset=utf-8",
              Connection: "close",
            });
            res.end(renderErrorHtml(UNREACHABLE_MESSAGE));
            opContext.terminate("error", new MainIpcError(UNREACHABLE_MESSAGE));
            return;
          }

          if (opContext.isTerminal()) return;
          const durationMs = Date.now() - startTime;

          if (!resp.ok) {
            const errMsg = `Token exchange failed (${resp.status})`;
            LauncherLogger.logApiResponse(
              "POST",
              exchangeUrl,
              resp.status,
              durationMs,
              { error: errMsg },
            );

            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8",
              Connection: "close",
            });
            res.end(renderErrorHtml(SIGN_IN_FAILED_MESSAGE));
            opContext.terminate(
              "error",
              new MainIpcError(SIGN_IN_FAILED_MESSAGE),
            );
            return;
          }

          const json = await resp.json();
          // Security: Do not log full credential-bearing response objects at source
          LauncherLogger.logApiResponse(
            "POST",
            exchangeUrl,
            resp.status,
            durationMs,
          );

          if (
            !json?.token ||
            typeof json.token !== "string" ||
            !json.token.trim()
          ) {
            LauncherLogger.error(
              "[Auth] Token exchange failed: portal returned invalid token",
            );
            const err = new MainIpcError(SIGN_IN_FAILED_MESSAGE);
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8",
              Connection: "close",
            });
            res.end(renderErrorHtml(SIGN_IN_FAILED_MESSAGE));
            opContext.terminate("error", err);
            return;
          }

          const user = json.user;
          if (
            !user?.id ||
            !user?.name ||
            typeof user.id !== "string" ||
            typeof user.name !== "string" ||
            user.id.toLowerCase() === "account" ||
            user.id.toLowerCase() === "unverified-migration" ||
            user.id.toLowerCase() === "player" ||
            user.name.toLowerCase() === "player" ||
            user.name.toLowerCase() === "account" ||
            user.name.toLowerCase() === "unverified-migration"
          ) {
            LauncherLogger.error(
              "[Auth] Token exchange failed: portal returned invalid user identity",
            );
            const err = new MainIpcError(SIGN_IN_FAILED_MESSAGE);
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8",
              Connection: "close",
            });
            res.end(renderErrorHtml(SIGN_IN_FAILED_MESSAGE));
            opContext.terminate("error", err);
            return;
          }

          if (
            !isValidMinecraftUuid(user?.minecraftUuid) ||
            !user?.minecraftUsername
          ) {
            const err = new AuthRequiredError(NOT_LINKED_MESSAGE);
            LauncherLogger.error(
              "[Auth] Identity is missing a bound Minecraft UUID",
            );

            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8",
              Connection: "close",
            });
            res.end(renderErrorHtml(NOT_LINKED_MESSAGE));
            opContext.terminate("error", err);
            return;
          }

          // 8. Snapshot check immediately before committing credentials
          if (
            opContext.isTerminal() ||
            loginEpoch !== SessionManager.getActiveLoginEpoch() ||
            SessionManager.getSessionEpoch() !== generationSnapshot ||
            normalizePortalUrl(ConfigManager.get().portalUrl) !== portalUrl
          ) {
            res.writeHead(400, {
              "Content-Type": "text/html; charset=utf-8",
              Connection: "close",
            });
            res.end(
              renderErrorHtml(
                "This sign-in was replaced by a newer one. Go back to the launcher.",
              ),
            );
            pageSockets.add(req.socket);
            opContext.terminate(
              "superseded",
              new OperationConflictError("A newer sign-in replaced this one."),
            );
            return;
          }

          // 9. Persist credentials securely and establish NEW session
          SessionManager.establishNewSession(
            portalUrl,
            {
              token: json.token.trim(),
              refreshToken: json.refreshToken || undefined,
              minecraftAccessToken:
                user?.minecraftAccessToken || json.minecraftAccessToken,
              portalAccountId: user.id,
              portalUsername: user.name,
              minecraftUuid: user.minecraftUuid,
              minecraftUsername: user.minecraftUsername,
            },
            user,
          );

          LauncherLogger.info("[Auth Success] Session established");

          // 10. Display browser success ONLY after token exchange and session establishment succeed
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            Connection: "close",
          });
          res.end(renderSuccessHtml());

          const onResponseFinished = () => {
            opContext.settleSuccess({
              token: json.token.trim(),
              user,
            });
          };

          if (res.writableFinished || res.finished) {
            onResponseFinished();
          } else {
            res.once("finish", onResponseFinished);
            res.once("close", onResponseFinished);
          }
        } catch (err: any) {
          if (opContext.isTerminal()) return;
          try {
            res.writeHead(500, {
              "Content-Type": "text/html; charset=utf-8",
              Connection: "close",
            });
            res.end(renderErrorHtml());
          } catch {}
          LauncherLogger.error(
            `[Auth Error] loginWithPortal failed: ${err.message}`,
          );
          opContext.terminate("error", err);
        }
      });

      server.on("connection", (socket) => {
        clientSockets.add(socket);
        socket.once("close", () => {
          clientSockets.delete(socket);
          if (closeServerWhenIdle && clientSockets.size === 0) closeServer();
        });
      });

      server.on("error", (err: any) => {
        LauncherLogger.error(`[Auth] Loopback server error: ${err.message}`);
        opContext.terminate("server_error");
      });

      server.listen(0, "127.0.0.1", () => {
        try {
          const address = server.address() as any;
          const port = address.port;
          const authUrl = `${portalUrl}/auth/launcher?code_challenge=${encodeURIComponent(challenge)}&port=${port}&state=${encodeURIComponent(state)}`;
          opContext.authUrl = authUrl;
          opContext.callbackPort = port;
          LauncherLogger.info(
            `[Auth] Initiated portal login flow in browser at ${portalUrl} (callback port: ${port})`,
          );
          shell.openExternal(authUrl).catch((openErr: any) => {
            LauncherLogger.error(
              `[Auth] Failed to open external browser: ${openErr.message}`,
            );
            opContext.terminate(
              "browser_error",
              new MainIpcError(
                "Couldn't open your browser to sign in. Try again.",
              ),
            );
          });
        } catch (listenErr: any) {
          LauncherLogger.error(
            `[Auth] Sign-in callback setup failed: ${listenErr?.message || listenErr}`,
          );
          opContext.terminate(
            "server_error",
            new MainIpcError(signInStoppedMessage("server_error")),
          );
        }
      });
    });
  }

  /**
   * Refreshes the active session with request coalescing strictly scoped to (portalUrl, accountId, sessionEpoch).
   * Differentiates authentication refusal (401/403) from transport outages.
   */
  static refreshSession(
    _portalUrlOverride?: string,
  ): Promise<{ valid: boolean; user?: UserProfile; token?: string }> {
    const config = ConfigManager.get();
    if (!config.token && !config.refreshToken) {
      return Promise.resolve({ valid: false });
    }

    const portalUrl = normalizePortalUrl(config.portalUrl);
    const accountId =
      SessionManager.getCurrentRecord()?.portalAccountId || "unknown";
    const epoch = SessionManager.getSessionEpoch();

    return SessionManager.getCoalescedRefresh(portalUrl, accountId, epoch, () =>
      this.executeRefreshSession(portalUrl, epoch),
    );
  }

  private static async executeRefreshSession(
    portalUrl: string,
    generationSnapshot: number,
  ): Promise<{ valid: boolean; user?: UserProfile; token?: string }> {
    const config = ConfigManager.get();
    if (!config.token && !config.refreshToken) {
      return { valid: false };
    }

    // Session Origin Binding
    if (!config.sessionPortalUrl || config.sessionPortalUrl !== portalUrl) {
      LauncherLogger.warn(
        `[Auth Refresh] Session bound to '${config.sessionPortalUrl}' does not match active portal '${portalUrl}'`,
      );
      return { valid: false };
    }

    try {
      const refreshUrl = `${portalUrl}/api/v1/auth/refresh`;
      const startTime = Date.now();
      LauncherLogger.logApiRequest("POST", refreshUrl);

      const resp = await portalFetch(refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify({
          refreshToken: config.refreshToken,
          token: config.token,
        }),
      });
      const durationMs = Date.now() - startTime;

      // Check snapshot after await
      if (
        SessionManager.getSessionEpoch() !== generationSnapshot ||
        normalizePortalUrl(ConfigManager.get().portalUrl) !== portalUrl
      ) {
        LauncherLogger.warn(
          "[Auth Refresh] Aborted publishing refresh result: session was superseded or portal changed",
        );
        return { valid: false };
      }

      if (resp.ok) {
        const json = await resp.json();
        // Security: Redact tokens from source log payload
        LauncherLogger.logApiResponse(
          "POST",
          refreshUrl,
          resp.status,
          durationMs,
        );

        const user = json.user;
        if (
          !user?.minecraftUuid ||
          !isValidMinecraftUuid(user.minecraftUuid) ||
          !user?.minecraftUsername
        ) {
          LauncherLogger.warn(
            "[Auth Refresh] Session invalid: user lacks bound Minecraft UUID",
          );
          if (
            SessionManager.getSessionEpoch() === generationSnapshot &&
            normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
          ) {
            SessionManager.clearSession();
          }
          return { valid: false };
        }

        if (
          !json?.token ||
          typeof json.token !== "string" ||
          !json.token.trim()
        ) {
          LauncherLogger.warn(
            "[Auth Refresh] Refresh response omitted valid token string",
          );
          return { valid: false };
        }
        const currentRecord = SessionManager.getCurrentRecord();
        if (
          user?.id &&
          currentRecord?.portalAccountId &&
          currentRecord.portalAccountId !== "account" &&
          currentRecord.portalAccountId !== "unverified-migration" &&
          !currentRecord.portalAccountId.startsWith("config-account-") &&
          !currentRecord.portalAccountId.startsWith("session-account-") &&
          user.id !== currentRecord.portalAccountId
        ) {
          LauncherLogger.warn(
            "[Auth Refresh] Account identity mismatch on refresh",
          );
          return { valid: false };
        }

        const newToken = json.token.trim();
        const newRefreshToken = json.refreshToken || config.refreshToken;
        const newMcToken =
          user?.minecraftAccessToken ||
          json.minecraftAccessToken ||
          config.minecraftAccessToken;

        // Check snapshot immediately before updating credentials
        if (
          SessionManager.getSessionEpoch() !== generationSnapshot ||
          normalizePortalUrl(ConfigManager.get().portalUrl) !== portalUrl
        ) {
          return { valid: false };
        }

        let saveResult: SaveCredentialsResult;
        try {
          saveResult = SessionManager.updateSessionFromRefresh(
            portalUrl,
            {
              token: newToken,
              refreshToken: newRefreshToken,
              minecraftAccessToken: newMcToken,
            },
            user,
          );
        } catch (updateErr: any) {
          LauncherLogger.warn(
            `[Auth Refresh] Failed to commit refreshed session: ${updateErr.message}`,
          );
          return { valid: false };
        }

        if (!saveResult.success && !saveResult.sessionOnly) {
          LauncherLogger.warn(
            `[Auth Refresh] Refresh failed to persist and cannot run session-only: ${saveResult.error}`,
          );
          return { valid: false };
        }

        return {
          valid: true,
          token: newToken,
          user,
        };
      } else if (resp.status === 401 || resp.status === 403) {
        // Explicit auth refusal: clear session
        LauncherLogger.logApiResponse(
          "POST",
          refreshUrl,
          resp.status,
          durationMs,
        );
        if (
          SessionManager.getSessionEpoch() === generationSnapshot &&
          normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
        ) {
          SessionManager.clearSession();
        }
        return { valid: false };
      } else {
        LauncherLogger.logApiResponse(
          "POST",
          refreshUrl,
          resp.status,
          durationMs,
        );
        return { valid: false };
      }
    } catch (err: any) {
      if (
        err instanceof PortalRedirectPolicyError ||
        err?.name === "PortalRedirectPolicyError"
      ) {
        LauncherLogger.warn(`[Auth Refresh] Rejected redirect: ${err.message}`);
        if (
          SessionManager.getSessionEpoch() === generationSnapshot &&
          normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
        ) {
          SessionManager.clearSession();
        }
        return { valid: false };
      }
      LauncherLogger.logApiError(
        "POST",
        `${portalUrl}/api/v1/auth/refresh`,
        err,
      );
      return { valid: false };
    }
  }

  static async verifySession(
    _portalUrlOverride?: string,
  ): Promise<{ valid: boolean; user?: UserProfile }> {
    const config = ConfigManager.get();
    if (!config.token && !config.refreshToken) {
      return { valid: false };
    }

    const portalUrl = normalizePortalUrl(config.portalUrl);
    const generationSnapshot = SessionManager.getSessionEpoch();

    // Session Origin Binding
    if (!config.sessionPortalUrl || config.sessionPortalUrl !== portalUrl) {
      LauncherLogger.warn(
        `[Auth Verify] Session bound to '${config.sessionPortalUrl}' does not match active portal '${portalUrl}'`,
      );
      return { valid: false };
    }

    const verifyUrl = `${portalUrl}/api/v1/auth/verify`;

    try {
      const startTime = Date.now();
      LauncherLogger.logApiRequest("POST", verifyUrl);

      const resp = await portalFetch(verifyUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
        },
      });
      const durationMs = Date.now() - startTime;

      // Check snapshot after await
      if (
        SessionManager.getSessionEpoch() !== generationSnapshot ||
        normalizePortalUrl(ConfigManager.get().portalUrl) !== portalUrl
      ) {
        LauncherLogger.warn(
          "[Auth Verify] Aborted verify result: session was superseded or portal changed",
        );
        return { valid: false };
      }

      if (!resp.ok) {
        LauncherLogger.logApiResponse(
          "POST",
          verifyUrl,
          resp.status,
          durationMs,
        );

        // If 401 and refresh token exists, route through the coordinated refresh mechanism
        if (resp.status === 401 && config.refreshToken) {
          const refreshResult = await this.refreshSession();
          return { valid: refreshResult.valid, user: refreshResult.user };
        } else if (resp.status === 401 || resp.status === 403) {
          if (
            SessionManager.getSessionEpoch() === generationSnapshot &&
            normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
          ) {
            SessionManager.clearSession();
          }
          return { valid: false };
        }

        return { valid: false };
      }

      const json = await resp.json();
      LauncherLogger.logApiResponse("POST", verifyUrl, resp.status, durationMs);

      const user = json.user;
      if (
        !json.valid ||
        !user?.minecraftUuid ||
        !isValidMinecraftUuid(user.minecraftUuid) ||
        !user?.minecraftUsername
      ) {
        if (
          SessionManager.getSessionEpoch() === generationSnapshot &&
          normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
        ) {
          SessionManager.clearSession();
        }
        return { valid: false };
      }

      // Check snapshot immediately before updating tokens or returning success
      if (
        SessionManager.getSessionEpoch() !== generationSnapshot ||
        normalizePortalUrl(ConfigManager.get().portalUrl) !== portalUrl
      ) {
        return { valid: false };
      }

      if (user?.minecraftAccessToken) {
        try {
          const updateResult = SessionManager.updateSessionFromRefresh(
            portalUrl,
            {
              token: config.token!,
              refreshToken: config.refreshToken,
              minecraftAccessToken: user.minecraftAccessToken,
            },
            user,
          );
          if (!updateResult.success && !updateResult.sessionOnly) {
            LauncherLogger.warn(
              `[Auth Verify] Failed to update session: ${updateResult.error}`,
            );
            return { valid: false };
          }
        } catch (err: any) {
          LauncherLogger.warn(
            `[Auth Verify] Session update rejected: ${err.message}`,
          );
          return { valid: false };
        }
      } else {
        try {
          SessionManager.setCurrentUser(user);
        } catch (err: any) {
          LauncherLogger.warn(
            `[Auth Verify] User identity rejected: ${err.message}`,
          );
          return { valid: false };
        }
      }

      return {
        valid: true,
        user,
      };
    } catch (err: any) {
      if (
        err instanceof PortalRedirectPolicyError ||
        err?.name === "PortalRedirectPolicyError"
      ) {
        if (
          SessionManager.getSessionEpoch() === generationSnapshot &&
          normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
        ) {
          SessionManager.clearSession();
        }
        return { valid: false };
      }
      LauncherLogger.logApiError("POST", verifyUrl, err);
      return { valid: false };
    }
  }

  /**
   * Clears in-memory and persistent secrets and increments session epoch.
   * Note: Local logout does not terminate a running Minecraft subprocess or clear
   * browser session cookies in the system browser.
   * Returns explicit deletion outcomes.
   */
  static logout(): ClearCredentialsResult {
    LauncherAuth.cancelLogin();
    ConfigManager.clearSession();
    return SessionManager.clearSession();
  }
}
