// parameter editor - CLI-based parameter management for mLRS devices

import { useState, useCallback, useRef, useEffect } from 'react';
import { LogType } from '../constants';
import { CliSession } from '../api/cliService';
import type { CliParameter } from '../api/cliParser';
import type { LogEntry } from '../types';
import { useSerialPort } from '../hooks/useSerialPort';
import { groupParameters } from '../utils/parameterGrouping';
import './panel.css';
import './parameterEditor.css';

interface ParameterEditorProps {
  addLog: (entry: LogEntry) => void;
}

function ParameterEditor({ addLog }: ParameterEditorProps) {
  const { port, portName, selectPort } = useSerialPort(addLog);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [parameters, setParameters] = useState<CliParameter[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingParam, setSettingParam] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const lastSentValue = useRef<{ name: string; value: string } | null>(null);
  const [versionInfo, setVersionInfo] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const optionLoadAbort = useRef(false);
  const cliRef = useRef<CliSession | null>(null);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      optionLoadAbort.current = true;
      cliRef.current?.disconnect();
    };
  }, []);

  const handleConnect = useCallback(async () => {
    if (!port) return;

    if (connected) {
      // disconnect
      optionLoadAbort.current = true;
      await cliRef.current?.disconnect();
      cliRef.current = null;
      setConnected(false);
      setParameters([]);
      setVersionInfo('');
      setHasChanges(false);
      addLog({ type: LogType.Info, message: 'Disconnected from CLI' });
      return;
    }

    setConnecting(true);
    optionLoadAbort.current = false;
    try {
      addLog({ type: LogType.Info, message: 'Connecting to CLI...' });
      const session = new CliSession();
      await session.connect(port, (msg) => {
        addLog({ type: LogType.Info, message: msg });
      });
      cliRef.current = session;
      setConnected(true);
      addLog({ type: LogType.Success, message: 'Connected to CLI' });

      // get version info
      try {
        const version = await session.getVersion();
        setVersionInfo(version);
        addLog({ type: LogType.Info, message: version });
      } catch {
        // version query is optional
      }

      // load parameters - show immediately, then fetch options progressively
      setLoading(true);
      addLog({ type: LogType.Info, message: 'Reading parameters...' });
      const params = await session.listParameters();
      setParameters(params);
      setLoading(false);
      addLog({ type: LogType.Success, message: `Loaded ${params.length} parameters` });

      // progressively load options for each editable parameter
      addLog({ type: LogType.Info, message: 'Loading parameter options...' });
      for (const param of params) {
        if (optionLoadAbort.current) break;
        if (param.unchangeable || param.unavailable) continue;

        if (param.type === 'list' || param.type === 'int8') {
          try {
            const detailed = await session.queryParameterOptions(param.name);
            if (detailed) {
              setParameters(prev => prev.map(p =>
                p.name === param.name
                  ? { ...p, type: detailed.type, options: detailed.options, min: detailed.min, max: detailed.max, unit: detailed.unit ?? p.unit }
                  : p
              ));
            }
          } catch { /* skip */ }
        }
      }

      if (!optionLoadAbort.current) {
        addLog({ type: LogType.Success, message: 'All parameter options loaded' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog({ type: LogType.Error, message: `Connection failed: ${msg}` });
      cliRef.current = null;
      setConnected(false);
    } finally {
      setConnecting(false);
      setLoading(false);
    }
  }, [port, connected, addLog]);

  const [loadingOptions, setLoadingOptions] = useState<string | null>(null);

  const handleLoadOptions = useCallback(async (param: CliParameter) => {
    if (param.options || param.type !== 'list' || !connected || !cliRef.current) return;
    setLoadingOptions(param.name);
    try {
      const detailed = await cliRef.current.queryParameterOptions(param.name);
      if (detailed?.options) {
        setParameters(prev => prev.map(p =>
          p.name === param.name ? { ...p, options: detailed.options } : p
        ));
      }
    } catch {
      // leave without options - user can retry
    } finally {
      setLoadingOptions(null);
    }
  }, [connected]);

  const handleLoadInt8Range = useCallback(async (param: CliParameter) => {
    if (param.min !== undefined || param.type !== 'int8' || !connected || !cliRef.current) return;
    try {
      const detailed = await cliRef.current.queryParameterOptions(param.name);
      if (detailed) {
        setParameters(prev => prev.map(p =>
          p.name === param.name ? { ...p, min: detailed.min, max: detailed.max } : p
        ));
      }
    } catch {
      // leave without range
    }
  }, [connected]);

  const handleParamChange = useCallback(async (param: CliParameter, newValue: string) => {
    if (!cliRef.current) return;
    // prevent double-send when Enter triggers both onKeyDown and onBlur
    if (lastSentValue.current?.name === param.name && lastSentValue.current?.value === newValue) {
      return;
    }
    lastSentValue.current = { name: param.name, value: newValue };
    setSettingParam(param.name);
    try {
      const result = await cliRef.current.setParameter(param.name, newValue);
      if (result.success) {
        // update local state
        setParameters(prev => prev.map(p => {
          if (p.name !== param.name) return p;
          if (p.type === 'list') {
            const idx = parseInt(newValue, 10);
            const option = p.options?.find(o => o.index === idx);
            return { ...p, currentValue: option?.label || newValue, currentIndex: idx };
          }
          return { ...p, currentValue: newValue };
        }));
        setHasChanges(true);
        addLog({ type: LogType.Info, message: `Set ${param.name} = ${newValue}` });
      } else {
        addLog({ type: LogType.Error, message: `Failed to set ${param.name}: ${result.response}` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog({ type: LogType.Error, message: `Error setting ${param.name}: ${msg}` });
    } finally {
      setSettingParam(null);
      // clear dedup after a short delay so blur doesn't re-send
      setTimeout(() => { lastSentValue.current = null; }, 100);
    }
  }, [addLog]);

  const handleStore = useCallback(async () => {
    if (!cliRef.current) return;
    setSaving(true);
    try {
      addLog({ type: LogType.Info, message: 'Storing parameters...' });
      await cliRef.current.storeParameters();
      addLog({ type: LogType.Success, message: 'Parameters stored. Devices are rebooting...' });
      setHasChanges(false);
      // pstore triggers a reboot on both Tx and Rx
      // clean up the connection since the device will disconnect
      optionLoadAbort.current = true;
      await cliRef.current.disconnect();
      cliRef.current = null;
      setConnected(false);
      setParameters([]);
      setVersionInfo('');
      addLog({ type: LogType.Info, message: 'Disconnected. Reconnect after devices have rebooted.' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog({ type: LogType.Error, message: `Store failed: ${msg}` });
    } finally {
      setSaving(false);
    }
  }, [addLog]);

  const handleReload = useCallback(async () => {
    if (!connected || !cliRef.current) return;
    setLoading(true);
    try {
      addLog({ type: LogType.Info, message: 'Reloading parameters...' });
      const params = await cliRef.current.listParameters();

      // merge with existing parameters to preserve options/ranges from initial load
      setParameters(prev => {
        const prevByName = new Map(prev.map(p => [p.name, p]));
        return params.map(param => {
          const existing = prevByName.get(param.name);
          if (!existing) return param;
          // keep existing options/ranges, update current value
          return {
            ...existing,
            currentValue: param.currentValue,
            currentIndex: param.currentIndex,
            unchangeable: param.unchangeable,
            unavailable: param.unavailable,
          };
        });
      });
      setHasChanges(false);
      addLog({ type: LogType.Success, message: `Reloaded ${params.length} parameters` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog({ type: LogType.Error, message: `Reload failed: ${msg}` });
    } finally {
      setLoading(false);
    }
  }, [connected, addLog]);

  const renderParameter = (param: CliParameter) => {
    const isDisabled = !connected || !!settingParam || loading || saving;
    const isBeingSet = settingParam === param.name;

    if (param.unavailable) {
      return (
        <div key={param.name} className="param-row param-unavailable">
          <label className="param-label">{param.name}</label>
          <span className="param-value-unavailable">unavailable</span>
        </div>
      );
    }

    if (param.unchangeable) {
      return (
        <div key={param.name} className="param-row">
          <label className="param-label">{param.name}</label>
          <span className="param-value-readonly">{param.currentValue}</span>
        </div>
      );
    }

    if (param.type === 'list') {
      const isLoadingOpts = loadingOptions === param.name;
      if (param.options && param.options.length > 0) {
        return (
          <div key={param.name} className={`param-row ${isBeingSet ? 'param-updating' : ''}`}>
            <label className="param-label">{param.name}</label>
            <div className="select-wrapper">
              <select
                value={param.currentIndex ?? 0}
                onChange={(e) => handleParamChange(param, e.target.value)}
                disabled={isDisabled}
              >
                {param.options.map(opt => (
                  <option key={opt.index} value={opt.index}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        );
      }
      // options not loaded yet - show current value, fetch on click
      return (
        <div key={param.name} className={`param-row ${isLoadingOpts ? 'param-updating' : ''}`}>
          <label className="param-label">{param.name}</label>
          <div className="select-wrapper">
            <select
              value={0}
              onFocus={() => handleLoadOptions(param)}
              disabled={isDisabled || isLoadingOpts}
            >
              <option value={0}>{isLoadingOpts ? 'Loading...' : param.currentValue}</option>
            </select>
          </div>
        </div>
      );
    }

    if (param.type === 'int8') {
      return (
        <div key={param.name} className={`param-row ${isBeingSet ? 'param-updating' : ''}`}>
          <label className="param-label">{param.name}</label>
          <div className="param-int8-input">
            <input
              type="number"
              value={param.currentValue}
              min={param.min}
              max={param.max}
              onFocus={() => handleLoadInt8Range(param)}
              onChange={(e) => {
                // update local state immediately for responsive UI
                setParameters(prev => prev.map(p =>
                  p.name === param.name ? { ...p, currentValue: e.target.value } : p
                ));
              }}
              onBlur={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val)) {
                  handleParamChange(param, String(val));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = parseInt((e.target as HTMLInputElement).value, 10);
                  if (!isNaN(val)) {
                    handleParamChange(param, String(val));
                  }
                }
              }}
              disabled={isDisabled}
            />
            {param.unit && <span className="param-unit">{param.unit}</span>}
            {param.min !== undefined && (
              <span className="param-range">{param.min} to {param.max}</span>
            )}
          </div>
        </div>
      );
    }

    if (param.type === 'str6') {
      return (
        <div key={param.name} className={`param-row ${isBeingSet ? 'param-updating' : ''}`}>
          <label className="param-label">{param.name}</label>
          <div className="param-str6-input">
            <input
              type="text"
              value={param.currentValue}
              maxLength={6}
              pattern="[a-z0-9#\-._]*"
              onChange={(e) => {
                setParameters(prev => prev.map(p =>
                  p.name === param.name ? { ...p, currentValue: e.target.value } : p
                ));
              }}
              onBlur={(e) => {
                if (e.target.value.length > 0) {
                  handleParamChange(param, e.target.value);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value;
                  if (val.length > 0) {
                    handleParamChange(param, val);
                  }
                }
              }}
              disabled={isDisabled}
            />
            <span className="param-charset">[a-z0-9#-._]</span>
          </div>
        </div>
      );
    }

    // fallback: display as read-only text
    return (
      <div key={param.name} className="param-row">
        <label className="param-label">{param.name}</label>
        <span className="param-value-readonly">{param.currentValue}</span>
      </div>
    );
  };

  const groups = groupParameters(parameters, p => {
    if (p.name.startsWith('Tx ')) return 'tx';
    if (p.name.startsWith('Rx ')) return 'rx';
    return 'common';
  });

  return (
    <div className="panel">
      <h2 className="panel-title">CLI Parameter Editor</h2>

      <div className="info-box">
        Connect to a Tx module via serial to read and edit device parameters.
      </div>

      {/* connection section */}
      <div className="form-grid">
        <div className="form-group port-group full-width">
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

      {/* version info */}
      {versionInfo && (
        <div className="version-display">
          {versionInfo.split(/\r?\n/).map((line, i) => (
            <div key={i}>{line.trim()}</div>
          ))}
        </div>
      )}

      {/* loading state */}
      {loading && (
        <div className="param-loading">
          <div className="spinner"></div>
          <span>Reading parameters...</span>
        </div>
      )}

      {/* parameter list */}
      {!loading && parameters.length > 0 && (
        <>
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
                      {group.params.map(renderParameter)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default ParameterEditor;
