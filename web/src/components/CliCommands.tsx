// CLI commands - settings for the ESP-based wireless bridge of a Tx module
// command set documented in mLRS CommonTx/cli.h

import { useState, useCallback, useRef, useEffect } from 'react';
import { LogType } from '../constants';
import { CliSession } from '../api/cliService';
import type { LogEntry } from '../types';
import { useSerialPort } from '../hooks/useSerialPort';
import './panel.css';
import './parameterEditor.css';
import './cliCommands.css';

interface CliCommandsProps {
  addLog: (entry: LogEntry) => void;
}

type BridgeStatus = 'idle' | 'reading' | 'ready' | 'no-cli-support' | 'old-bridge' | 'read-failed';

// a successful get answers e.g. "AT+PSWD=?->OK+PSWD=<value>" ('*' instead of
// '+' when the bridge marks a change); returns null if no value was found
const parseEspValue = (response: string, key: 'PSWD' | 'NETSSID'): string | null => {
  const match = response.match(new RegExp(`OK[+*]${key}=([^\\r\\n]*)`));
  return match ? match[1].trim() : null;
};

// 'esp set' echoes its 24-char 0xFF-padded AT command, which decodes to
// replacement chars - strip them for display
const cleanResponse = (response: string) => response.replace(/�+/g, '');

function CliCommands({ addLog }: CliCommandsProps) {
  const { port, portName, selectPort } = useSerialPort(addLog);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [busyCommand, setBusyCommand] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState('');
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>('idle');
  const [espPswd, setEspPswd] = useState('');
  const [espNetSsid, setEspNetSsid] = useState('');
  const cliRef = useRef<CliSession | null>(null);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      cliRef.current?.disconnect();
    };
  }, []);

  const teardown = useCallback(async () => {
    await cliRef.current?.disconnect();
    cliRef.current = null;
    setConnected(false);
    setVersionInfo('');
    setBridgeStatus('idle');
    setEspPswd('');
    setEspNetSsid('');
  }, []);

  // run an esp command and show its response
  // 'invalid cmd' means the connected firmware was built without the feature
  const runEspCommand = useCallback(async (command: string): Promise<string | null> => {
    if (!cliRef.current) return null;
    setBusyCommand(command);
    try {
      const response = await cliRef.current.sendCommand(command, 8000);
      const display = cleanResponse(response) || '(no response)';
      const isError = /invalid cmd|err:|failed/.test(response);
      addLog({
        type: isError ? LogType.Error : LogType.Info,
        message: `${command}: ${display.replace(/\r?\n/g, ' ')}`,
      });
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog({ type: LogType.Error, message: `${command} failed: ${msg}` });
      return null;
    } finally {
      setBusyCommand(null);
    }
  }, [addLog]);

  // read both bridge settings to populate the input fields
  const refreshSettings = useCallback(async () => {
    setBridgeStatus('reading');

    const pswdResponse = await runEspCommand('esp get pswd');
    if (!cliRef.current) {
      // disconnected while reading
      setBridgeStatus('idle');
      return;
    }
    if (pswdResponse === null) {
      setBridgeStatus('read-failed');
      return;
    }
    if (/invalid cmd/.test(pswdResponse)) {
      setBridgeStatus('no-cli-support');
      return;
    }
    if (/not supported/.test(pswdResponse)) {
      setBridgeStatus('old-bridge');
      return;
    }
    const pswd = parseEspValue(pswdResponse, 'PSWD');
    if (pswd !== null) setEspPswd(pswd);

    const ssidResponse = await runEspCommand('esp get netssid');
    if (!cliRef.current) {
      setBridgeStatus('idle');
      return;
    }
    const ssid = ssidResponse !== null ? parseEspValue(ssidResponse, 'NETSSID') : null;
    if (ssid !== null) setEspNetSsid(ssid);

    setBridgeStatus(pswd !== null || ssid !== null ? 'ready' : 'read-failed');
  }, [runEspCommand]);

  const handleConnect = useCallback(async () => {
    if (!port) return;

    if (connected) {
      await teardown();
      addLog({ type: LogType.Info, message: 'Disconnected from CLI' });
      return;
    }

    setConnecting(true);
    let session: CliSession | null = null;
    try {
      addLog({ type: LogType.Info, message: 'Connecting to CLI...' });
      session = new CliSession();
      await session.connect(port, (msg) => {
        addLog({ type: LogType.Info, message: msg });
      });
      cliRef.current = session;
      setConnected(true);
      addLog({ type: LogType.Info, message: 'Connected to CLI' });

      // get version info
      try {
        const version = await session.getVersion();
        setVersionInfo(version);
        addLog({ type: LogType.Info, message: version });
      } catch {
        // version query is optional
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog({ type: LogType.Error, message: `Connection failed: ${msg}` });
      cliRef.current = null;
      setConnected(false);
      session = null;
    } finally {
      setConnecting(false);
    }

    // populate the settings fields with the current values
    if (session) {
      await refreshSettings();
    }
  }, [port, connected, addLog, teardown, refreshSettings]);

  // firmware accepts empty (clears) or 8-24 chars; blanks are stripped and ',' ';' terminate the command
  const validateEspString = (value: string, what: string): string | null => {
    if (value.length === 0) return null;
    if (value.length < 8 || value.length > 24) {
      return `${what} must be 8-24 characters, or empty to clear`;
    }
    if (/[ ,;]/.test(value)) {
      return `${what} must not contain spaces, ',' or ';'`;
    }
    return null;
  };

  const handleEspSetPswd = useCallback(() => {
    const err = validateEspString(espPswd, 'Password');
    if (err) {
      addLog({ type: LogType.Error, message: err });
      return;
    }
    runEspCommand(`esp set pswd = ${espPswd}`);
  }, [espPswd, addLog, runEspCommand]);

  const handleEspSetNetSsid = useCallback(() => {
    const err = validateEspString(espNetSsid, 'SSID');
    if (err) {
      addLog({ type: LogType.Error, message: err });
      return;
    }
    runEspCommand(`esp set netssid = ${espNetSsid}`);
  }, [espNetSsid, addLog, runEspCommand]);

  const busy = busyCommand !== null || bridgeStatus === 'reading';
  const unsupported = bridgeStatus === 'no-cli-support' || bridgeStatus === 'old-bridge';
  const disabled = !connected || busy || unsupported;

  const statusMessage: { text: string; isError: boolean } | null = (() => {
    switch (bridgeStatus) {
      case 'reading':
        return { text: 'Reading the current settings from the Tx module...', isError: false };
      case 'no-cli-support':
        return { text: 'This Tx firmware was built without wireless bridge configuration support.', isError: true };
      case 'old-bridge':
        return { text: 'Not supported by this wireless bridge version (requires v1.3.09 or later).', isError: true };
      case 'read-failed':
        return { text: 'Could not read the current settings. Check that the Tx module has an ESP-based wireless bridge.', isError: true };
      default:
        return null;
    }
  })();

  return (
    <div className="panel">
      <h2 className="panel-title">CLI Commands</h2>

      <div className="info-box">
        Connect to a Tx module via serial to configure its ESP-based wireless bridge.
        The current settings are read automatically after connecting.
      </div>

      {/* connection section */}
      <div className="form-grid">
        <div className="form-group port-group full-width">
          <label>Serial Port</label>
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
      </div>

      {/* version info */}
      {versionInfo && (
        <div className="version-display">
          {versionInfo.split(/\r?\n/).map((line, i) => (
            <div key={i}>{line.trim()}</div>
          ))}
        </div>
      )}

      {/* ESP wireless bridge settings */}
      <div className="cmd-section">
        <div className="cmd-section-header">
          <h3>Wireless Bridge Settings</h3>
          <button
            className="btn-secondary"
            onClick={refreshSettings}
            disabled={!connected || busy}
          >
            Refresh
          </button>
        </div>

        {statusMessage && (
          <div className={`cmd-status ${statusMessage.isError ? 'cmd-status-error' : ''}`}>
            {statusMessage.text}
          </div>
        )}

        <div className={`cmd-row ${busyCommand?.includes('pswd') ? 'cmd-running' : ''}`}>
          <div className="cmd-label">Password</div>
          <div className="cmd-desc">
            Password used for the TCP, UDP, and UDPSTA protocols (8-24 characters).
            <br />
            Leave the field empty for password-less operation.
          </div>
          <div className="cmd-controls">
            <input
              type="text"
              value={espPswd}
              maxLength={24}
              placeholder="8-24 chars, empty clears"
              onChange={(e) => setEspPswd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !disabled) handleEspSetPswd(); }}
              disabled={disabled}
            />
            <button className="btn-secondary" onClick={handleEspSetPswd} disabled={disabled}>
              Save
            </button>
          </div>
        </div>

        <div className={`cmd-row ${busyCommand?.includes('netssid') ? 'cmd-running' : ''}`}>
          <div className="cmd-label">Network SSID</div>
          <div className="cmd-desc">
            SSID of the network to join when using the UDPSTA protocol (8-24 characters).
            <br />
            Leave the field empty to reset the SSID to its default value.
          </div>
          <div className="cmd-controls">
            <input
              type="text"
              value={espNetSsid}
              maxLength={24}
              placeholder="8-24 chars, empty resets"
              onChange={(e) => setEspNetSsid(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !disabled) handleEspSetNetSsid(); }}
              disabled={disabled}
            />
            <button className="btn-secondary" onClick={handleEspSetNetSsid} disabled={disabled}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CliCommands;
