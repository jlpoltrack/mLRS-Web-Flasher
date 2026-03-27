// tools page - standalone chip erase operations
// 2026-03-26

import { useState, useCallback } from 'react';
import { eraseESP, eraseSTM32UART, eraseSTM32DFU, eraseSTM32SWD } from '../api/eraseService';
import { SERIAL_FILTERS, DFU_USB_FILTERS, LogType } from '../constants';
import { getStlinkFilters } from '../api/stlink';
import { formatPortName } from '../api/hardwareService';
import type { LogEntry } from '../types';
import './tools.css';

type DeviceType = 'esp' | 'stm32';
type Stm32Method = 'uart' | 'dfu' | 'swd';

interface ToolsProps {
  addLog: (entry: LogEntry) => void;
}

function Tools({ addLog }: ToolsProps) {
  const [deviceType, setDeviceType] = useState<DeviceType>('esp');
  const [stm32Method, setStm32Method] = useState<Stm32Method>('uart');
  const [serialPort, setSerialPort] = useState<SerialPort | null>(null);
  const [portName, setPortName] = useState<string>('');
  const [usbDevice, setUsbDevice] = useState<USBDevice | null>(null);
  const [usbDeviceName, setUsbDeviceName] = useState<string>('');
  const [isErasing, setIsErasing] = useState(false);
  const [progress, setProgress] = useState(0);

  const needsUSB = deviceType === 'stm32' && (stm32Method === 'dfu' || stm32Method === 'swd');

  // reset hardware selection when switching device type or method
  const handleDeviceTypeChange = useCallback((type: DeviceType) => {
    setDeviceType(type);
    setSerialPort(null);
    setPortName('');
    setUsbDevice(null);
    setUsbDeviceName('');
    setProgress(0);
  }, []);

  const handleMethodChange = useCallback((method: Stm32Method) => {
    setStm32Method(method);
    setSerialPort(null);
    setPortName('');
    setUsbDevice(null);
    setUsbDeviceName('');
    setProgress(0);
  }, []);

  const handleSelectPort = useCallback(async () => {
    if (!navigator.serial) {
      addLog({ type: LogType.Error, message: 'Web Serial API not supported in this browser.' });
      return;
    }
    try {
      const port = await navigator.serial.requestPort({ filters: [...SERIAL_FILTERS] });
      setSerialPort(port);
      setPortName(formatPortName(port));
    } catch (_) {
      // user cancelled
    }
  }, [addLog]);

  const handleSelectUSBDevice = useCallback(async () => {
    if (!navigator.usb) {
      addLog({ type: LogType.Error, message: 'WebUSB API not supported in this browser.' });
      return;
    }
    try {
      const requestOptions = stm32Method === 'swd'
        ? getStlinkFilters()
        : { filters: [...DFU_USB_FILTERS] };
      const device = await navigator.usb.requestDevice(requestOptions);
      setUsbDevice(device);
      if (stm32Method === 'swd') {
        setUsbDeviceName(device.productName || 'ST-Link');
      } else {
        const vid = device.vendorId.toString(16).padStart(4, '0').toUpperCase();
        const pid = device.productId.toString(16).padStart(4, '0').toUpperCase();
        setUsbDeviceName(`STM32 DFU (${vid}:${pid})`);
      }
    } catch (_) {
      // user cancelled
    }
  }, [addLog]);

  const handleErase = useCallback(async () => {
    setIsErasing(true);
    setProgress(0);

    const options = {
      onLog: (message: string) => {
        addLog({ type: LogType.Info, message });
      },
      onProgress: (pct: number, _status: string) => {
        setProgress(pct);
      },
    };

    try {
      if (deviceType === 'esp') {
        if (!serialPort) return;
        addLog({ type: LogType.Info, message: 'Starting ESP full chip erase...' });
        await eraseESP(serialPort, options);
      } else if (stm32Method === 'uart') {
        if (!serialPort) return;
        addLog({ type: LogType.Info, message: 'Starting STM32 UART full chip erase...' });
        await eraseSTM32UART(serialPort, options);
      } else if (stm32Method === 'dfu') {
        if (!usbDevice) return;
        addLog({ type: LogType.Info, message: 'Starting STM32 DFU full chip erase...' });
        await eraseSTM32DFU(usbDevice, options);
      } else {
        if (!usbDevice) return;
        addLog({ type: LogType.Info, message: 'Starting STM32 SWD full chip erase...' });
        await eraseSTM32SWD(usbDevice, options);
      }

      addLog({ type: LogType.Success, message: 'Full chip erase completed successfully!' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog({ type: LogType.Error, message: `Erase failed: ${msg}` });
    } finally {
      setIsErasing(false);
    }
  }, [deviceType, stm32Method, serialPort, usbDevice, addLog]);

  const hasDevice = needsUSB ? !!usbDevice : !!serialPort;
  const canErase = hasDevice && !isErasing;

  // render port/USB selection row matching panel.css patterns
  const renderDeviceRow = () => {
    if (needsUSB) {
      const label = stm32Method === 'swd' ? 'ST-Link Device (SWD)' : 'USB Device (DFU)';
      return (
        <div className="form-group port-group full-width">
          <label>{label}</label>
          <div className="port-row">
            {usbDevice ? (
              <>
                <div className="static-display">{usbDeviceName}</div>
                <button
                  className="btn-secondary"
                  onClick={handleSelectUSBDevice}
                  disabled={isErasing}
                >
                  Change Device
                </button>
              </>
            ) : (
              <>
                <div className="static-display">{stm32Method === 'swd' ? 'No ST-Link selected' : 'No DFU device selected'}</div>
                <button
                  className="btn-secondary"
                  onClick={handleSelectUSBDevice}
                  disabled={isErasing}
                >
                  Add Device
                </button>
              </>
            )}

            <button
              className="btn-danger btn-flash"
              onClick={handleErase}
              disabled={!canErase}
            >
              {isErasing
                ? (progress > 0 ? `Erasing... ${progress}%` : 'Erasing...')
                : 'Erase Flash'}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="form-group port-group full-width">
        <label>COM Port</label>
        <div className="port-row">
          {serialPort ? (
            <>
              <div className="static-display">{portName}</div>
              <button
                className="btn-secondary"
                onClick={handleSelectPort}
                disabled={isErasing}
              >
                Change Port
              </button>
            </>
          ) : (
            <>
              <div className="static-display">No device selected</div>
              <button
                className="btn-secondary"
                onClick={handleSelectPort}
                disabled={isErasing}
              >
                Add Device
              </button>
            </>
          )}

          <button
            className="btn-danger btn-flash"
            onClick={handleErase}
            disabled={!canErase}
          >
            {isErasing
              ? (progress > 0 ? `Erasing... ${progress}%` : 'Erasing...')
              : 'Erase Flash'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="panel">
      <h2 className="panel-title">Tools</h2>

      <div className="tools-section">
        <h3 className="tools-section-title">Full Chip Erase</h3>
      </div>

      <div className="warning-box">
        ⚠️ Full Chip Erase will permanently delete all flash contents. This cannot be undone.
      </div>

      <div className="form-grid">
        {/* row 1: device type + stm32 method */}
        <div className={`form-group ${deviceType === 'stm32' ? 'span-2' : 'span-4'}`}>
          <label>Device Type</label>
          <div className="select-wrapper">
            <select
              value={deviceType}
              onChange={(e) => handleDeviceTypeChange(e.target.value as DeviceType)}
              disabled={isErasing}
            >
              <option value="esp">ESP</option>
              <option value="stm32">STM32</option>
            </select>
          </div>
        </div>

        {deviceType === 'stm32' && (
          <div className="form-group span-2">
            <label>Connection Method</label>
            <div className="select-wrapper">
              <select
                value={stm32Method}
                onChange={(e) => handleMethodChange(e.target.value as Stm32Method)}
                disabled={isErasing}
              >
                <option value="uart">SystemBoot (UART)</option>
                <option value="dfu">DFU (USB)</option>
                <option value="swd">STLink (SWD)</option>
              </select>
            </div>
          </div>
        )}

        {/* row 2: device connection + erase button */}
        {renderDeviceRow()}
      </div>
    </div>
  );
}

export default Tools;
