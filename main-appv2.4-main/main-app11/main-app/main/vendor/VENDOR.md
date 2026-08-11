# Vendored binaries

## Nefarius.ViGEm.Client.dll

- Source: NuGet package `Nefarius.ViGEm.Client` version **1.17.183** (`lib/net452` build)
  https://www.nuget.org/packages/Nefarius.ViGEm.Client/1.17.183
- License: BSD-3-Clause (© Nefarius Software Solutions e.U.)
- Purpose: .NET client for the ViGEmBus virtual gamepad driver. Loaded by the
  Controller Macros engine (`main/controllerMacros.js`) inside its PowerShell
  helper process to plug a virtual Xbox 360 / DualShock 4 controller and press
  buttons on it.
- Why this exact version: it is the newest release that still ships a
  self-contained .NET Framework 4.5.2 build with **zero package dependencies**,
  which is what Windows PowerShell 5.1 (.NET Framework 4.8) can load directly
  via `Add-Type`. Newer versions target netstandard2.0 only and pull in extra
  dependency assemblies.
- The DLL is fully managed (no native ViGEmClient.dll needed); it talks to the
  ViGEmBus kernel driver directly. Without the driver installed it throws
  `VigemBusNotFoundException`, which the engine reports cleanly.
