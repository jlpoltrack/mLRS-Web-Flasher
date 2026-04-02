import { useState, useCallback } from 'react';
import { SERIAL_FILTERS, LogType } from '../constants';
import { formatPortName } from '../api/hardwareService';
import type { LogEntry } from '../types';

export function useSerialPort(addLog: (entry: LogEntry) => void) {
  const [port, setPort] = useState<SerialPort | null>(null);
  const [portName, setPortName] = useState('');

  const selectPort = useCallback(async () => {
    if (!navigator.serial) {
      addLog({ type: LogType.Error, message: 'Web Serial API not supported in this browser.' });
      return;
    }
    try {
      const selected = await navigator.serial.requestPort({ filters: [...SERIAL_FILTERS] });
      setPort(selected);
      setPortName(formatPortName(selected));
    } catch {
      // user cancelled
    }
  }, [addLog]);

  return { port, portName, selectPort };
}
