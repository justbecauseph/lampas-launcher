import { describe, it, expect } from "bun:test";
import {
  formatFriendlyError,
  cleanModDisplayName,
  isUserCancelled,
} from "../ui/src/utils";

describe("UI Utils - formatFriendlyError & cleanModDisplayName", () => {
  describe("formatFriendlyError", () => {
    it("returns default fallback when error is empty or undefined", () => {
      expect(formatFriendlyError(null)).toBe(
        "Something went wrong. Open Logs for details.",
      );
      expect(formatFriendlyError(undefined)).toBe(
        "Something went wrong. Open Logs for details.",
      );
      expect(formatFriendlyError("")).toBe(
        "Something went wrong. Open Logs for details.",
      );
    });

    it("translates Minecraft running conflicts into friendly instructions", () => {
      const err1 = new Error(
        "Cannot perform 'toggle official mod' while Minecraft is running.",
      );
      expect(formatFriendlyError(err1)).toBe(
        "Close Minecraft first, then try again.",
      );

      const err2 = new Error(
        "Cannot modify client mods while an operation or Minecraft is running.",
      );
      expect(formatFriendlyError(err2)).toBe(
        "Close Minecraft first, then try again.",
      );
    });

    it("translates operation busy conflicts into friendly guidance", () => {
      const err = new Error(
        "Cannot start 'sync': operation 'repair' is currently in progress.",
      );
      expect(formatFriendlyError(err)).toBe(
        "The launcher is busy with something else. Try again when it's done.",
      );
    });

    it("translates filesystem locks (EBUSY) into friendly messages", () => {
      const err = new Error(
        "EBUSY: resource locked or busy, unlink 'C:\\games\\mods\\foo.jar'",
      );
      expect(formatFriendlyError(err)).toBe(
        "A file is in use by another program. Close Minecraft and anything else using it, then try again.",
      );
    });

    it("translates permission denied (EPERM / EACCES) into friendly messages", () => {
      const err = new Error(
        "EPERM: operation not permitted, rename 'old' -> 'new'",
      );
      expect(formatFriendlyError(err)).toBe(
        "The launcher isn't allowed to change these files. Check that the folder isn't read-only.",
      );
    });

    it("translates file not found (ENOENT) into friendly messages", () => {
      const err = new Error(
        "ENOENT: no such file or directory, stat 'missing.jar'",
      );
      expect(formatFriendlyError(err)).toBe("A file or folder is missing.");
    });

    it("translates disk space (ENOSPC) into friendly messages", () => {
      const err = new Error("ENOSPC: no space left on device, write");
      expect(formatFriendlyError(err)).toBe(
        "Your disk is full. Free up some space and try again.",
      );
    });

    it("translates network errors into friendly messages", () => {
      expect(formatFriendlyError(new Error("Failed to fetch"))).toBe(
        "Can't connect. Check your internet connection and try again.",
      );
      expect(
        formatFriendlyError(new Error("connect ECONNREFUSED 127.0.0.1:443")),
      ).toBe("Can't connect. Check your internet connection and try again.");
    });

    it("translates mod destination conflicts", () => {
      const err = new Error(
        "Cannot toggle BSL.zip: destination already exists.",
      );
      expect(formatFriendlyError(err)).toBe(
        "You already have a mod file with this name.",
      );
    });

    it("formats generic messages cleanly with capitalization and trailing punctuation", () => {
      const err = new Error("invalid configuration value");
      expect(formatFriendlyError(err)).toBe("Invalid configuration value.");

      const errWithPeriod = new Error("Profile name cannot be blank.");
      expect(formatFriendlyError(errWithPeriod)).toBe(
        "Profile name cannot be blank.",
      );
    });

    it("strips the Electron IPC prefix and the Error: prefix before formatting", () => {
      const err = new Error(
        "Error invoking remote method 'game:launch': Error: invalid configuration value",
      );
      expect(formatFriendlyError(err)).toBe("Invalid configuration value.");
    });

    it("matches friendly mappings after the Electron IPC prefix is stripped", () => {
      const err = new Error(
        "Error invoking remote method 'game:launch': Error: Minecraft is running.",
      );
      expect(formatFriendlyError(err)).toBe(
        "Close Minecraft first, then try again.",
      );
    });

    it("maps unexpected internal errors to the fallback text", () => {
      expect(
        formatFriendlyError(
          new Error("Operation failed: An unexpected internal error occurred."),
        ),
      ).toBe("Something went wrong. Open Logs for details.");
      expect(
        formatFriendlyError(
          new Error(
            "Error invoking remote method 'sync:start': Error: Operation failed: An unexpected internal error occurred.",
          ),
        ),
      ).toBe("Something went wrong. Open Logs for details.");
    });
  });

  describe("cleanModDisplayName", () => {
    it("strips file extensions from mod filenames", () => {
      expect(cleanModDisplayName("BSL_v10.1.5.zip")).toBe("BSL_v10.1.5");
      expect(cleanModDisplayName("fabric-api-0.92.0.jar")).toBe(
        "fabric-api-0.92.0",
      );
      expect(cleanModDisplayName("sodium-0.5.8.jar.disabled")).toBe(
        "sodium-0.5.8",
      );
      expect(cleanModDisplayName("iris.disabled")).toBe("iris");
    });

    it("handles fallback and empty inputs", () => {
      expect(cleanModDisplayName("")).toBe("Mod");
      expect(cleanModDisplayName(undefined, "Custom")).toBe("Custom");
    });
  });

  describe("isUserCancelled", () => {
    it("recognises a cancelled confirmation from the main process", () => {
      expect(
        isUserCancelled(
          new Error(
            "Error invoking remote method 'gameDir:move': Error: You cancelled the folder move.",
          ),
        ),
      ).toBe(true);
      expect(isUserCancelled("You cancelled adding mods.")).toBe(true);
    });

    it("does not treat other failures as cancellations", () => {
      expect(isUserCancelled(new Error("EBUSY: resource locked"))).toBe(false);
      expect(isUserCancelled(new Error("Sign-in was cancelled."))).toBe(false);
      expect(isUserCancelled(null)).toBe(false);
    });
  });
});
