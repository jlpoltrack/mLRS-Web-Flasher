import type { OutputEvent } from '../types';

export const api = {
  listVersions: async () => ({ 
    versions: [
      { version: 'v1.0.0', versionStr: 'v1.0.0 (Stable)' },
      { version: 'v0.9.0', versionStr: 'v0.9.0' }
    ] 
  }),
  listDevices: async (_type: string) => ({ 
    devices: ['DIY_2400_TX_ESP32', 'DIY_900_RX_ESP32', 'R9M_TX'] 
  }),
  listFirmware: async (_options: unknown) => ({ 
    files: [
      { filename: 'firmware-v1.0.0.bin', url: 'mock://firmware.bin', size: 1024 }
    ] 
  }),
  listPorts: async () => ({ ports: [] as string[] }),
  getMetadata: async (_options: unknown) => ({
    raw_flashmethod: 'uart,dfu,stlink',
    description: 'Mock metadata to enable UI elements for testing.',
    needsPort: true 
  }),
  pickDirectory: async (): Promise<string | null> => null,

  flash: async (options: unknown): Promise<void> => { console.log('Mock flash', options); },
  downloadLua: async (options: unknown): Promise<void> => { console.log('Mock downloadLua', options); },
  cancelPython: async (): Promise<void> => { console.log('Mock cancel'); },
  
  onOutput: (callback: (data: OutputEvent) => void) => {
    // mock some logs
    setTimeout(() => callback({ type: 'info', message: 'Mock init...' }), 500);
    return () => {};
  },
  onComplete: (_callback: (data: unknown) => void) => {
    return () => {};
  },
  
  // Real Web Serial Implementation (kept from previous step)
  requestPort: async (): Promise<string | null> => {
    if (!navigator.serial) {
      alert('Web Serial API not supported in this browser.');
      return null;
    }
    try {
      const port = await navigator.serial.requestPort();
      return formatPortName(port);
    } catch {
      // User cancelled
      return null;
    }
  },
};

// Helper for formatting port name
function formatPortName(port: SerialPort): string {
  const info = port.getInfo();
  const vid = info.usbVendorId ? info.usbVendorId.toString(16).padStart(4, '0') : '????';
  const pid = info.usbProductId ? info.usbProductId.toString(16).padStart(4, '0') : '????';
  return `USB Device (${vid}:${pid})`;
}
