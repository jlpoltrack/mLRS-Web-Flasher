// MAVLink parameter editor - MAVLink-based parameter management for mLRS devices

import { useState, useCallback, useRef, useEffect } from 'react';
import { LogType } from '../constants';
import { MavLinkConnection } from '../api/mavlinkConnection';
import * as mavParams from '../api/mavlinkParamService';
import { fetchParameterMetadata } from '../api/setupListParser';
import type { SetupParamMetadata } from '../api/setupListParser';
import type { MavParam } from '../api/mavlinkParamService';
import type { LogEntry } from '../types';
import { useSerialPort } from '../hooks/useSerialPort';
import { groupParameters } from '../utils/parameterGrouping';
import './panel.css';
import './parameterEditor.css';

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400];
const DEFAULT_BAUD = 115200;

interface MavLinkParameterEditorProps {
    addLog: (entry: LogEntry) => void;
}

function MavLinkParameterEditor({ addLog }: MavLinkParameterEditorProps) {
    const { port, portName, selectPort } = useSerialPort(addLog);
    const [baudRate, setBaudRate] = useState(DEFAULT_BAUD);
    const [connected, setConnected] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [parameters, setParameters] = useState<MavParam[]>([]);
    const [metadata, setMetadata] = useState<Map<string, SetupParamMetadata>>(new Map());
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [settingParam, setSettingParam] = useState<string | null>(null);
    const [hasChanges, setHasChanges] = useState(false);
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    const lastSentValue = useRef<{ name: string; value: string } | null>(null);
    const mavRef = useRef<MavLinkConnection | null>(null);

    // cleanup on unmount
    useEffect(() => {
        return () => {
            if (mavRef.current) {
                mavParams.disconnectMlrs(mavRef.current);
                mavRef.current = null;
            }
        };
    }, []);

    const handleConnect = useCallback(async () => {
        if (!port) return;

        if (connected) {
            // disconnect
            if (mavRef.current) {
                await mavParams.disconnectMlrs(mavRef.current);
                mavRef.current = null;
            }
            setConnected(false);
            setParameters([]);
            setHasChanges(false);
            addLog({ type: LogType.Info, message: 'Disconnected from MAVLink' });
            return;
        }

        setConnecting(true);
        try {
            addLog({ type: LogType.Info, message: `Connecting via MAVLink at ${baudRate} baud...` });
            const mav = await mavParams.connectToMlrs(port, baudRate, (msg) => {
                addLog({ type: LogType.Info, message: msg });
            });
            mavRef.current = mav;
            setConnected(true);
            addLog({ type: LogType.Success, message: 'Connected to mLRS via MAVLink' });

            // fetch metadata from GitHub
            try {
                addLog({ type: LogType.Info, message: 'Loading parameter metadata from GitHub...' });
                const meta = await fetchParameterMetadata();
                setMetadata(meta);
                addLog({ type: LogType.Info, message: `Loaded metadata for ${meta.size} parameters` });
            } catch (err) {
                addLog({ type: LogType.Warning, message: `Metadata unavailable: ${err instanceof Error ? err.message : String(err)}. Showing raw values.` });
            }

            // request all parameters
            setLoading(true);
            const params = await mavParams.requestAllParams(mav, undefined, (msg) => {
                addLog({ type: LogType.Info, message: msg });
            });
            setParameters(params);
            setLoading(false);
            addLog({ type: LogType.Success, message: `Loaded ${params.length} parameters` });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            addLog({ type: LogType.Error, message: `Connection failed: ${msg}` });
            if (mavRef.current) {
                await mavParams.disconnectMlrs(mavRef.current);
                mavRef.current = null;
            }
            setConnected(false);
        } finally {
            setConnecting(false);
            setLoading(false);
        }
    }, [port, connected, baudRate, addLog]);

    const handleParamChange = useCallback(async (param: MavParam, newValue: string, meta?: SetupParamMetadata) => {
        if (!mavRef.current) return;

        // prevent double-send
        if (lastSentValue.current?.name === param.paramId && lastSentValue.current?.value === newValue) {
            return;
        }
        lastSentValue.current = { name: param.paramId, value: newValue };
        setSettingParam(param.paramId);

        try {
            let numericValue: number;

            // handle bind phrase text -> uint32 conversion
            if (param.paramId === 'BIND_PHRASE_U32') {
                numericValue = mavParams.u32FromBindphrase(newValue);
            } else {
                numericValue = parseFloat(newValue);
                if (isNaN(numericValue)) return;
            }

            const result = await mavParams.setParam(
                mavRef.current,
                param.paramId,
                numericValue,
                param.paramType,
                (msg) => addLog({ type: LogType.Info, message: msg })
            );

            if (result) {
                setParameters(prev => prev.map(p =>
                    p.paramId === param.paramId ? { ...p, value: result.value } : p
                ));

                // check if the device accepted or rejected/sanitized the value
                const actualValue = mavParams.paramValueFromFloat(result.value, result.paramType);
                const requestedValue = numericValue;

                // format display values for log
                const formatVal = (val: number) => {
                    if (meta?.type === 'LIST' && meta.options.length > 0 && val >= 0 && val < meta.options.length) {
                        return meta.options[val];
                    }
                    return String(val);
                };

                if (actualValue !== requestedValue) {
                    addLog({ type: LogType.Warning, message: `${param.paramId}: '${formatVal(requestedValue)}' not supported by device, reverted to '${formatVal(actualValue)}'` });
                } else {
                    setHasChanges(true);
                    addLog({ type: LogType.Info, message: `Set ${param.paramId} = ${formatVal(actualValue)}` });
                }
            } else {
                addLog({ type: LogType.Error, message: `Failed to set ${param.paramId}` });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            addLog({ type: LogType.Error, message: `Error setting ${param.paramId}: ${msg}` });
        } finally {
            setSettingParam(null);
            setTimeout(() => { lastSentValue.current = null; }, 100);
        }
    }, [addLog]);

    const handleStore = useCallback(async () => {
        if (!mavRef.current) return;
        setSaving(true);
        try {
            const ok = await mavParams.storeParams(mavRef.current, (msg) => {
                addLog({ type: LogType.Info, message: msg });
            });
            if (ok) {
                addLog({ type: LogType.Success, message: 'Parameters stored. Devices are rebooting...' });
                setHasChanges(false);
                // PSTORE triggers a reboot on both Tx and Rx
                // clean up the connection since the device will disconnect
                if (mavRef.current) {
                    await mavParams.disconnectMlrs(mavRef.current);
                    mavRef.current = null;
                }
                setConnected(false);
                setParameters([]);
                addLog({ type: LogType.Info, message: 'Disconnected. Reconnect after devices have rebooted.' });
            } else {
                addLog({ type: LogType.Error, message: 'Store failed' });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            addLog({ type: LogType.Error, message: `Store failed: ${msg}` });
        } finally {
            setSaving(false);
        }
    }, [addLog]);

    const handleReload = useCallback(async () => {
        if (!mavRef.current || !connected) return;
        setLoading(true);
        try {
            addLog({ type: LogType.Info, message: 'Reloading parameters...' });
            const params = await mavParams.requestAllParams(mavRef.current, undefined, (msg) => {
                addLog({ type: LogType.Info, message: msg });
            });
            setParameters(params);
            setHasChanges(false);
            addLog({ type: LogType.Success, message: `Reloaded ${params.length} parameters` });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            addLog({ type: LogType.Error, message: `Reload failed: ${msg}` });
        } finally {
            setLoading(false);
        }
    }, [connected, addLog]);

    // get display value for a parameter
    const getDisplayValue = (param: MavParam): number | string => {
        if (param.paramId === 'BIND_PHRASE_U32') {
            const u32 = mavParams.floatBitsToUint32(param.value);
            return mavParams.bindphraseFromU32(u32);
        }
        return mavParams.paramValueFromFloat(param.value, param.paramType);
    };

    const renderParameter = (param: MavParam) => {
        const meta = metadata.get(param.paramId);
        const isDisabled = !connected || !!settingParam || loading || saving;
        const isBeingSet = settingParam === param.paramId;
        // fallback: convert "TX_SER_BAUD" -> "Tx Ser Baud" to match CLI style
        const displayName = meta?.displayName || param.paramId
            .split('_')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');

        // hide PSTORE -- it's the store trigger, not a user param
        if (param.paramId === 'PSTORE') return null;

        // CONFIG ID -- read-only
        if (param.paramId === 'CONFIG ID') {
            const val = mavParams.paramValueFromFloat(param.value, param.paramType);
            return (
                <div key={param.paramId} className="param-row">
                    <label className="param-label">{displayName}</label>
                    <span className="param-value-readonly">{val}</span>
                </div>
            );
        }

        // BIND_PHRASE_U32 -- editable text input with base-40 conversion
        if (param.paramId === 'BIND_PHRASE_U32') {
            const phrase = getDisplayValue(param) as string;
            return (
                <div key={param.paramId} className={`param-row ${isBeingSet ? 'param-updating' : ''}`}>
                    <label className="param-label">{displayName}</label>
                    <div className="param-str6-input">
                        <input
                            type="text"
                            value={phrase}
                            maxLength={6}
                            pattern="[a-z0-9_#\-.]*"
                            onChange={(e) => {
                                // update local state for responsive UI
                                const newPhrase = e.target.value;
                                const newU32 = mavParams.u32FromBindphrase(newPhrase);
                                const newFloat = mavParams.uint32ToFloatBits(newU32);
                                setParameters(prev => prev.map(p =>
                                    p.paramId === 'BIND_PHRASE_U32' ? { ...p, value: newFloat } : p
                                ));
                            }}
                            onBlur={(e) => {
                                if (e.target.value.length > 0) {
                                    handleParamChange(param, e.target.value, meta);
                                }
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    const val = (e.target as HTMLInputElement).value;
                                    if (val.length > 0) {
                                        handleParamChange(param, val, meta);
                                    }
                                }
                            }}
                            disabled={isDisabled}
                        />
                        <span className="param-charset">[a-z0-9_#-.]</span>
                    </div>
                </div>
            );
        }

        // LIST type with options from metadata
        if (meta?.type === 'LIST' && meta.options.length > 0 && !meta.isDynamicOptions) {
            const currentIdx = mavParams.paramValueFromFloat(param.value, param.paramType);
            return (
                <div key={param.paramId} className={`param-row ${isBeingSet ? 'param-updating' : ''}`}>
                    <label className="param-label">{displayName}</label>
                    <div className="select-wrapper">
                        <select
                            value={currentIdx}
                            onChange={(e) => handleParamChange(param, e.target.value, meta)}
                            disabled={isDisabled}
                        >
                            {meta.options.map((opt, idx) => (
                                <option key={idx} value={idx}>{opt}</option>
                            ))}
                        </select>
                    </div>
                </div>
            );
        }

        // INT8 type with min/max from metadata
        if (meta?.type === 'INT8') {
            const currentVal = mavParams.paramValueFromFloat(param.value, param.paramType);
            return (
                <div key={param.paramId} className={`param-row ${isBeingSet ? 'param-updating' : ''}`}>
                    <label className="param-label">{displayName}</label>
                    <div className="param-int8-input">
                        <input
                            type="number"
                            value={currentVal}
                            min={meta.min}
                            max={meta.max}
                            onChange={(e) => {
                                const val = parseInt(e.target.value, 10);
                                if (!isNaN(val)) {
                                    const encoded = mavParams.valueToFloatBytewise(val, param.paramType);
                                    setParameters(prev => prev.map(p =>
                                        p.paramId === param.paramId ? { ...p, value: encoded } : p
                                    ));
                                }
                            }}
                            onBlur={(e) => {
                                const val = parseInt(e.target.value, 10);
                                if (!isNaN(val)) {
                                    handleParamChange(param, String(val), meta);
                                }
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    const val = parseInt((e.target as HTMLInputElement).value, 10);
                                    if (!isNaN(val)) {
                                        handleParamChange(param, String(val), meta);
                                    }
                                }
                            }}
                            disabled={isDisabled}
                        />
                        {meta.unit && <span className="param-unit">{meta.unit}</span>}
                        {meta.min !== undefined && (
                            <span className="param-range">{meta.min} to {meta.max}</span>
                        )}
                    </div>
                </div>
            );
        }

        // fallback: raw numeric input (dynamic options, unknown params, etc.)
        const currentVal = mavParams.paramValueFromFloat(param.value, param.paramType);
        return (
            <div key={param.paramId} className={`param-row ${isBeingSet ? 'param-updating' : ''}`}>
                <label className="param-label">{displayName}</label>
                <div className="param-int8-input">
                    <input
                        type="number"
                        value={currentVal}
                        onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (!isNaN(val)) {
                                const encoded = mavParams.valueToFloatBytewise(Math.round(val), param.paramType);
                                setParameters(prev => prev.map(p =>
                                    p.paramId === param.paramId ? { ...p, value: encoded } : p
                                ));
                            }
                        }}
                        onBlur={(e) => {
                            const val = parseFloat(e.target.value);
                            if (!isNaN(val)) {
                                handleParamChange(param, String(val), meta);
                            }
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                const val = parseFloat((e.target as HTMLInputElement).value);
                                if (!isNaN(val)) {
                                    handleParamChange(param, String(val), meta);
                                }
                            }
                        }}
                        disabled={isDisabled}
                    />
                    {meta?.unit && <span className="param-unit">{meta.unit}</span>}
                    {meta?.isDynamicOptions && (
                        <span className="param-range">hardware-specific</span>
                    )}
                </div>
            </div>
        );
    };

    const groups = groupParameters(parameters, p => {
        const meta = metadata.get(p.paramId);
        const name = meta?.displayName || p.paramId;
        if (name.startsWith('Tx ') || p.paramId.startsWith('TX_')) return 'tx';
        if (name.startsWith('Rx ') || p.paramId.startsWith('RX_')) return 'rx';
        return 'common';
    });

    return (
        <div className="panel">
            <h2 className="panel-title">MAVLink Parameter Editor</h2>

            <div className="info-box">
                Connect to a Tx module via MAVLink to read and edit device parameters.
                The Tx module must have MAVLink Component enabled and a receiver must be connected.
            </div>

            {/* connection section */}
            <div className="form-grid">
                <div className="form-group port-group span-2">
                    <label>COM Port</label>
                    <div className="port-row">
                        {port ? (
                            <>
                                <div className="static-display">{portName}</div>
                                <button
                                    className="btn-secondary"
                                    onClick={selectPort}
                                    disabled={connected || connecting}
                                >
                                    Change Port
                                </button>
                            </>
                        ) : (
                            <>
                                <div className="static-display">No device selected</div>
                                <button
                                    className="btn-secondary"
                                    onClick={selectPort}
                                    disabled={connecting}
                                >
                                    Add Device
                                </button>
                            </>
                        )}
                    </div>
                </div>
                <div className="form-group port-group span-2">
                    <label>Baud Rate</label>
                    <div className="port-row">
                        <div className="select-wrapper">
                            <select
                                value={baudRate}
                                onChange={(e) => setBaudRate(parseInt(e.target.value, 10))}
                                disabled={connected || connecting}
                            >
                                {BAUD_RATES.map(rate => (
                                    <option key={rate} value={rate}>{rate}</option>
                                ))}
                            </select>
                        </div>
                        <button
                            className={connected ? 'btn-disconnect' : 'btn-connect'}
                            onClick={handleConnect}
                            disabled={!port || connecting}
                        >
                            {connecting ? 'Connecting...' : connected ? 'Disconnect' : 'Connect'}
                        </button>
                    </div>
                </div>
                {connected && (
                    <div className="form-group port-group full-width">
                        <div className="port-row">
                            <button
                                className="btn-secondary"
                                onClick={handleReload}
                                disabled={!connected || loading || saving}
                            >
                                Reload
                            </button>
                            <button
                                className="btn-store"
                                onClick={handleStore}
                                disabled={!connected || saving || loading}
                            >
                                {saving ? 'Storing...' : 'Store'}
                            </button>
                            {hasChanges && <span className="unsaved-indicator">Unsaved</span>}
                        </div>
                    </div>
                )}
            </div>

            {/* loading state */}
            {loading && (
                <div className="param-loading">
                    <div className="spinner"></div>
                    <span>Reading parameters...</span>
                </div>
            )}

            {/* parameter list */}
            {!loading && parameters.length > 0 && (
                <div className="param-list">
                    {groups.map(group => {
                        const isCollapsed = collapsedGroups.has(group.title);
                        return (
                            <div key={group.title} className="param-group">
                                <h3
                                    className={`param-group-title ${isCollapsed ? 'collapsed' : ''}`}
                                    onClick={() => setCollapsedGroups(prev => {
                                        const next = new Set(prev);
                                        if (next.has(group.title)) next.delete(group.title);
                                        else next.add(group.title);
                                        return next;
                                    })}
                                >
                                    <span className="param-group-chevron">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
                                    {group.title}
                                    <span className="param-group-count">{group.params.length}</span>
                                </h3>
                                {!isCollapsed && (
                                    <div className="param-group-params">
                                        {group.params.map(p => renderParameter(p))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export default MavLinkParameterEditor;
