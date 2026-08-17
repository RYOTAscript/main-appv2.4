// electron-builder afterPack hook: flip Electron fuses on the packaged binary.
//
// This is the binary-level anti-tamper layer. Electron has no `electronFuses`
// config key, so we call @electron/fuses directly here, after the app is packed
// but before it's wrapped into the NSIS installer / portable exe.
//
//   RunAsNode                            false → no ELECTRON_RUN_AS_NODE (can't
//                                                run arbitrary code as the app)
//   EnableNodeCliInspectArguments        false → no --inspect debugger attach
//   EnableNodeOptionsEnvironmentVariable false → no NODE_OPTIONS code injection
//   EnableCookieEncryption               true  → encrypt the cookie store
//   OnlyLoadAppFromAsar                  true  → refuse a swapped-in app/ dir
//   EnableEmbeddedAsarIntegrityValidation true → verify app.asar hash on launch
//                                                (defeats extract→patch→repack)
//
// The app uses none of the disabled Node features, so this doesn't affect
// runtime behaviour. The build is unsigned, so flipping fuses here (which would
// otherwise invalidate a signature) is fine.
const path = require("path");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const electronBinary = path.join(context.appOutDir, exeName);

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  });

  console.log(`[afterPack] Electron fuses flipped on ${exeName}`);
};
