import type { RendererUserProfile } from "../types";
import { formatFriendlyError } from "../utils";

export interface AuthViewOptions {
  showToast: (message: string, type: "info" | "success" | "error", duration?: number) => void;
  getPortalUrl: () => string;
  onUserChanged: (user: RendererUserProfile | null) => void;
}

export function initAuthView(options: AuthViewOptions): {
  updateUserUI: (user: RendererUserProfile | null) => void;
  getCurrentUser: () => RendererUserProfile | null;
  dispose: () => void;
} {
  const { showToast, getPortalUrl, onUserChanged } = options;

  const btnLogin = document.getElementById("btn-login") as HTMLButtonElement | null;
  const btnLogout = document.getElementById("btn-logout") as HTMLButtonElement | null;
  const userCard = document.getElementById("user-card") as HTMLElement | null;
  const userName = document.getElementById("user-name") as HTMLElement | null;
  const userRole = document.getElementById("user-role") as HTMLElement | null;
  const userAvatar = document.getElementById("user-avatar") as HTMLElement | null;

  let currentUser: RendererUserProfile | null = null;

  function updateUserUI(user: RendererUserProfile | null): void {
    currentUser = user;
    if (user) {
      if (btnLogin) btnLogin.classList.add("hidden");
      if (userCard) userCard.classList.remove("hidden");
      const displayName = user.minecraftUsername || user.name || (user as any).discordTag || "Lampas Player";
      if (userName) userName.innerText = displayName;
      if (userRole) {
        if (user.isAdmin) {
          userRole.innerText = "ADMINISTRATOR";
          userRole.className = "badge text-rose-400 border-rose-500/30 bg-rose-950/30";
        } else if (user.isTech) {
          userRole.innerText = "TECH TEAM";
          userRole.className = "badge text-amber-400 border-amber-500/30 bg-amber-950/30";
        } else {
          userRole.innerText = "MEMBER";
          userRole.className = "badge text-cyan-400 border-cyan-500/30 bg-cyan-950/30";
        }
      }
      if (userAvatar) {
        const fallbackInitial = displayName[0]?.toUpperCase() || "P";
        const identifier = user.minecraftUuid && user.minecraftUuid !== "00000000-0000-0000-0000-000000000000"
          ? user.minecraftUuid.replace(/-/g, "")
          : (user.minecraftUsername || displayName);

        userAvatar.replaceChildren();
        if (identifier) {
          const img = document.createElement("img");
          img.src = `https://mc-heads.net/avatar/${encodeURIComponent(identifier)}/64`;
          img.alt = `${displayName}'s avatar`;
          img.onerror = () => {
            userAvatar.replaceChildren();
            userAvatar.innerText = fallbackInitial;
          };
          userAvatar.appendChild(img);
        } else {
          userAvatar.innerText = fallbackInitial;
        }
      }
    } else {
      if (btnLogin) btnLogin.classList.remove("hidden");
      if (userCard) userCard.classList.add("hidden");
      if (userAvatar) {
        userAvatar.replaceChildren();
        userAvatar.innerText = "P";
      }
    }
    onUserChanged(currentUser);
  }

  if (btnLogin) {
    btnLogin.onclick = async () => {
      try {
        btnLogin.disabled = true;
        btnLogin.innerText = "LOGGING IN...";
        const res = await window.lampas.auth.login();
        updateUserUI(res.user);
        showToast(`Welcome, ${res.user.minecraftUsername || res.user.name}!`, "success");
        try {
          const storageStatus = await window.lampas.auth.getStorageStatus();
          if (storageStatus.sessionOnly) {
            showToast("Session-only mode active: credentials will not persist across restarts.", "info");
          } else if (storageStatus.lastPersistenceError) {
            showToast(`Storage warning: ${storageStatus.lastPersistenceError}`, "error");
          }
        } catch {}
      } catch (err: any) {
        showToast(`Login failed: ${formatFriendlyError(err)}`, "error");
      } finally {
        if (btnLogin) {
          btnLogin.disabled = false;
          btnLogin.innerText = "LOG IN WITH PORTAL";
        }
      }
    };
  }

  if (btnLogout) {
    btnLogout.onclick = async () => {
      try {
        const logoutResult = await window.lampas.auth.logout();
        updateUserUI(null);
        if (logoutResult && !logoutResult.success) {
          showToast(`Logout warning: Persistent cleanup incomplete (${logoutResult.error || "cleanup error"})`, "error");
        } else if (logoutResult && logoutResult.success) {
          showToast("Logged out successfully.", "info");
        } else {
          showToast("Logged out (session cleared). Persistent cleanup unverified.", "error");
        }
      } catch (err: any) {
        showToast(`Could not log out: ${formatFriendlyError(err)}`, "error");
      }
    };
  }

  return {
    updateUserUI,
    getCurrentUser: () => currentUser,
    dispose: () => {
      // Nothing to unbind on window
    },
  };
}
