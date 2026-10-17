# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, Cursor, etc.) when working with code in this repository.

## Project

A browser-only app (React 19 + TypeScript + Vite) that flashes mLRS firmware to Tx modules and receivers over **Web Serial** and **WebUSB**, with no backend. Everything lives in `web/`. It works only in Chromium browsers. The code came from an Electron/Python desktop flasher, so some names are left over from it (e.g. `BackendTarget` is described as "expected by the python script", and `programmer` in `FlashOptions` is unused).

## Commands

Run all commands from `web/`:

```bash
npm install
npm run dev       # Vite dev server
npm run lint      # eslint .
npm run build     # tsc -b && vite build (this is also the type check)
```

There is no test suite. Check changes with `npm run lint` and `npm run build`, then test on real hardware.

The build base path comes from `VITE_BASE_PATH` (default `/mLRS-Web-Flasher/`). CI deploys **every branch** to GitHub Pages under `/mLRS-Web-Flasher/<branch>/` (`.github/workflows/gh-pages-deploy.yml`). Pushes to `main` also deploy over FTP to `/mlrs/flash/`.

## Lint / type conventions

- **Every change must lint clean**: `npm run lint` and `npm run build` must both pass with zero errors before committing. Don't add `eslint-disable` without a comment explaining why.
- `tsconfig.app.json` is `strict` with `noUnusedLocals`/`noUnusedParameters`. ESLint `no-unused-vars` is set to match: prefix intentionally unused names with `_`.
- Avoid `any`. Use bare `catch { /* ignore */ }` when the error is unused. Format errors as `e instanceof Error ? e.message : String(e)`.
- Hand-written typings for untyped deps are in `src/types/` (`webdfu.d.ts`, `node-mavlink.d.ts`) and `src/globals.d.ts`. Extend them rather than casting.

## Architecture

### Flash pipeline

UI → `api` facade → protocol-specific flasher:

1. **`components/FirmwareFlasherPanel.tsx`** holds all the flashing UI state: device, version, file, flash method, port, local file mode and wireless bridge. It builds a `FlashOptions` (`src/types.ts`) and passes it up through `DeviceView` → `App.onFlash`.
2. **`api/webSerialApi.ts`** (`api` object) is the facade the UI calls. `api.flash()` resolves the chipset and metadata, downloads the firmware if it wasn't supplied, picks the `SerialPort` or `USBDevice`, and calls `flash()`. Logs and progress go to the UI through a single `onOutput` callback, which `App.tsx` turns into console entries and the progress bar.
3. **`api/flasher.ts` `flash()`** dispatches on chipset and method:
   - `stm32` + USB device → `flashSTM32SWD` (ST-Link, `api/stlink/`) or `flashSTM32DFU` (`webdfu`).
   - `stm32` + serial → optional ArduPilot or INAV passthrough setup, then `flashSTM32UART` (`stm32UartProtocol.ts`, `hexParser.ts`).
   - `esp*` → optional EdgeTX CLI passthrough (internal `txint` modules, `initEdgeTXPassthrough`) or ArduPilot/INAV passthrough, then `flashESP` (`esptool-js`).
4. Each flasher reports through **`FlasherStateMachine`** (`IDLE → CONNECTING → SYNCING → ERASING → WRITING → … → DONE/ERROR`). Use `sm.transition()`/`sm.log()` instead of calling callbacks directly.

`api/eraseService.ts` follows the same per-protocol layout for chip erase (Tools tab).

### Device metadata

**`api/metadata.ts`** is the device database. `g_*DeviceTypeDict` maps a UI device name to a filename prefix (`fname`) and chipset. `g_targetDict` maps `fname` to its flash methods (comma-separated, first one is the default), description text, `reset`/`erase` options and `wireless` bridge config. Sub-model overrides are nested under keys matched as **substrings of the firmware filename**. `getDeviceInfo`/`resolveChipset` resolve these. See `docs/adding_devices.md` for how to add hardware.

Firmware versions and files come at runtime from the upstream `olliw42/mLRS` GitHub repo (`api/githubApi.ts`, cached). Lua scripts load from jsDelivr.

### Hardware selection

`api/hardwareService.ts` keeps the currently selected `SerialPort`/`USBDevice` in **module-level variables**. React state only holds display names (`formatPortName`/`formatUSBName`), which are mapped back to objects with `findPortByName`/`findUSBDeviceByName`. `filterPortsByMethod` and `SERIAL_FILTERS`/`DFU_USB_FILTERS` in `constants.ts` control which ports are shown.

### Other tabs (`App.tsx`, lazy-loaded)

- **Parameters** (`ParameterEditor`): mLRS text CLI over serial (`cliService.ts` `CliSession` with a serialized command queue, `cliParser.ts`).
- **MAVLink Parameters**: `mavlinkConnection.ts` (node-mavlink, read loop + packet queue, `waitForPacket(msgid, timeout, predicate)`) + `mavlinkParamService.ts`. Display metadata is parsed from upstream `setup_list.h` (`setupListParser.ts`).
- **CLI Commands**, **Lua** (download/install radio scripts), **Tools** (erase etc.). `SwdTest` is hidden from navigation and kept for development.

### Serial plumbing

`bufferedSerial.ts` wraps a `SerialPort` with a background reader and buffered reads. It is used by the CLI and STM32 UART paths. Protocols reopen ports at different baud/parity settings, so close ports and leave settle delays before handing a port to another protocol (esptool, STM32 UART, passthrough).

### State persistence

`hooks/usePersistentState.ts` is a `useState` that is mirrored to localStorage (its setter accepts updater functions). Most UI selections are keyed per target type (e.g. `flasher_${type}_selectedFile`).

## Conventions

- **Console log types** (`docs/style_guide.md`): most messages are `LogType.Info`. Use `Success` **only** for the final completion of a user-started operation (flash/store/erase), never for intermediate steps such as "Connected". `Warning` means degraded but continuing; `Error` means failed.
- Constants such as `TargetType`, `FlashMethod`, `LogType` and `BackendTarget` are `as const` objects plus matching union types in `src/constants.ts`. Use them instead of string literals in new code.
- `api/mockApi.ts` is unused.

## Docs

`docs/` has design notes: `adding_devices.md`, `style_guide.md`, `web_stlink.md` (ST-Link/SWD implementation), `msp_bootloader_guide.md`, `ardupilot_passthrough_review.md`, `flashing_optimizations.md`, `superpowers/specs/` (feature designs). `web_architecture.md` and `ardupilot_passthrough_review.md` are historical: prefer the code and this file where they disagree.
