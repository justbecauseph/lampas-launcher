const path = require("node:path");
const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");
const { FuseState } = require("@electron/fuses/dist/constants");

async function main() {
  const binary =
    process.argv[2] ||
    (process.platform === "win32"
      ? "release/win-unpacked/Lampas Launcher.exe"
      : "release/linux-unpacked/lampas-launcher");
  const wire = await getCurrentFuseWire(path.resolve(binary));
  const required = new Map([
    [FuseV1Options.RunAsNode, false],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
    [FuseV1Options.EnableNodeCliInspectArguments, false],
    [FuseV1Options.OnlyLoadAppFromAsar, true],
    [
      FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
      process.platform !== "linux",
    ],
  ]);
  for (const [fuse, enabled] of required) {
    if (wire[fuse] !== (enabled ? FuseState.ENABLE : FuseState.DISABLE)) {
      throw new Error(
        `Packaged fuse ${FuseV1Options[fuse]} has unexpected state ${wire[fuse]}`,
      );
    }
  }
  console.log(
    JSON.stringify(
      {
        binary: path.resolve(binary),
        verified: true,
        embeddedAsarIntegritySupported: process.platform !== "linux",
        fuses: [...required].map(([fuse, enabled]) => ({
          name: FuseV1Options[fuse],
          enabled,
        })),
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
