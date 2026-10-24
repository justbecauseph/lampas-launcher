import type { RendererUserProfile } from "../types";
import { formatFriendlyError } from "../utils";

export interface AuthViewOptions {
  showToast: (
    message: string,
    type: "info" | "success" | "error",
    duration?: number,
  ) => void;
  getPortalUrl: () => string;
  externalImages?: () => boolean;
  onUserChanged: (user: RendererUserProfile | null) => void;
}

export function initAuthView(options: AuthViewOptions): {
  updateUserUI: (user: RendererUserProfile | null) => void;
  login: () => Promise<void>;
  getCurrentUser: () => RendererUserProfile | null;
  dispose: () => void;
} {
  const { showToast, getPortalUrl, externalImages, onUserChanged } = options;

  const btnLogin = document.getElementById(
    "btn-login",
  ) as HTMLButtonElement | null;
  const btnLoginText = document.getElementById(
    "btn-login-text",
  ) as HTMLElement | null;
  const btnLogout = document.getElementById(
    "btn-logout",
  ) as HTMLButtonElement | null;
  const userCard = document.getElementById("user-card") as HTMLElement | null;
  const userName = document.getElementById("user-name") as HTMLElement | null;
  const userRole = document.getElementById("user-role") as HTMLElement | null;
  const userAvatar = document.getElementById(
    "user-avatar",
  ) as HTMLElement | null;

  let currentUser: RendererUserProfile | null = null;
  let avatarRequest = 0;
  let loginInFlight: Promise<void> | null = null;

  function setLoginLabel(text: string): void {
    if (btnLoginText) btnLoginText.innerText = text;
    else if (btnLogin) btnLogin.innerText = text;
  }

  function updateUserUI(user: RendererUserProfile | null): void {
    const requestId = ++avatarRequest;
    currentUser = user;
    if (user) {
      if (btnLogin) btnLogin.classList.add("hidden");
      if (userCard) userCard.classList.remove("hidden");
      const displayName =
        user.minecraftUsername ||
        user.name ||
        (user as any).discordTag ||
        "Lampas Player";
      if (userName) userName.innerText = displayName;
      if (userRole) {
        if (user.isAdmin) {
          userRole.innerText = "Administrator";
          userRole.className = "tag tag-accent";
        } else if (user.isTech) {
          userRole.innerText = "Tech team";
          userRole.className = "tag tag-accent";
        } else {
          userRole.innerText = "Member";
          userRole.className = "tag";
        }
      }
      if (userAvatar) {
        const fallbackInitial = displayName[0]?.toUpperCase() || "P";
        const identifier =
          user.minecraftUuid &&
          user.minecraftUuid !== "00000000-0000-0000-0000-000000000000"
            ? user.minecraftUuid.replace(/-/g, "")
            : user.minecraftUsername || displayName;

        userAvatar.replaceChildren();
        userAvatar.innerText = fallbackInitial;
        if (
          identifier &&
          externalImages?.() &&
          window.lampas.cosmetics?.getAvatar
        ) {
          void window.lampas.cosmetics
            .getAvatar()
            .then((image) => {
              if (
                !image ||
                requestId !== avatarRequest ||
                currentUser !== user ||
                !userAvatar
              )
                return;
              const img = document.createElement("img");
              img.src = image.dataUrl;
              img.alt = `${displayName}'s avatar`;
              img.onerror = () => {
                userAvatar.replaceChildren();
                userAvatar.innerText = fallbackInitial;
              };
              userAvatar.replaceChildren(img);
            })
            .catch(() => undefined);
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

  async function runLogin(): Promise<void> {
    try {
      if (btnLogin) btnLogin.disabled = true;
      setLoginLabel("Signing in…");
      const res = await window.lampas.auth.login();
      updateUserUI(res.user);
      showToast(
        `Signed in as ${res.user.minecraftUsername || res.user.name}.`,
        "success",
      );
      try {
        const storageStatus = await window.lampas.auth.getStorageStatus();
        if (storageStatus.sessionOnly) {
          showToast(
            "You'll need to sign in again next time you open the launcher.",
            "info",
          );
        } else if (storageStatus.lastPersistenceError) {
          console.warn(
            "Sign-in storage warning:",
            storageStatus.lastPersistenceError,
          );
          showToast(
            "Couldn't save your sign-in on this computer. You'll need to sign in again next time.",
            "error",
          );
        }
      } catch {}
    } catch (err: any) {
      showToast(
        formatFriendlyError(err, "Couldn't sign in. Open Logs for details."),
        "error",
      );
    } finally {
      if (btnLogin) btnLogin.disabled = false;
      setLoginLabel("Sign in");
    }
  }

  function login(): Promise<void> {
    if (!loginInFlight) {
      loginInFlight = runLogin().finally(() => {
        loginInFlight = null;
      });
    }
    return loginInFlight;
  }

  if (btnLogin) {
    btnLogin.onclick = () => void login();
  }

  if (btnLogout) {
    btnLogout.onclick = async () => {
      try {
        const logoutResult = await window.lampas.auth.logout();
        updateUserUI(null);
        if (logoutResult && !logoutResult.success) {
          console.warn(
            "Sign-out cleanup incomplete:",
            logoutResult.error || "cleanup error",
          );
          showToast(
            "Signed out, but the saved sign-in couldn't be deleted from this computer.",
            "error",
          );
        } else if (logoutResult && logoutResult.success) {
          showToast("Signed out.", "info");
        } else {
          showToast(
            "Signed out. Couldn't confirm the saved sign-in was deleted from this computer.",
            "error",
          );
        }
      } catch (err: any) {
        showToast(`Couldn't sign out: ${formatFriendlyError(err)}`, "error");
      }
    };
  }

  return {
    updateUserUI,
    login,
    getCurrentUser: () => currentUser,
    dispose: () => {
      // Nothing to unbind on window
    },
  };
}
