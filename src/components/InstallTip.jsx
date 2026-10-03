import React, { useState } from 'react';

// A short "put this on your home screen" nudge, shown only when the app is
// running in a browser tab (not once it has been installed).
function isStandalone() {
  try {
    return window.navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches;
  } catch { return false; }
}
function platform() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  // iPadOS reports as a Mac; the touch check tells them apart.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

export default function InstallTip() {
  const [open, setOpen] = useState(false);
  if (isStandalone()) return null;
  const p = platform();
  return (
    <div className="install-tip">
      <button type="button" className="install-tip-toggle" onClick={() => setOpen(!open)}
        aria-expanded={open}>
        {open ? 'Hide' : 'Add this app to your home screen'}
      </button>
      {open ? (
        <ol className="install-steps">
          {p === 'android' ? (
            <>
              <li>Open this page in <b>Chrome</b>.</li>
              <li>Tap the <b>⋮</b> menu at the top right.</li>
              <li>Tap <b>Add to Home screen</b>, then <b>Add</b>.</li>
            </>
          ) : p === 'ios' ? (
            <>
              <li>Open this page in <b>Safari</b>.</li>
              <li>Tap the <b>Share</b> button (the square with an arrow).</li>
              <li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
            </>
          ) : (
            <>
              <li><b>iPhone:</b> open in Safari, tap Share, then Add to Home Screen.</li>
              <li><b>Android:</b> open in Chrome, tap ⋮, then Add to Home screen.</li>
            </>
          )}
          <li>From now on, open it from the new icon.</li>
        </ol>
      ) : null}
    </div>
  );
}
