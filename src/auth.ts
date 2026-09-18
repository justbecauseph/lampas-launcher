import * as http from "node:http";
import * as net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { shell } from "electron";
import { ConfigManager, normalizePortalUrl, portalFetch, PortalRedirectPolicyError } from "./config";
import { SessionManager } from "./session-manager";
import { type ClearCredentialsResult } from "./credential-store";
import type { UserProfile } from "./types";
import { LauncherLogger } from "./logger";
import { OperationConflictError, UserCancelledError } from "./ipc-boundary";

export const LOGIN_TIMEOUT_MS = 120_000; // 120 seconds (2 minutes) timeout

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkce() {
  const verifier = base64Url(randomBytes(32));
  const hash = createHash("sha256").update(verifier).digest();
  const challenge = base64Url(hash);
  return { verifier, challenge };
}

function renderSuccessHtml(): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <title>Lampas Launcher - Logged In</title>
    <style>
      body { background: #030712; color: #f9fafb; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .card { background: #111827; border: 1px solid #1f2937; padding: 2.5rem; border-radius: 1.5rem; text-align: center; max-width: 400px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
      .check { color: #10b981; font-size: 3rem; margin-bottom: 0.5rem; }
      h2 { margin: 0 0 0.5rem 0; font-size: 1.25rem; font-weight: 700; }
      p { color: #9ca3af; font-size: 0.875rem; margin: 0; }
      .countdown { margin-top: 1.25rem; font-size: 0.75rem; color: #64748b; font-family: monospace; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="check">✓</div>
      <h2>Logged in to Lampas!</h2>
      <p>You can close this tab and return to the launcher.</p>
      <div id="timer" class="countdown">Closing in 5 seconds...</div>
    </div>
    <script>
      let remaining = 5;
      const timerEl = document.getElementById("timer");
      const countdownInterval = setInterval(() => {
        remaining--;
        if (timerEl && remaining > 0) {
          timerEl.innerText = "Closing in " + remaining + " second" + (remaining === 1 ? "" : "s") + "...";
        }
        if (remaining <= 0) {
          clearInterval(countdownInterval);
          window.close();
        }
      }, 1000);
      setTimeout(() => window.close(), 5000);
    </script>
  </body>
</html>`;
}

function renderErrorHtml(message: string = "Authentication failed. Please return to the launcher and try again."): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <title>Lampas Launcher - Authentication Error</title>
    <style>
      body { background: #030712; color: #f9fafb; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .card { background: #111827; border: 1px solid #1f2937; padding: 2.5rem; border-radius: 1.5rem; text-align: center; max-width: 400px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
      .err { color: #ef4444; font-size: 3rem; margin-bottom: 0.5rem; }
      h2 { margin: 0 0 0.5rem 0; font-size: 1.25rem; font-weight: 700; }
      p { color: #9ca3af; font-size: 0.875rem; margin: 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="err">✕</div>
      <h2>Authentication Error</h2>
      <p>${message}</p>
    </div>
  </body>
</html>`;
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
    reason: "timeout" | "cancelled" | "superseded" | "denied" | "shutdown" | "server_error" | "browser_error" | "error",
    err?: Error
  ): void;
  settleSuccess(data: { token: string; user: UserProfile }): void;
}

export class LauncherAuth {
  private static activeLoginContext: LoginOperationContext | null = null;

  /**
   * Cancels any in-flight loopback OAuth login server, aborts requests, and terminates context.
   */
  static cancelLogin(): void {
    if (this.activeLoginContext) {
      this.activeLoginContext.terminate("cancelled", new UserCancelledError("Authentication cancelled by user."));
      this.activeLoginContext = null;
    }
    SessionManager.advanceSessionEpoch();
  }

  static async loginWithPortal(_portalUrlOverride?: string): Promise<{ token: string; user: UserProfile }> {
    // 1. Supersede any existing in-flight login operation
    if (this.activeLoginContext) {
      this.activeLoginContext.terminate(
        "superseded",
        new OperationConflictError("Login was superseded by a new login request.")
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

      const settleOnce = (result: { success: true; data: { token: string; user: UserProfile } } | { success: false; error: Error }) => {
        if (isSettled) return;
        isSettled = true;

        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }

        // Close sockets and server
        for (const socket of clientSockets) {
          try {
            socket.destroy();
          } catch {}
        }
        clientSockets.clear();

        try {
          server.close();
        } catch {}

        if (LauncherAuth.activeLoginContext === opContext) {
          LauncherAuth.activeLoginContext = null;
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
          const finalError = err || new Error(`Login terminated: ${reason}`);
          settleOnce({ success: false, error: finalError });
        },
        settleSuccess: (data) => {
          settleOnce({ success: true, data });
        },
      };

      LauncherAuth.activeLoginContext = opContext;

      // 120-second terminal deadline
      timeoutTimer = setTimeout(() => {
        LauncherLogger.warn("[Auth] Portal login timed out after 120 seconds.");
        opContext.terminate("timeout", new Error("Login timed out after 120 seconds."));
      }, LOGIN_TIMEOUT_MS);

      const server = http.createServer(async (req, res) => {
        try {
          // Terminal barrier: ignore requests if already settled
          if (opContext.isTerminal()) {
            try {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Login session is no longer active");
            } catch {}
            return;
          }

          // 1. Method constraint
          if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "text/plain" });
            res.end("Method Not Allowed");
            return;
          }

          // 2. Request URI length limit
          if ((req.url || "").length > 2048) {
            res.writeHead(414, { "Content-Type": "text/plain" });
            res.end("URI Too Long");
            return;
          }

          // 3. Host header validation (reject DNS rebinding)
          const port = (server.address() as any)?.port;
          const hostHeader = (req.headers.host || "").toLowerCase();
          const expectedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
          if (!expectedHosts.includes(hostHeader)) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad Request: Host header mismatch");
            return;
          }

          let reqUrl: URL;
          try {
            reqUrl = new URL(req.url || "", `http://127.0.0.1:${port}`);
          } catch {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad Request: Malformed URL");
            return;
          }

          // 4. Noise handling: ignore non-callback paths without closing server
          if (reqUrl.pathname !== "/callback") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
          }

          const code = reqUrl.searchParams.get("code");
          const returnedState = reqUrl.searchParams.get("state");
          const oauthError = reqUrl.searchParams.get("error");

          // Handle legitimate OAuth denial/cancellation from portal
          if (oauthError && returnedState === state) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Authentication was denied or cancelled on the portal."));
            LauncherLogger.warn("[Auth] OAuth login denied or cancelled by user on portal.");
            opContext.terminate("denied", new Error("Authentication was denied or cancelled by user"));
            return;
          }

          // Noise or invalid state probe: reject request without terminating valid pending server
          if (!code || returnedState !== state) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad Request: Invalid callback state or missing code");
            return;
          }

          // 5. Single-use exchange enforcement
          if (exchanged) {
            res.writeHead(409, { "Content-Type": "text/plain" });
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
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Authentication session was superseded or cancelled."));
            opContext.terminate("superseded", new Error("Authentication session was invalidated or portal changed during login flow"));
            return;
          }

          // 7. Exchange authorization code for token
          const exchangeUrl = `${portalUrl}/api/v1/auth/exchange`;
          const startTime = Date.now();
          LauncherLogger.logApiRequest("POST", exchangeUrl, { code: "[REDACTED]" });

          let resp: Response;
          try {
            resp = await portalFetch(exchangeUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code, code_verifier: verifier }),
              signal: abortController.signal,
            });
          } catch (netErr: any) {
            if (opContext.isTerminal()) return;
            res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Network error communicating with the portal."));
            opContext.terminate("error", netErr);
            return;
          }

          if (opContext.isTerminal()) return;
          const durationMs = Date.now() - startTime;

          if (!resp.ok) {
            let errMsg = `Token exchange failed (${resp.status})`;
            try {
              const errJson = await resp.json();
              if (errJson?.error) errMsg = errJson.error;
            } catch {
              try {
                const errText = await resp.text();
                if (errText) errMsg = `${errMsg}: ${errText}`;
              } catch {}
            }
            LauncherLogger.logApiResponse("POST", exchangeUrl, resp.status, durationMs, { error: errMsg });

            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Token exchange failed. Please try logging in again."));
            opContext.terminate("error", new Error(errMsg));
            return;
          }

          const json = await resp.json();
          // Security: Do not log full credential-bearing response objects at source
          LauncherLogger.logApiResponse("POST", exchangeUrl, resp.status, durationMs, {
            user: json.user?.name || json.user?.id,
            minecraftUsername: json.user?.minecraftUsername,
            status: "token_issued",
          });

          if (!json?.token || typeof json.token !== "string" || !json.token.trim()) {
            const err = new Error("Token exchange failed: portal returned invalid token");
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Token exchange failed. Server returned invalid token."));
            opContext.terminate("error", err);
            return;
          }

          const user = json.user;
          if (!user?.id || !user?.name || typeof user.id !== "string" || typeof user.name !== "string" || user.id === "account" || user.id === "unverified-migration") {
            const err = new Error("Token exchange failed: portal returned invalid user identity");
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Token exchange failed. Server returned invalid user identity."));
            opContext.terminate("error", err);
            return;
          }

          if (!user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
            const err = new Error("Minecraft account not bound: Please link your Minecraft Java account on the Lampas Portal dashboard.");
            LauncherLogger.error(`[Auth] User ${user?.name || user?.id} lacks bound Minecraft UUID`);

            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Minecraft account not bound. Please link your Minecraft Java account on the portal dashboard."));
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
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Authentication session was superseded or cancelled."));
            opContext.terminate("superseded", new Error("Authentication session was invalidated or portal changed during token exchange"));
            return;
          }

          // 9. Persist credentials securely and establish NEW session
          SessionManager.establishNewSession(
            portalUrl,
            {
              token: json.token.trim(),
              refreshToken: json.refreshToken || undefined,
              minecraftAccessToken: user?.minecraftAccessToken || json.minecraftAccessToken,
              portalAccountId: user.id,
              portalUsername: user.name,
              minecraftUuid: user.minecraftUuid,
              minecraftUsername: user.minecraftUsername,
            },
            user
          );

          LauncherLogger.info(`[Auth Success] Logged in as ${user.minecraftUsername} (UUID: ${user.minecraftUuid})`);

          // 10. Display browser success ONLY after token exchange and session establishment succeed
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderSuccessHtml());

          opContext.settleSuccess({
            token: json.token.trim(),
            user,
          });
        } catch (err: any) {
          if (opContext.isTerminal()) return;
          try {
            res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml());
          } catch {}
          LauncherLogger.error(`[Auth Error] loginWithPortal failed: ${err.message}`);
          opContext.terminate("error", err);
        }
      });

      server.on("connection", (socket) => {
        clientSockets.add(socket);
        socket.once("close", () => clientSockets.delete(socket));
      });

      server.on("error", (err: any) => {
        LauncherLogger.error(`[Auth] Loopback server error: ${err.message}`);
        opContext.terminate("server_error", new Error(`Loopback callback server failed: ${err.message}`));
      });

      server.listen(0, "127.0.0.1", () => {
        try {
          const address = server.address() as any;
          const port = address.port;
          const authUrl = `${portalUrl}/auth/launcher?code_challenge=${encodeURIComponent(challenge)}&port=${port}&state=${encodeURIComponent(state)}`;
          opContext.authUrl = authUrl;
          opContext.callbackPort = port;
          LauncherLogger.info(`[Auth] Initiated portal login flow in browser at ${portalUrl} (callback port: ${port})`);
          shell.openExternal(authUrl).catch((openErr: any) => {
            LauncherLogger.error(`[Auth] Failed to open external browser: ${openErr.message}`);
            opContext.terminate("browser_error", new Error(`Failed to open browser for authentication: ${openErr.message}`));
          });
        } catch (listenErr: any) {
          opContext.terminate("server_error", listenErr);
        }
      });
    });
  }

  /**
   * Refreshes the active session with request coalescing strictly scoped to (portalUrl, accountId, sessionEpoch).
   * Differentiates authentication refusal (401/403) from transport outages.
   */
  static refreshSession(_portalUrlOverride?: string): Promise<{ valid: boolean; user?: UserProfile; token?: string }> {
    const config = ConfigManager.get();
    if (!config.token && !config.refreshToken) {
      return Promise.resolve({ valid: false });
    }

    const portalUrl = normalizePortalUrl(config.portalUrl);
    const accountId = SessionManager.getCurrentRecord()?.portalAccountId || "unknown";
    const epoch = SessionManager.getSessionEpoch();

    return SessionManager.getCoalescedRefresh(portalUrl, accountId, epoch, () =>
      this.executeRefreshSession(portalUrl, epoch)
    );
  }

  private static async executeRefreshSession(
    portalUrl: string,
    generationSnapshot: number
  ): Promise<{ valid: boolean; user?: UserProfile; token?: string }> {
    const config = ConfigManager.get();
    if (!config.token && !config.refreshToken) {
      return { valid: false };
    }

    // Session Origin Binding
    if (!config.sessionPortalUrl || config.sessionPortalUrl !== portalUrl) {
      LauncherLogger.warn(`[Auth Refresh] Session bound to '${config.sessionPortalUrl}' does not match active portal '${portalUrl}'`);
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
        LauncherLogger.warn("[Auth Refresh] Aborted publishing refresh result: session was superseded or portal changed");
        return { valid: false };
      }

      if (resp.ok) {
        const json = await resp.json();
        // Security: Redact tokens from source log payload
        LauncherLogger.logApiResponse("POST", refreshUrl, resp.status, durationMs, {
          user: json.user?.name || json.user?.id,
          minecraftUsername: json.user?.minecraftUsername,
          status: "token_refreshed",
        });

        const user = json.user;
        if (!user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
          LauncherLogger.warn("[Auth Refresh] Session invalid: user lacks bound Minecraft UUID");
          if (
            SessionManager.getSessionEpoch() === generationSnapshot &&
            normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
          ) {
            SessionManager.clearSession();
          }
          return { valid: false };
        }

        if (!json?.token || typeof json.token !== "string" || !json.token.trim()) {
          LauncherLogger.warn("[Auth Refresh] Refresh response omitted valid token string");
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
          LauncherLogger.warn(`[Auth Refresh] Account identity mismatch on refresh: expected ${currentRecord.portalAccountId}, got ${user.id}`);
          return { valid: false };
        }

        const newToken = json.token.trim();
        const newRefreshToken = json.refreshToken || config.refreshToken;
        const newMcToken = user?.minecraftAccessToken || json.minecraftAccessToken || config.minecraftAccessToken;

        // Check snapshot immediately before updating credentials
        if (
          SessionManager.getSessionEpoch() !== generationSnapshot ||
          normalizePortalUrl(ConfigManager.get().portalUrl) !== portalUrl
        ) {
          return { valid: false };
        }

        SessionManager.updateSessionFromRefresh(
          portalUrl,
          {
            token: newToken,
            refreshToken: newRefreshToken,
            minecraftAccessToken: newMcToken,
          },
          user
        );

        return {
          valid: true,
          token: newToken,
          user,
        };
      } else if (resp.status === 401 || resp.status === 403) {
        // Explicit auth refusal: clear session
        LauncherLogger.logApiResponse("POST", refreshUrl, resp.status, durationMs);
        if (
          SessionManager.getSessionEpoch() === generationSnapshot &&
          normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
        ) {
          SessionManager.clearSession();
        }
        return { valid: false };
      } else {
        LauncherLogger.logApiResponse("POST", refreshUrl, resp.status, durationMs);
        return { valid: false };
      }
    } catch (err: any) {
      if (err instanceof PortalRedirectPolicyError || err?.name === "PortalRedirectPolicyError") {
        LauncherLogger.warn(`[Auth Refresh] Rejected redirect: ${err.message}`);
        if (
          SessionManager.getSessionEpoch() === generationSnapshot &&
          normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
        ) {
          SessionManager.clearSession();
        }
        return { valid: false };
      }
      LauncherLogger.logApiError("POST", `${portalUrl}/api/v1/auth/refresh`, err);
      return { valid: false };
    }
  }

  static async verifySession(_portalUrlOverride?: string): Promise<{ valid: boolean; user?: UserProfile }> {
    const config = ConfigManager.get();
    if (!config.token && !config.refreshToken) {
      return { valid: false };
    }

    const portalUrl = normalizePortalUrl(config.portalUrl);
    const generationSnapshot = SessionManager.getSessionEpoch();

    // Session Origin Binding
    if (!config.sessionPortalUrl || config.sessionPortalUrl !== portalUrl) {
      LauncherLogger.warn(`[Auth Verify] Session bound to '${config.sessionPortalUrl}' does not match active portal '${portalUrl}'`);
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
        LauncherLogger.warn("[Auth Verify] Aborted verify result: session was superseded or portal changed");
        return { valid: false };
      }

      if (!resp.ok) {
        LauncherLogger.logApiResponse("POST", verifyUrl, resp.status, durationMs);

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
      LauncherLogger.logApiResponse("POST", verifyUrl, resp.status, durationMs, {
        valid: json.valid,
        user: json.user?.name || json.user?.id,
      });

      const user = json.user;
      if (!json.valid || !user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
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
        SessionManager.updateSessionFromRefresh(
          portalUrl,
          {
            token: config.token!,
            refreshToken: config.refreshToken,
            minecraftAccessToken: user.minecraftAccessToken,
          },
          user
        );
      } else {
        SessionManager.setCurrentUser(user);
      }

      return {
        valid: true,
        user,
      };
    } catch (err: any) {
      if (err instanceof PortalRedirectPolicyError || err?.name === "PortalRedirectPolicyError") {
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
