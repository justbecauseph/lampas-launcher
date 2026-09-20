// electron-builder applies these fuses before its signing step.
module.exports = async function beforePack(context) {
  // Electron's embedded ASAR integrity enforcement is supported on Windows/macOS.
  context.packager.config.electronFuses.enableEmbeddedAsarIntegrityValidation =
    context.electronPlatformName !== "linux";
};
