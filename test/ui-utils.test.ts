import { describe, it, expect } from "bun:test";
import { formatFriendlyError, cleanModDisplayName } from "../ui/src/utils";

describe("UI Utils - formatFriendlyError & cleanModDisplayName", () => {
  describe("formatFriendlyError", () => {
    it("returns default fallback when error is empty or undefined", () => {
      expect(formatFriendlyError(null)).toBe("An unexpected error occurred.");
      expect(formatFriendlyError(undefined)).toBe("An unexpected error occurred.");
      expect(formatFriendlyError("")).toBe("An unexpected error occurred.");
    });

    it("translates Minecraft running conflicts into friendly instructions", () => {
      const err1 = new Error("Cannot perform 'toggle official mod' while Minecraft is running.");
      expect(formatFriendlyError(err1)).toBe("Minecraft is currently running. Please close the game first.");

      const err2 = new Error("Cannot modify client mods while an operation or Minecraft is running.");
      expect(formatFriendlyError(err2)).toBe("Minecraft is currently running. Please close the game first.");
    });

    it("translates operation busy conflicts into friendly guidance", () => {
      const err = new Error("Cannot start 'sync': operation 'repair' is currently in progress.");
      expect(formatFriendlyError(err)).toBe("Another launcher operation is currently in progress. Please wait for it to finish.");
    });

    it("translates filesystem locks (EBUSY) into friendly messages", () => {
      const err = new Error("EBUSY: resource locked or busy, unlink 'C:\\games\\mods\\foo.jar'");
      expect(formatFriendlyError(err)).toBe("The file is currently locked or open in another program. Please close Minecraft or any file editor and try again.");
    });

    it("translates permission denied (EPERM / EACCES) into friendly messages", () => {
      const err = new Error("EPERM: operation not permitted, rename 'old' -> 'new'");
      expect(formatFriendlyError(err)).toBe("Permission denied. The launcher does not have permission to modify these files.");
    });

    it("translates file not found (ENOENT) into friendly messages", () => {
      const err = new Error("ENOENT: no such file or directory, stat 'missing.jar'");
      expect(formatFriendlyError(err)).toBe("The file or directory could not be found.");
    });

    it("translates disk space (ENOSPC) into friendly messages", () => {
      const err = new Error("ENOSPC: no space left on device, write");
      expect(formatFriendlyError(err)).toBe("There is not enough free disk space. Please free up space and try again.");
    });

    it("translates network errors into friendly messages", () => {
      expect(formatFriendlyError(new Error("Failed to fetch"))).toBe("Network connection failed. Please check your internet connection and try again.");
      expect(formatFriendlyError(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe("Network connection failed. Please check your internet connection and try again.");
    });

    it("translates mod destination conflicts", () => {
      const err = new Error("Cannot toggle BSL.zip: destination already exists.");
      expect(formatFriendlyError(err)).toBe("A mod file with this name already exists in your mods folder.");
    });

    it("formats generic messages cleanly with capitalization and trailing punctuation", () => {
      const err = new Error("invalid configuration value");
      expect(formatFriendlyError(err)).toBe("Invalid configuration value.");

      const errWithPeriod = new Error("Profile name cannot be blank.");
      expect(formatFriendlyError(errWithPeriod)).toBe("Profile name cannot be blank.");
    });
  });

  describe("cleanModDisplayName", () => {
    it("strips file extensions from mod filenames", () => {
      expect(cleanModDisplayName("BSL_v10.1.5.zip")).toBe("BSL_v10.1.5");
      expect(cleanModDisplayName("fabric-api-0.92.0.jar")).toBe("fabric-api-0.92.0");
      expect(cleanModDisplayName("sodium-0.5.8.jar.disabled")).toBe("sodium-0.5.8");
      expect(cleanModDisplayName("iris.disabled")).toBe("iris");
    });

    it("handles fallback and empty inputs", () => {
      expect(cleanModDisplayName("")).toBe("Mod");
      expect(cleanModDisplayName(undefined, "Custom")).toBe("Custom");
    });
  });
});
