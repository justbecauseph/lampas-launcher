import * as http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { shell } from "electron";
import { ConfigManager, normalizePortalUrl } from "./config";
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

export class LauncherAuth {
  static async loginWithPortal(portalUrlOverride?: string): Promise<{ token: string; user: UserProfile }> {
    const config = ConfigManager.get();
    const portalUrl = normalizePortalUrl(portalUrlOverride || config.portalUrl);
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString("hex");

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || "", `http://${req.headers.host}`);
          if (reqUrl.pathname === "/callback") {
            const code = reqUrl.searchParams.get("code");
            const returnedState = reqUrl.searchParams.get("state");

            if (!code || returnedState !== state) {
              res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
              res.end("<h3>Authentication Failed: Invalid code or state mismatch.</h3>");
              server.close();
              LauncherLogger.error("OAuth callback error: State mismatch or missing auth code");
              reject(new Error("State mismatch or missing auth code"));
              return;
            }

            // Render success page in browser
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`
              <!DOCTYPE html>
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
              </html>
            `);

            server.close();

            // Exchange authorization code for token
            const exchangeUrl = `${portalUrl}/api/v1/auth/exchange`;
            const startTime = Date.now();
            LauncherLogger.logApiRequest("POST", exchangeUrl, { code: "[REDACTED]" });

            const resp = await fetch(exchangeUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code, code_verifier: verifier }),
            });
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
              throw new Error(errMsg);
            }

            const json = await resp.json();
            LauncherLogger.logApiResponse("POST", exchangeUrl, resp.status, durationMs, json);

            const user = json.user;
            if (!user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
              const err = new Error("Minecraft account not bound: Please link your Minecraft Java account on the Lampas Portal dashboard.");
              LauncherLogger.error(`[Auth] User ${user?.name || user?.id} lacks bound Minecraft UUID`);
              throw err;
            }

            ConfigManager.set({
              token: json.token,
              refreshToken: json.refreshToken || undefined,
              minecraftAccessToken: user?.minecraftAccessToken || json.minecraftAccessToken,
            });

            LauncherLogger.info(`[Auth Success] Logged in as ${user.minecraftUsername} (UUID: ${user.minecraftUuid})`);

            resolve({
              token: json.token,
              user,
            });
          }
        } catch (err: any) {
          server.close();
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

      // Timeout after 3 minutes
      setTimeout(() => {
        server.close();
        LauncherLogger.warn("[Auth] Portal login timed out after 3 minutes");
        reject(new Error("Login timed out after 3 minutes"));
      }, 180000);
    });
  }

  static async refreshSession(portalUrlOverride?: string): Promise<{ valid: boolean; user?: UserProfile; token?: string }> {
    const config = ConfigManager.get();
    if (!config.token && !config.refreshToken) {
      return { valid: false };
    }

    const portalUrl = normalizePortalUrl(portalUrlOverride || config.portalUrl);

    // 1. Attempt token refresh via /api/v1/auth/refresh
    try {
      const refreshUrl = `${portalUrl}/api/v1/auth/refresh`;
      const startTime = Date.now();
      LauncherLogger.logApiRequest("POST", refreshUrl);

      const resp = await fetch(refreshUrl, {
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

      if (resp.ok) {
        const json = await resp.json();
        LauncherLogger.logApiResponse("POST", refreshUrl, resp.status, durationMs, json);

        const user = json.user;
        if (!user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
          LauncherLogger.warn("[Auth Refresh] Session invalid: user lacks bound Minecraft UUID");
          ConfigManager.set({ token: undefined, refreshToken: undefined, minecraftAccessToken: undefined });
          return { valid: false };
        }

        const newToken = json.token || config.token;
        const newRefreshToken = json.refreshToken || config.refreshToken;
        const newMcToken = user?.minecraftAccessToken || json.minecraftAccessToken || config.minecraftAccessToken;

        ConfigManager.set({
          token: newToken,
          refreshToken: newRefreshToken,
          minecraftAccessToken: newMcToken,
        });

        return {
          valid: true,
          token: newToken,
          user,
        };
      } else {
        LauncherLogger.logApiResponse("POST", refreshUrl, resp.status, durationMs);
      }
    } catch (err: any) {
      LauncherLogger.logApiError("POST", `${portalUrl}/api/v1/auth/refresh`, err);
      // Fall through to verifySession
    }

    // 2. Fallback to /api/v1/auth/verify
    return this.verifySession(portalUrl);
  }

  static async verifySession(portalUrlOverride?: string): Promise<{ valid: boolean; user?: UserProfile }> {
    const config = ConfigManager.get();
    if (!config.token && !config.refreshToken) {
      return { valid: false };
    }

    const portalUrl = normalizePortalUrl(portalUrlOverride || config.portalUrl);
    const verifyUrl = `${portalUrl}/api/v1/auth/verify`;

    try {
      const startTime = Date.now();
      LauncherLogger.logApiRequest("POST", verifyUrl);

      const resp = await fetch(verifyUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
        },
      });
      const durationMs = Date.now() - startTime;

      if (!resp.ok) {
        LauncherLogger.logApiResponse("POST", verifyUrl, resp.status, durationMs);

        // If 401 and refresh token exists, attempt refresh
        if (resp.status === 401 && config.refreshToken) {
          try {
            const refreshUrl = `${portalUrl}/api/v1/auth/refresh`;
            const refreshStart = Date.now();
            LauncherLogger.logApiRequest("POST", refreshUrl);

            const refreshResp = await fetch(refreshUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refreshToken: config.refreshToken }),
            });
            const refreshDur = Date.now() - refreshStart;

            if (refreshResp.ok) {
              const json = await refreshResp.json();
              LauncherLogger.logApiResponse("POST", refreshUrl, refreshResp.status, refreshDur, json);

              const user = json.user;
              if (!user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
                ConfigManager.set({ token: undefined, refreshToken: undefined, minecraftAccessToken: undefined });
                return { valid: false };
              }
              ConfigManager.set({
                token: json.token,
                refreshToken: json.refreshToken || config.refreshToken,
                minecraftAccessToken: user?.minecraftAccessToken || json.minecraftAccessToken,
              });
              return { valid: true, user };
            } else {
              LauncherLogger.logApiResponse("POST", refreshUrl, refreshResp.status, refreshDur);
            }
          } catch (refErr: any) {
            LauncherLogger.logApiError("POST", `${portalUrl}/api/v1/auth/refresh`, refErr);
          }
        }

        ConfigManager.set({ token: undefined, refreshToken: undefined, minecraftAccessToken: undefined });
        return { valid: false };
      }

      const json = await resp.json();
      LauncherLogger.logApiResponse("POST", verifyUrl, resp.status, durationMs, json);

      const user = json.user;
      if (!json.valid || !user?.minecraftUuid || user.minecraftUuid === "00000000-0000-0000-0000-000000000000" || !user?.minecraftUsername) {
        ConfigManager.set({ token: undefined, refreshToken: undefined, minecraftAccessToken: undefined });
        return { valid: false };
      }

      if (user?.minecraftAccessToken) {
        ConfigManager.set({
          minecraftAccessToken: user.minecraftAccessToken,
        });
      }
      return {
        valid: true,
        user,
      };
    } catch (err: any) {
      LauncherLogger.logApiError("POST", verifyUrl, err);
      return { valid: false };
    }
  }

  static logout() {
    ConfigManager.set({ token: undefined, refreshToken: undefined, minecraftAccessToken: undefined });
  }
}
