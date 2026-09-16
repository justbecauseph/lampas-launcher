import type { RendererUserProfile } from "../types";

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
  const userAvatar = document.getElementById("user-avatar") as HTMLImageElement | null;

  let currentUser: RendererUserProfile | null = null;

  function updateUserUI(user: RendererUserProfile | null): void {
    currentUser = user;
    if (user) {
      if (btnLogin) btnLogin.classList.add("hidden");
      if (userCard) userCard.classList.remove("hidden");
      if (userName) userName.innerText = user.minecraftUsername || user.name || "Lampas Player";
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
        const uuid = user.minecraftUuid?.replace(/-/g, "");
        if (uuid) {
          userAvatar.src = `https://crafatar.com/avatars/${uuid}?size=40&overlay`;
        }
      }
    } else {
      if (btnLogin) btnLogin.classList.remove("hidden");
      if (userCard) userCard.classList.add("hidden");
    }
    onUserChanged(currentUser);
  }

  if (btnLogin) {
    btnLogin.onclick = async () => {
      try {
        btnLogin.disabled = true;
        btnLogin.innerText = "LOGGING IN...";
        const res = await window.lampas.auth.login(getPortalUrl());
        updateUserUI(res.user);
        showToast(`Welcome, ${res.user.minecraftUsername || res.user.name}!`, "success");
      } catch (err: any) {
        showToast(`Login failed: ${err.message}`, "error");
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
        await window.lampas.auth.logout();
        updateUserUI(null);
        showToast("Logged out successfully.", "info");
      } catch (err: any) {
        showToast(`Logout error: ${err.message}`, "error");
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
