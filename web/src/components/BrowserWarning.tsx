import React, { useState, useEffect } from 'react';
import { isSerialSupported, isUSBSupported } from '../api/hardwareService';
import './browserWarning.css';

const BrowserWarning: React.FC = () => {
  const [hasSerial, setHasSerial] = useState(true);
  const [hasUSB, setHasUSB] = useState(true);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    setHasSerial(isSerialSupported());
    setHasUSB(isUSBSupported());
  }, []);

  if ((hasSerial && hasUSB) || !isVisible) {
    return null;
  }

  // serial but no webusb (e.g. Firefox 151+): everything works except DFU and SWD
  const partial = hasSerial && !hasUSB;

  return (
    <div className="browser-warning-overlay">
      <div className={`browser-warning-banner${partial ? ' partial' : ''}`}>
        <div className="warning-icon">{partial ? 'ℹ️' : '⚠️'}</div>
        <div className="warning-content">
          {partial ? (
            <>
              <h3>Limited Browser Support</h3>
              <p>
                Your browser supports <strong>Web Serial</strong> but not <strong>WebUSB</strong>.
              </p>
              <p>
                Serial flashing, passthrough and the parameter editor all work; only{' '}
                <strong>DFU</strong> and <strong>SWD / ST-Link</strong> are unavailable.
              </p>
              <p>
                For DFU or SWD, use a Chromium-based browser such as{' '}
                <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong>.
              </p>
            </>
          ) : (
            <>
              <h3>Unsupported Browser Detected</h3>
              <p>
                Your browser does not support <strong>Web Serial</strong>, which is required to
                flash firmware.
              </p>
              <p>
                Please use <strong>Firefox 151+</strong> (everything except DFU and SWD) or a
                Chromium-based browser such as <strong>Google Chrome</strong> or{' '}
                <strong>Microsoft Edge</strong> for full functionality.
              </p>
            </>
          )}
        </div>
        <button className="dismiss-btn" onClick={() => setIsVisible(false)} title="Dismiss">
          ✕
        </button>
      </div>
    </div>
  );
};

export default BrowserWarning;
