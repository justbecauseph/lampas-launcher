import * as http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { shell } from "electron";
import { ConfigManager, normalizePortalUrl, portalFetch, PortalRedirectPolicyError } from "./config";
import { SessionManager } from "./session-manager";
import type { UserProfile } from "./types";
import { LauncherLogger } from "./logger";

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

export class LauncherAuth {
  private static activeLoginCleanup: (() => void) | null = null;

  /**
   * Cancels any in-flight loopback OAuth login server and timer.
   */
  static cancelLogin(): void {
    if (this.activeLoginCleanup) {
      this.activeLoginCleanup();
      this.activeLoginCleanup = null;
    }
    SessionManager.advanceSessionEpoch();
  }

  static async loginWithPortal(_portalUrlOverride?: string): Promise<{ token: string; user: UserProfile }> {
    // Clean up any superseding or previous in-flight login
    if (this.activeLoginCleanup) {
      this.activeLoginCleanup();
      this.activeLoginCleanup = null;
    }

    const loginEpoch = SessionManager.nextLoginEpoch();
    const config = ConfigManager.get();
    const portalUrl = normalizePortalUrl(config.portalUrl);
    const generationSnapshot = SessionManager.getSessionEpoch();
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString("hex");

    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | null = null;
      let exchanged = false;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        try {
          server.close();
        } catch {}
        if (LauncherAuth.activeLoginCleanup === cleanup) {
          LauncherAuth.activeLoginCleanup = null;
        }
      };

      LauncherAuth.activeLoginCleanup = cleanup;

      const server = http.createServer(async (req, res) => {
        try {
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
            cleanup();
            LauncherLogger.warn("[Auth] OAuth login denied or cancelled by user on portal.");
            reject(new Error("Authentication was denied or cancelled by user"));
            return;
          }

          // Noise or invalid state probe: reject request without terminating server
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
            loginEpoch !== SessionManager.getActiveLoginEpoch() ||
            SessionManager.getSessionEpoch() !== generationSnapshot ||
            normalizePortalUrl(currentConfig.portalUrl) !== portalUrl
          ) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Authentication session was superseded or cancelled."));
            cleanup();
            LauncherLogger.warn("[Auth] Rejected late OAuth callback: active portal changed or login was superseded.");
            reject(new Error("Authentication session was invalidated or portal changed during login flow"));
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
            });
          } catch (netErr: any) {
            res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Network error communicating with the portal."));
            cleanup();
            reject(netErr);
            return;
          }

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
            LauncherLogger.logApiResponse("POST", exchangeUrl, resp.status, durationMs, errMsg);

            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Token exchange failed. Please try logging in again."));
            cleanup();
            reject(new Error(errMsg));
            return;
          }

          const json = await resp.json();
          LauncherLogger.logApiResponse("POST", exchangeUrl, resp.status, durationMs, json);

          const user = json.user;
          if (!user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
            const err = new Error("Minecraft account not bound: Please link your Minecraft Java account on the Lampas Portal dashboard.");
            LauncherLogger.error(`[Auth] User ${user?.name || user?.id} lacks bound Minecraft UUID`);

            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Minecraft account not bound. Please link your Minecraft Java account on the portal dashboard."));
            cleanup();
            reject(err);
            return;
          }

          // 8. Snapshot check immediately before committing credentials
          if (
            loginEpoch !== SessionManager.getActiveLoginEpoch() ||
            SessionManager.getSessionEpoch() !== generationSnapshot ||
            normalizePortalUrl(ConfigManager.get().portalUrl) !== portalUrl
          ) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml("Authentication session was superseded or cancelled."));
            cleanup();
            reject(new Error("Authentication session was invalidated or portal changed during token exchange"));
            return;
          }

          // 9. Persist credentials securely and establish session
          await SessionManager.establishSession(portalUrl, {
            token: json.token,
            refreshToken: json.refreshToken || undefined,
            minecraftAccessToken: user?.minecraftAccessToken || json.minecraftAccessToken,
          }, user);

          LauncherLogger.info(`[Auth Success] Logged in as ${user.minecraftUsername} (UUID: ${user.minecraftUuid})`);

          // 10. Display browser success ONLY after token exchange and session establishment succeed
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderSuccessHtml());

          cleanup();
          resolve({
            token: json.token,
            user,
          });
        } catch (err: any) {
          try {
            res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderErrorHtml());
          } catch {}
          cleanup();
          LauncherLogger.error(`[Auth Error] loginWithPortal failed: ${err.message}`);
          reject(err);
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as any;
        const port = address.port;
        const authUrl = `${portalUrl}/auth/launcher?code_challenge=${encodeURIComponent(challenge)}&port=${port}&state=${encodeURIComponent(state)}`;
        LauncherLogger.info(`[Auth] Initiated portal login flow in browser at ${portalUrl} (callback port: ${port})`);
        shell.openExternal(authUrl);
      });

      // Timeout after 3 minutes (180s)
      timeoutId = setTimeout(() => {
        cleanup();
        LauncherLogger.warn("[Auth] Portal login timed out after 3 minutes");
        reject(new Error("Login timed out after 3 minutes"));
      }, 180000);
    });
  }

  /**
   * Refreshes the active session with single-flight request coalescing.
   * Differentiates authentication refusal (401/403) from temporary transport outages.
   */
  static refreshSession(_portalUrlOverride?: string): Promise<{ valid: boolean; user?: UserProfile; token?: string }> {
    const existing = SessionManager.getActiveRefreshPromise();
    if (existing) {
      return existing;
    }

    let refreshTask!: Promise<{ valid: boolean; user?: UserProfile; token?: string }>;
    refreshTask = (async () => {
      try {
        return await this.executeRefreshSession();
      } finally {
        if (SessionManager.getActiveRefreshPromise() === refreshTask) {
          SessionManager.setActiveRefreshPromise(null);
        }
      }
    })();

    SessionManager.setActiveRefreshPromise(refreshTask);
    return refreshTask;
  }

  private static async executeRefreshSession(): Promise<{ valid: boolean; user?: UserProfile; token?: string }> {
    const config = ConfigManager.get();
    if (!config.token && !config.refreshToken) {
      return { valid: false };
    }

    const portalUrl = normalizePortalUrl(config.portalUrl);
    const generationSnapshot = SessionManager.getSessionEpoch();

    // Session Origin Binding
    if (!config.sessionPortalUrl || config.sessionPortalUrl !== portalUrl) {
      LauncherLogger.warn(`[Auth Refresh] Session bound to '${config.sessionPortalUrl}' does not match active portal '${portalUrl}'`);
      return { valid: false };
    }

    // 1. Attempt token refresh via /api/v1/auth/refresh
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
        LauncherLogger.logApiResponse("POST", refreshUrl, resp.status, durationMs, json);

        const user = json.user;
        if (!user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
          LauncherLogger.warn("[Auth Refresh] Session invalid: user lacks bound Minecraft UUID");
          if (
            SessionManager.getSessionEpoch() === generationSnapshot &&
            normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
          ) {
            await SessionManager.clearSession();
          }
          return { valid: false };
        }

        const newToken = json.token || config.token;
        const newRefreshToken = json.refreshToken || config.refreshToken;
        const newMcToken = user?.minecraftAccessToken || json.minecraftAccessToken || config.minecraftAccessToken;

        // Check snapshot immediately before establishing credentials
        if (
          SessionManager.getSessionEpoch() !== generationSnapshot ||
          normalizePortalUrl(ConfigManager.get().portalUrl) !== portalUrl
        ) {
          return { valid: false };
        }

        await SessionManager.establishSession(portalUrl, {
          token: newToken,
          refreshToken: newRefreshToken,
          minecraftAccessToken: newMcToken,
        }, user);

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
          await SessionManager.clearSession();
        }
        return { valid: false };
      } else {
        LauncherLogger.logApiResponse("POST", refreshUrl, resp.status, durationMs);
      }
    } catch (err: any) {
      if (err instanceof PortalRedirectPolicyError || err?.name === "PortalRedirectPolicyError") {
        LauncherLogger.warn(`[Auth Refresh] Rejected redirect: ${err.message}`);
        if (
          SessionManager.getSessionEpoch() === generationSnapshot &&
          normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
        ) {
          await SessionManager.clearSession();
        }
        return { valid: false };
      }
      LauncherLogger.logApiError("POST", `${portalUrl}/api/v1/auth/refresh`, err);
      // Fall through to verifySession
    }

    // Check snapshot before fallback
    if (
      SessionManager.getSessionEpoch() !== generationSnapshot ||
      normalizePortalUrl(ConfigManager.get().portalUrl) !== portalUrl
    ) {
      return { valid: false };
    }

    // 2. Fallback to /api/v1/auth/verify
    return this.verifySession();
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

        // If 401 and refresh token exists, attempt refresh
        if (resp.status === 401 && config.refreshToken) {
          try {
            const refreshUrl = `${portalUrl}/api/v1/auth/refresh`;
            const refreshStart = Date.now();
            LauncherLogger.logApiRequest("POST", refreshUrl);

            const refreshResp = await portalFetch(refreshUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refreshToken: config.refreshToken }),
            });
            const refreshDur = Date.now() - refreshStart;

            // Check snapshot after refresh await
            if (
              SessionManager.getSessionEpoch() !== generationSnapshot ||
              normalizePortalUrl(ConfigManager.get().portalUrl) !== portalUrl
            ) {
              return { valid: false };
            }

            if (refreshResp.ok) {
              const json = await refreshResp.json();
              LauncherLogger.logApiResponse("POST", refreshUrl, refreshResp.status, refreshDur, json);

              const user = json.user;
              if (!user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
                if (
                  SessionManager.getSessionEpoch() === generationSnapshot &&
                  normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
                ) {
                  await SessionManager.clearSession();
                }
                return { valid: false };
              }

              // Check snapshot immediately before establishing credentials
              if (
                SessionManager.getSessionEpoch() !== generationSnapshot ||
                normalizePortalUrl(ConfigManager.get().portalUrl) !== portalUrl
              ) {
                return { valid: false };
              }

              await SessionManager.establishSession(portalUrl, {
                token: json.token,
                refreshToken: json.refreshToken || config.refreshToken,
                minecraftAccessToken: user?.minecraftAccessToken || json.minecraftAccessToken,
              }, user);
              return { valid: true, user };
            } else if (refreshResp.status === 401 || refreshResp.status === 403) {
              LauncherLogger.logApiResponse("POST", refreshUrl, refreshResp.status, refreshDur);
              if (
                SessionManager.getSessionEpoch() === generationSnapshot &&
                normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
              ) {
                await SessionManager.clearSession();
              }
              return { valid: false };
            }
          } catch (refErr: any) {
            if (refErr instanceof PortalRedirectPolicyError || refErr?.name === "PortalRedirectPolicyError") {
              if (
                SessionManager.getSessionEpoch() === generationSnapshot &&
                normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
              ) {
                await SessionManager.clearSession();
              }
              return { valid: false };
            }
            LauncherLogger.logApiError("POST", `${portalUrl}/api/v1/auth/refresh`, refErr);
          }
        } else if (resp.status === 401 || resp.status === 403) {
          // Verify 401 without refreshToken or 403: clear session
          if (
            SessionManager.getSessionEpoch() === generationSnapshot &&
            normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
          ) {
            await SessionManager.clearSession();
          }
          return { valid: false };
        }

        return { valid: false };
      }

      const json = await resp.json();
      LauncherLogger.logApiResponse("POST", verifyUrl, resp.status, durationMs, json);

      const user = json.user;
      if (!json.valid || !user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
        if (
          SessionManager.getSessionEpoch() === generationSnapshot &&
          normalizePortalUrl(ConfigManager.get().portalUrl) === portalUrl
        ) {
          await SessionManager.clearSession();
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
        await SessionManager.establishSession(portalUrl, {
          token: config.token!,
          refreshToken: config.refreshToken,
          minecraftAccessToken: user.minecraftAccessToken,
        }, user);
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
          await SessionManager.clearSession();
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
   */
  static logout(): void {
    LauncherAuth.cancelLogin();
    ConfigManager.clearSession();
  }
}
