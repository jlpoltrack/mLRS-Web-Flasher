# Plain no-DTR ESPTool flashing for internal Tx modules

- **Date:** 2026-05-27
- **Status:** Approved (design); ready for implementation plan
- **Scope:** `web/` (mLRS Web Flasher)

## Summary

Add support for a new class of **internal Tx module** target that is flashed with
plain, no-DTR `esptool` directly — bypassing the EdgeTX CLI passthrough sequence
(`initEdgeTXPassthrough`). The new behavior is selected entirely by the target's
metadata (`reset: 'no dtr'`); there is **no UI selector**. It applies to both the
main ESP module and its wireless bridge.

## Background

Today every `txint` target is flashed through `initEdgeTXPassthrough()`
(`web/src/api/flasher.ts:102`). That function uses the radio's EdgeTX CLI to do two
things over the radio's USB VCP:

1. **Bridge** the radio's USB to the internal module's UART (`serialpassthrough rfmod 0 <baud>`).
2. **Enter the bootloader** on the ESP (`set rfmod 0 bootpin` + RF-module power cycle).

The internal module has no USB of its own, so the radio's STM32 must bridge USB↔module
UART for the browser to reach the ESP at all. DTR/RTS over the radio's USB are wired to
the STM32, not the ESP's EN/GPIO0 — which is why the current path always runs in
`no_reset` mode and relies on the CLI `bootpin` dance for bootloader entry.

The no-DTR `esptool` flashing path itself already exists and is exercised by the
wireless-bridge flow: `reset: 'no dtr'` causes `flashESP` to no-op the transport
DTR/RTS methods (`flasher.ts:282`) and pass `no_reset` to `esploader.main()`
(`flasher.ts:315`).

## Requirements

Derived from design discussion:

1. **Scenario:** the radio is *already* bridged and the ESP is *already* in the
   bootloader before flashing — established externally by the user (a radio Lua script
   or a manual button sequence). The flasher does **not** issue any radio CLI commands.
2. **Metadata-driven, no UI selector.** Behavior is keyed off the new target's metadata.
3. **Flash baud is 115200.** (esptool's ROM sync falls back to 115200 regardless; this
   is the main flash baud.)
4. **Both main module and wireless bridge** for this target use the plain no-DTR esptool
   path (neither goes through `initEdgeTXPassthrough`).
5. **No regression.** Existing internal targets (Jumper/RadioMaster/FlySky) keep using
   the full EdgeTX passthrough sequence unchanged.

## Approach

**Discriminator:** the target's metadata `reset` value. When an internal (`txint`)
target's resolved metadata has `reset` containing `'no dtr'`, the flasher skips
`initEdgeTXPassthrough` and flashes directly.

This reuses the existing `reset` plumbing rather than adding a new `FlasherOptions`
field or `FlashMethod` enum value. The one readability risk of an implicit condition is
removed by computing a clearly-named, commented local boolean — `skipEdgetxPassthrough`
— in the flasher.

`flashMethod` was rejected as the discriminator: `handleFlashWirelessBridge` already
passes `flashMethod: 'esptool'` for *every* internal wireless bridge
(`FirmwareFlasherPanel.tsx:468`), yet those still require EdgeTX passthrough — so
`flashMethod` cannot distinguish the two behaviors.

### Data flow

```
g_targetDict entry: reset: 'no dtr'  (+ wireless.reset: 'no dtr')
  -> githubApi.getMetadata() surfaces `reset` on the metadata object
    -> FirmwareFlasherPanel.handleFlash() forwards `reset` in the onFlash payload
       (bridge path: handleFlashWirelessBridge already forwards metadata.wireless.reset)
      -> webSerialApi maps options.reset -> FlasherOptions.reset   (already wired, no change)
        -> flasher.ts computes skipEdgetxPassthrough and branches
```

## Detailed changes

### 1. `web/src/api/metadata.ts` — new target (data)

Add the device to `g_txModuleInternalDeviceTypeDict`:

```ts
'<DISPLAY NAME — maintainer supplies>' : { 'fname' : '<fname-slug>', 'chipset' : 'esp32' },
```

Add the matching `g_targetDict['<fname-slug>']` entry:

```ts
'<fname-slug>' : {
    'reset' : 'no dtr',           // <-- selects plain no-DTR esptool (skip EdgeTX passthrough)
    'description' : "Supported radios: <...>\n" +
        "Flash method: direct esptool (radio already in passthrough)\n" +
        "  - start serial passthrough + bootloader on the radio first " +
        "(<exact Lua/manual instructions — maintainer supplies>)\n" +
        "  - with the radio bridged, connect to USB of your radio\n" +
        "  - select 'USB Serial (VCP)'\n",
    'wireless' : { 'chipset' : '<bridge chipset — maintainer supplies>', 'reset' : 'no dtr', 'baud' : 115200 },
},
```

Maintainer-supplied data (does not affect the mechanism): display name, `fname` slug,
the exact pre-flash passthrough/bootloader instructions, and the wireless bridge
chipset (add `'erase' : 'full_erase'` to the `wireless` object if the bridge chipset
requires it, matching existing c3 bridges).

### 2. `web/src/api/githubApi.ts` — surface `reset` in `getMetadata()`

Mirror the existing `erase` handling exactly (`erase` is read top-level at `:277`,
overridden from `subDict` at `:286`, and returned at `:338`):

- Add `let reset = targetDict.reset;` near `:277`.
- Add `if (subDict.reset) reset = subDict.reset;` in the filename loop near `:286`.
- Include `reset` in the returned metadata object near `:329`.
- Add `reset?: string;` to the `FirmwareMetadata` interface in `web/src/types.ts`.

No change needed to the `mlrs-wireless-bridge-` return branch (`:300`): the bridge flow
reads `metadata.wireless.reset` directly in the panel.

Note: this target sets no `flashmethod`, so `getMetadata` defaults it to `'esptool'`
(`:274`). That is harmless — the `txint` branch ignores `flashMethod` and decides on
`reset`; a single-value `flashmethod` shows no UI selector.

### 3. `web/src/components/FirmwareFlasherPanel.tsx` — forward `reset`

In `handleFlash()` add to the `onFlash({...})` payload (near `:375`):

```ts
reset: metadata?.reset,
```

This is `undefined` for all existing targets (none define a target-level `reset`), so
it is a no-op for them. The bridge path (`handleFlashWirelessBridge`) already forwards
`metadata.wireless.reset` and needs no change.

### 4. `web/src/api/flasher.ts` — the named branch

Replace the unconditional `txint` block (`:102-126`) with a branch on the derived
boolean. The existing EdgeTX passthrough logic is preserved verbatim in the `else`:

```ts
if (options.targetType === 'txint') {
    // 'no dtr' on the target's metadata means the radio is already bridged
    // (via a Lua script or manual button) and the ESP is already in the
    // bootloader. Flash directly with no-DTR esptool, skipping the EdgeTX CLI
    // passthrough sequence entirely. Applies to main module and wireless bridge.
    const skipEdgetxPassthrough = !!(options.reset && options.reset.includes('no dtr'));

    if (skipEdgetxPassthrough) {
        onLog?.("Internal module: external passthrough active — flashing directly with no-DTR esptool.");
        options.baud = options.baud || 115200;
        // leave options.reset as 'no dtr': flashESP no-ops DTR/RTS (:282) and uses no_reset (:315)
    } else {
        onLog?.("Initializing EdgeTX Passthrough for internal module...");
        options.reset = 'no_reset';

        const isBridge = !!((options.device && options.device.toLowerCase().includes('bridge')) ||
                         (options.filename && options.filename.toLowerCase().includes('bridge')));

        onLog?.("Internal Module: Checking baud rate settings...");
        if (isBridge) {
            onLog?.("Wireless Bridge detected: Forcing 115200 baud.");
            options.baud = 115200;
        } else {
            if (!options.baud) {
                onLog?.("Standard Internal Module: Defaulting to 921600 baud.");
                options.baud = 921600;
            }
        }

        await initEdgeTXPassthrough(port as SerialPort, options.baud, isBridge, onLog);
        await new Promise(r => setTimeout(r, 500));
    }
}
```

`flashESP` is unchanged.

## Non-goals

- No new UI controls, flash-method selector, or `FlashMethod` enum value.
- The flasher does **not** establish passthrough or bootloader entry for this target —
  that is the user's responsibility (external Lua/manual). The flasher only opens the
  port and runs esptool.
- No change to how existing internal targets flash.
- Local-file flashing of the new target is out of scope for guaranteed support: in
  local-file mode the panel still resolves `metadata` for the selected device, so
  forwarding `metadata?.reset` (change #3) carries the signal through there too — but
  this path is not a primary verification target.

## Testing / verification

This project flashes real hardware over Web Serial; the load-bearing verification is
manual on-device:

1. **New target, external bridge active:** main module and wireless bridge both flash
   with **no** `set pulses` / `set rfmod` / `serialpassthrough` CLI traffic in the
   console — only esptool output. (Confirms the skip path.)
2. **Regression guard:** an existing internal target (e.g. `tx-jumper-internal`) still
   emits the full EdgeTX CLI sequence and flashes as before.

Automated: if `getMetadata()` has unit coverage, extend it to assert the new target's
metadata exposes `reset: 'no dtr'` and that an existing internal target does not.

## File change checklist

- [ ] `web/src/api/metadata.ts` — add device + target entry with `reset: 'no dtr'`.
- [ ] `web/src/api/githubApi.ts` — surface `reset` from target/subDict in `getMetadata()`.
- [ ] `web/src/components/FirmwareFlasherPanel.tsx` — forward `reset: metadata?.reset` in `handleFlash()`.
- [ ] `web/src/api/flasher.ts` — branch `txint` on `skipEdgetxPassthrough`.
