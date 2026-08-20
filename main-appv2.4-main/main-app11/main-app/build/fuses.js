// electron-builder afterPack hook: flip Electron fuses on the packaged binary.
//
// This is the binary-level anti-tamper layer. Electron has no `electronFuses`
// config key, so we call @electron/fuses directly here, after the app is packed
// but before it's code-signed (afterSign) and wrapped into the installer / dmg.
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
// runtime behaviour.
const path = require("path");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

// The fuse settings to flip, per packaged platform. Exposed as a pure function
// so it can be unit-tested on any OS without a real binary. Returns null for
// platforms we don't harden here (only win32 + darwin are shipped).
function fuseOptionsFor(platformName) {
  if (platformName !== "win32" && platformName !== "darwin") return null;

  const opts = {
    version: FuseVersion.V1,
    // On macOS, flipping fuses rewrites the binary and invalidates its (ad-hoc)
    // signature; re-apply an ad-hoc signature so an unsigned/dev build still
    // launches on Apple Silicon. electron-builder's own signing step (when
    // Developer ID creds are present) runs AFTER this and overwrites it with the
    // real signature. On Windows this flag is a no-op.
    resetAdHocDarwinSignature: platformName === "darwin",
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  };

  // asar-integrity validation is wired up and verified on Windows. We leave it
  // OFF on macOS, where the Info.plist integrity handling is more fragile and we
  // can't smoke-test a launch on this (Windows) dev machine — enabling a fuse we
  // can't verify risks bricking the mac launch. Revisit once a Mac is available.
  if (platformName === "win32") {
    opts[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] = true;
  }

  return opts;
}

// Absolute path to the packaged Electron binary for a given afterPack context.
// Windows: <out>/<Product>.exe. macOS: <out>/<Product>.app/Contents/MacOS/<Product>.
function binaryPathFor(context) {
  const platformName = context.electronPlatformName;
  const productFilename = context.packager.appInfo.productFilename;
  if (platformName === "win32") {
    return path.join(context.appOutDir, `${productFilename}.exe`);
  }
  if (platformName === "darwin") {
    return path.join(context.appOutDir, `${productFilename}.app`, "Contents", "MacOS", productFilename);
  }
  return null;
}

exports.default = async function afterPack(context) {
  const opts = fuseOptionsFor(context.electronPlatformName);
  if (!opts) return;

  const electronBinary = binaryPathFor(context);
  if (!electronBinary) return;

  await flipFuses(electronBinary, opts);
  console.log(`[afterPack] Electron fuses flipped for ${context.electronPlatformName}: ${electronBinary}`);
};

// Exposed for unit tests.
exports.fuseOptionsFor = fuseOptionsFor;
exports.binaryPathFor = binaryPathFor;
