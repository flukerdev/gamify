import React from 'react';
import { BRAND_LETTER } from '../config.js';

// Brand loading mark. The Gamify "G" sits still in a black circle while a
// soft diagonal highlight sweeps across it — like light catching a coin.
// No text; motion is the only "I'm working" signal.
export default function Loading({ size = 56, inline = false }) {
  return (
    <div className={`loading-wrap ${inline ? 'inline' : ''}`} aria-label="Loading" role="status">
      <div
        className="loading-mark"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}>
        <span className="loading-mark-letter">{BRAND_LETTER}</span>
      </div>
    </div>
  );
}
