// last updated: 2026-10-09
import { useState } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import type { Version } from '../types';
import './panel.css';

interface LuaScriptProps {
  versions: Version[];
}

interface InstallResult {
  message: string;
  ejectReminder: string;
}

const LUA_BASE_URL = 'https://cdn.jsdelivr.net/gh/olliw42/mLRS@main/lua/';

// mLRS.lua variants, user picks the one matching the radio screen
const EDGETX_TOOL_VARIANTS = [
  { id: 'color', label: 'Color Screen (mLRS.lua)', src: 'mLRS.lua' },
  { id: 'bw', label: 'Black & White Screen (mLRS-bw.lua)', src: 'mLRS-bw.lua' },
  { id: 'bw-luac', label: 'Black & White Screen, Low Memory (mLRS-bw-luac.lua)', src: 'mLRS-bw-luac.lua' },
];

// scripts installed regardless of screen type, dest is relative to the SD card root
const EDGETX_COMMON_SCRIPTS = [
  { src: 'mLRSStatsW/main.lua', dest: 'WIDGETS/mLRSStatsW/main.lua' },
  { src: '32ChannelLuaScripts/EdgeTx/mLRS32ChM/mlrs32.lua', dest: 'SCRIPTS/MIXES/mlrs32.lua' },
  { src: '32ChannelLuaScripts/EdgeTx/mLRS32ChW/main.lua', dest: 'WIDGETS/mLRS32ChW/main.lua' },
];

// scripts installed on Ethos radios, dest is relative to the SD card root
const ETHOS_SCRIPTS = [
  { src: 'Ethos/main.lua', dest: 'scripts/mlrs/main.lua' },
  { src: 'Ethos/mlrs.lua', dest: 'scripts/mlrs/mlrs.lua' },
  { src: 'Ethos/icon.png', dest: 'scripts/mlrs/icon.png' },
  { src: '32ChannelLuaScripts/Ethos/mLRS32Ch/main.lua', dest: 'scripts/mlrs32/main.lua' },
];

// case-insensitive lookup, SD cards are FAT but the picker API is case-sensitive on some hosts
async function findEntryName(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  const lower = name.toLowerCase();
  for await (const entry of dir.keys()) {
    if (entry.toLowerCase() === lower) return entry;
  }
  return null;
}

// removes the mLRS.lua variants other than keep (and their .luac) so only one tool is listed
async function removeOtherToolVariants(root: FileSystemDirectoryHandle, keep: string): Promise<void> {
  const scriptsName = await findEntryName(root, 'SCRIPTS');
  if (!scriptsName) return;
  const scripts = await root.getDirectoryHandle(scriptsName);
  const toolsName = await findEntryName(scripts, 'TOOLS');
  if (!toolsName) return;
  const tools = await scripts.getDirectoryHandle(toolsName);

  const stale = EDGETX_TOOL_VARIANTS
    .filter(v => v.src !== keep)
    .flatMap(v => [v.src, v.src.replace(/\.lua$/i, '.luac')])
    .map(name => name.toLowerCase());
  const names: string[] = [];
  for await (const entry of tools.keys()) {
    if (stale.includes(entry.toLowerCase())) names.push(entry);
  }
  for (const name of names) await tools.removeEntry(name);
}

// removes stale Ethos 32ch script folder if user previously placed it in scripts/mLRS32Ch
async function removeStaleEthosScripts(root: FileSystemDirectoryHandle): Promise<void> {
  const scriptsName = await findEntryName(root, 'scripts');
  if (!scriptsName) return;
  const scripts = await root.getDirectoryHandle(scriptsName);
  const oldDirName = await findEntryName(scripts, 'mLRS32Ch');
  if (!oldDirName) return;
  try {
    await scripts.removeEntry(oldDirName, { recursive: true });
  } catch {
    // ignore if locked or not empty
  }
}

// writes data to dest below root, creating folders and removing a stale compiled .luac
async function writeScript(root: FileSystemDirectoryHandle, dest: string, data: ArrayBuffer): Promise<void> {
  const parts = dest.split('/');
  const filename = parts.pop()!;
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle((await findEntryName(dir, part)) ?? part, { create: true });
  }

  const fileHandle = await dir.getFileHandle((await findEntryName(dir, filename)) ?? filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();

  if (/\.lua$/i.test(filename)) {
    const luac = await findEntryName(dir, filename.replace(/\.lua$/i, '.luac'));
    if (luac) await dir.removeEntry(luac);
  }
}

function LuaScript(props: LuaScriptProps) {
  void props;

  // EdgeTX/OpenTX mLRS.lua variant to install
  const [edgeTxVariant, setEdgeTxVariant] = useState(EDGETX_TOOL_VARIANTS[0].id);
  const [installingTarget, setInstallingTarget] = useState<'edgetx' | 'ethos' | null>(null);
  const [installResult, setInstallResult] = useState<InstallResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleInstallEdgeTx = async () => {
    setError(null);
    setInstallResult(null);

    if (!window.showDirectoryPicker) {
      setError('This browser cannot write to folders. Please use a Chromium-based browser such as Chrome or Edge.');
      return;
    }

    let root: FileSystemDirectoryHandle;
    try {
      root = await window.showDirectoryPicker({ id: 'edgetx-sdcard', mode: 'readwrite' });
    } catch (err: unknown) {
      // user closed the picker
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to open folder: ${message}`);
      return;
    }

    try {
      setInstallingTarget('edgetx');
      const variant = EDGETX_TOOL_VARIANTS.find(v => v.id === edgeTxVariant)!;
      const scripts = [
        { src: variant.src, dest: `SCRIPTS/TOOLS/${variant.src}` },
        ...EDGETX_COMMON_SCRIPTS,
      ];

      // download everything first so a failed fetch leaves the SD card untouched
      const contents = await Promise.all(scripts.map(async (script) => {
        const response = await fetch(LUA_BASE_URL + script.src);
        if (!response.ok) throw new Error(`Failed to download ${script.src} (${response.status})`);
        return response.arrayBuffer();
      }));

      for (let i = 0; i < scripts.length; i++) {
        await writeScript(root, scripts[i].dest, contents[i]);
      }
      await removeOtherToolVariants(root, variant.src);

      setInstallResult({
        message: `Installed ${scripts.length} scripts to "${root.name}": ${scripts.map(s => '/' + s.dest).join(', ')}.`,
        ejectReminder: 'Eject / safely remove the SD card before unplugging.',
      });
    } catch (err: unknown) {
      console.error('Failed to install Lua scripts:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to install Lua scripts: ${message}`);
    } finally {
      setInstallingTarget(null);
    }
  };

  const handleInstallEthos = async () => {
    setError(null);
    setInstallResult(null);

    if (!window.showDirectoryPicker) {
      setError('This browser cannot write to folders. Please use a Chromium-based browser such as Chrome or Edge.');
      return;
    }

    let root: FileSystemDirectoryHandle;
    try {
      root = await window.showDirectoryPicker({ id: 'ethos-sdcard', mode: 'readwrite' });
    } catch (err: unknown) {
      // user closed the picker
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to open folder: ${message}`);
      return;
    }

    try {
      setInstallingTarget('ethos');
      // download everything first so a failed fetch leaves the SD card untouched
      const contents = await Promise.all(ETHOS_SCRIPTS.map(async (script) => {
        const response = await fetch(LUA_BASE_URL + script.src);
        if (!response.ok) throw new Error(`Failed to download ${script.src} (${response.status})`);
        return response.arrayBuffer();
      }));

      for (let i = 0; i < ETHOS_SCRIPTS.length; i++) {
        await writeScript(root, ETHOS_SCRIPTS[i].dest, contents[i]);
      }
      await removeStaleEthosScripts(root);

      setInstallResult({
        message: `Installed ${ETHOS_SCRIPTS.length} files to "${root.name}": ${ETHOS_SCRIPTS.map(s => '/' + s.dest).join(', ')}.`,
        ejectReminder: 'Eject / safely remove the SD card before unplugging.',
      });
    } catch (err: unknown) {
      console.error('Failed to install Ethos Lua scripts:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to install Ethos Lua scripts: ${message}`);
    } finally {
      setInstallingTarget(null);
    }
  };

  return (
    <div className="panel">
      <h2 className="panel-title">Lua Scripts</h2>
      
      {error && (
        <div className="error-box" role="alert">
          <AlertCircle size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>Error:</strong> {error}
          </div>
          <button
            type="button"
            className="box-close-btn"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {installResult && (
        <div className="success-box" role="status" aria-live="polite">
          <CheckCircle2 size={24} style={{ flexShrink: 0, marginTop: '1px', color: '#10b981' }} />
          <div style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>
            <div>{installResult.message}</div>
            <div style={{ marginTop: '2px', opacity: 0.9 }}>{installResult.ejectReminder}</div>
          </div>
          <button 
            type="button"
            className="box-close-btn"
            onClick={() => setInstallResult(null)}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}
      
      <div className="form-grid">
        {/* EdgeTX/OpenTX SD card install */}
        <div className="form-group span-2 port-group">
          <label>EdgeTX / OpenTX</label>
          <div className="port-row">
            <div className="select-wrapper">
              <select 
                value={edgeTxVariant} 
                onChange={(e) => setEdgeTxVariant(e.target.value)}
                disabled={installingTarget !== null}
                aria-label="Radio screen type"
              >
                {EDGETX_TOOL_VARIANTS.map(v => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </div>
            
            <div title={installingTarget ? 'Install in progress' : undefined}>
              <button 
                className="btn-primary"
                onClick={handleInstallEdgeTx}
                disabled={installingTarget !== null}
                aria-label="Select SD card folder and install EdgeTX/OpenTX Lua scripts"
              >
                {installingTarget === 'edgetx' ? 'Installing...' : 'Select SD Card'}
              </button>
            </div>
          </div>
        </div>

        {/* Ethos SD card install */}
        <div className="form-group span-2 port-group">
          <label>Ethos</label>
          <div className="port-row">
            <div className="static-display">
              All Radios (mLRS &amp; 32Ch)
            </div>
            
            <div title={installingTarget ? 'Install in progress' : undefined}>
              <button 
                className="btn-primary"
                onClick={handleInstallEthos}
                disabled={installingTarget !== null}
                aria-label="Select SD card folder and install Ethos Lua scripts"
              >
                {installingTarget === 'ethos' ? 'Installing...' : 'Select SD Card'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="description-box">
        <div className="flash-card-header">
           <div className="flash-card-title">LUA NOTES</div>
        </div>
        <div className="description-content">
          <div>
            Install the Lua scripts for your radio. 
            These scripts allow you to configure mLRS parameters directly from your radio's interface.
          </div>
          <div>
            <ul>
              <li style={{ marginTop: '8px' }}>
                <strong>EdgeTX/OpenTX:</strong> Choose your radio's screen type, click <strong>Select SD Card</strong> and pick the root folder of the radio's SD card.
                <br />
                <span style={{ fontSize: '0.9em', color: 'var(--text-secondary)' }}>
                  The configuration script is written to <code>/SCRIPTS/TOOLS/</code>, the 32 channel mixes script to <code>/SCRIPTS/MIXES/</code>, and the statistics and 32 channel widgets to <code>/WIDGETS/</code>. 
                  Existing copies are overwritten and other versions of the configuration script are removed.
                  Eject / safely remove the SD card before unplugging, otherwise the files may not be fully written.
                </span>
              </li>
              <li style={{ marginTop: '8px' }}>
                <strong>Ethos:</strong> Click <strong>Select SD Card</strong> and pick the root folder of the radio's SD card.
                <br />
                <span style={{ fontSize: '0.9em', color: 'var(--text-secondary)' }}>
                  The configuration tool is written to <code>/scripts/mlrs/</code> and the 32 channel task script to <code>/scripts/mlrs32/</code>.
                  Existing copies are overwritten and stale compiled bytecode is removed.
                  Eject / safely remove the SD card before unplugging, otherwise the files may not be fully written.
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>

    </div>
  );
}

export default LuaScript;
