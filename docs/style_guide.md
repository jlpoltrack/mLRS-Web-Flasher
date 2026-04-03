# mLRS Web Flasher — Style Guide

## Console Log Types

All panels share a single `Console` component. Use `LogType` from `src/constants.ts` consistently across all panels (Flasher, Parameter Editors, Tools).

### Rules

| LogType | When to use | Color |
|---------|-------------|-------|
| `Info` | All status and progress messages — connecting, loading, reading, intermediate steps | White `#e2e8f0` |
| `Success` | **Only** the final completion of a user-initiated operation (flash complete, parameters stored, chip erase complete) | Green `#86efac` |
| `Warning` | Degraded state or user cancellation (metadata unavailable, device rejected a value, operation cancelled) | Yellow `#fde047` |
| `Error` | Failures — connection failed, operation failed, invalid input | Red `#fca5a5` |

### Guidance

- **Most messages should be `Info`.** If in doubt, use `Info`.
- **One `Success` per operation.** A connect-then-load sequence is not a "success" — the store/flash/erase at the end is.
- **Do not use `Success` for intermediate milestones** like "Connected", "Loaded N parameters", or "Options loaded". These are `Info`.
- `Warning` is for situations where something went wrong but the operation can continue.
- `Error` always means the operation failed or cannot proceed.

### Examples

```typescript
// Good — status updates are Info
addLog({ type: LogType.Info, message: 'Connecting to CLI...' });
addLog({ type: LogType.Info, message: 'Connected to CLI' });
addLog({ type: LogType.Info, message: `Loaded ${params.length} parameters` });

// Good — final completion is Success
addLog({ type: LogType.Success, message: 'Parameters stored. Devices are rebooting...' });
addLog({ type: LogType.Success, message: 'Flash completed successfully!' });

// Good — degraded but continuing
addLog({ type: LogType.Warning, message: 'Metadata unavailable. Showing raw values.' });

// Good — operation cannot proceed
addLog({ type: LogType.Error, message: `Connection failed: ${msg}` });
```
