import { useState, useEffect } from 'react';
import { api } from '../api/webSerialApi';
import type { Version, FirmwareFile } from '../types';
import './panel.css';

interface LuaScriptProps {
  versions: Version[];
}

const LUA_BASE_URL = 'https://cdn.jsdelivr.net/gh/olliw42/mLRS@main/lua/';

// mLRS.lua variants, user picks the one matching the radio screen
const EDGETX_TOOL_VARIANTS = [
  { id: 'color', label: 'Color Screen (mLRS.lua)', src: 'mLRS.lua' },
  { id: 'bw', label: 'Black & White Screen (mLRS-bw.lua)', src: 'mLRS-bw.lua' },
  { id: 'bw-luac', label: 'Black & White Screen, Low Memory (mLRS-bw-luac.lua)', src: 'mLRS-bw-luac.lua' },
];

// scripts installed regardless of screen type, dest is relative to the sd card root
const EDGETX_COMMON_SCRIPTS = [
  { src: 'mLRSStatsW/main.lua', dest: 'WIDGETS/mLRSStatsW/main.lua' },
  { src: '32ChannelLuaScripts/EdgeTx/mLRS32ChM/mlrs32.lua', dest: 'SCRIPTS/MIXES/mlrs32.lua' },
  { src: '32ChannelLuaScripts/EdgeTx/mLRS32ChW/main.lua', dest: 'WIDGETS/mLRS32ChW/main.lua' },
];

// case-insensitive lookup, sd cards are FAT but the picker api is case-sensitive on some hosts
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

  const luac = await findEntryName(dir, filename.replace(/\.lua$/i, '.luac'));
  if (luac) await dir.removeEntry(luac);
}

function LuaScript({ versions: _versions }: LuaScriptProps) {
  // edgetx/opentx mLRS.lua variant to install
  const [edgeTxVariant, setEdgeTxVariant] = useState(EDGETX_TOOL_VARIANTS[0].id);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<string | null>(null);

  // ethos lua files (lua/ethos folder)
  const [ethosFiles, setEthosFiles] = useState<FirmwareFile[]>([]);
  const [selectedEthosFile, setSelectedEthosFile] = useState('');
  
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // fetch lua files from main branch on mount
  useEffect(() => {
    const fetchFiles = async () => {
      try {
        // fetch ethos lua files
        const ethosRes = await api.listFirmware({ 
          type: 'lua', 
          version: 'main',
          luaFolder: 'ethos'
        });
        const ethosList = ethosRes.files || [];
        setEthosFiles(ethosList);
        if (ethosList.length > 0) {
          setSelectedEthosFile('all');
        }
      } catch (err) {
        console.error('Failed to fetch Lua files:', err);
      }
    };

    fetchFiles();
  }, []);

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
    } catch (err: any) {
      // user closed the picker
      if (err?.name === 'AbortError') return;
      setError(`Failed to open folder: ${err.message || err}`);
      return;
    }

    try {
      setIsInstalling(true);
      const variant = EDGETX_TOOL_VARIANTS.find(v => v.id === edgeTxVariant)!;
      const scripts = [
        { src: variant.src, dest: `SCRIPTS/TOOLS/${variant.src}` },
        ...EDGETX_COMMON_SCRIPTS,
      ];

      // download everything first so a failed fetch leaves the sd card untouched
      const contents = await Promise.all(scripts.map(async (script) => {
        const response = await fetch(LUA_BASE_URL + script.src);
        if (!response.ok) throw new Error(`Failed to download ${script.src} (${response.status})`);
        return response.arrayBuffer();
      }));

      for (let i = 0; i < scripts.length; i++) {
        await writeScript(root, scripts[i].dest, contents[i]);
      }
      await removeOtherToolVariants(root, variant.src);

      setInstallResult(`Installed ${scripts.length} scripts to "${root.name}": ${scripts.map(s => '/' + s.dest).join(', ')}. Eject / safely remove the SD card before unplugging.`);
    } catch (err: any) {
      console.error('Failed to install Lua scripts:', err);
      setError(`Failed to install Lua scripts: ${err.message || err}`);
    } finally {
      setIsInstalling(false);
    }
  };

  const handleDownloadEthos = async () => {
    const files = ethosFiles;
    const selectedFile = selectedEthosFile;
    
    try {
      setIsDownloading(true);
      setError(null);
      
      // determine which files to download
      const filesToDownload = selectedFile === 'all' 
        ? files 
        : files.filter(f => f.filename === selectedFile);
      
      if (filesToDownload.length === 0) {
        throw new Error("No Lua files found to download");
      }

      for (const file of filesToDownload) {
        const response = await fetch(file.url);
        const initialBlob = await response.blob();
        
        const blob = new Blob([initialBlob], { type: 'application/octet-stream' });
        const url = window.URL.createObjectURL(blob);
        
        // trigger browser download
        const a = document.createElement('a');
        a.href = url;
        a.download = file.filename;
        a.target = '_blank';
        a.style.position = 'absolute';
        a.style.left = '-9999px';
        
        document.body.appendChild(a);
        a.click();
        
        // delay cleanup to ensure browser captures the download
        setTimeout(() => {
          window.URL.revokeObjectURL(url);
          document.body.removeChild(a);
        }, 1000);
      }
      
      setIsDownloading(false);
    } catch (err: any) {
      console.error('Failed to download Lua scripts:', err);
      setError(`Failed to start download: ${err.message || err}`);
      setIsDownloading(false);
    }
  };

  // listen for completion
  useEffect(() => {
    const cleanup = api.onComplete((_data: any) => {
      setIsDownloading(false);
    });
    return cleanup;
  }, []);

  return (
    <div className="panel">
      <h2 className="panel-title">Lua Scripts</h2>
      
      {error && (
        <div className="error-box">
          <strong>❌ Error:</strong> {error}
        </div>
      )}

      {installResult && (
        <div className="info-box">
          <strong>✅ Done:</strong> {installResult}
        </div>
      )}
      
      <div className="form-grid">
        {/* EdgeTX/OpenTX sd card install */}
        <div className="form-group span-2 port-group">
          <label>EdgeTX / OpenTX</label>
          <div className="port-row">
            <div className="select-wrapper">
              <select 
                value={edgeTxVariant} 
                onChange={(e) => setEdgeTxVariant(e.target.value)}
                disabled={isInstalling}
                aria-label="Radio screen type"
              >
                {EDGETX_TOOL_VARIANTS.map(v => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </div>
            
            <div title={isInstalling ? 'Install in progress' : undefined}>
                <button 
                className="btn-primary"
                onClick={handleInstallEdgeTx}
                disabled={isInstalling || isDownloading}
                aria-label="Select SD card folder and install EdgeTX/OpenTX Lua scripts"
                >
                {isInstalling ? 'Installing...' : 'Select SD Card'}
                </button>
            </div>
          </div>
        </div>

        {/* Ethos dropdown */}
        <div className="form-group span-2 port-group">
          <label>Ethos</label>
          <div className="port-row">
            <div className="select-wrapper">
              <select 
                value={selectedEthosFile} 
                onChange={(e) => setSelectedEthosFile(e.target.value)}
                disabled={isDownloading || ethosFiles.length === 0}
              >
                {ethosFiles.length > 0 && (
                  <option value="all">All Files</option>
                )}
                {ethosFiles.map(f => (
                  <option key={f.filename} value={f.filename}>{f.filename}</option>
                ))}
              </select>
            </div>
            
            <div title={isDownloading ? 'Download in progress' : ethosFiles.length === 0 ? 'Loading files...' : undefined}>
                <button 
                className="btn-primary"
                onClick={handleDownloadEthos}
                disabled={isDownloading || isInstalling || ethosFiles.length === 0}
                aria-label="Download Ethos Lua scripts"
                >
                {isDownloading ? 'Downloading...' : selectedEthosFile === 'all' ? 'Download All' : 'Download'}
                </button>
            </div>
          </div>
        </div>
      </div>

      {isDownloading && (
        <div style={{ marginTop: '12px' }}>
          <button 
            className="btn-secondary btn-cancel"
            onClick={() => api.cancelPython()}
          >
            Cancel
          </button>
        </div>
      )}

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
              <li style={{ marginTop: '8px' }}><strong>Ethos:</strong> Download and copy all files to <code>/scripts/mLRS/</code> on the radio's SD card.</li>
            </ul>
          </div>
        </div>
      </div>

    </div>
  );
}

export default LuaScript;
