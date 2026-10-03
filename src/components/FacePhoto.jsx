import React, { useEffect, useState } from 'react';
import { loadPhoto, photoVersion } from '../photos.js';

// A card's photo. Shows a quiet placeholder while loading and a neutral
// silhouette if the card has no photo (or it failed to load), so layout never
// jumps and nothing ever renders as a broken image.
export default function FacePhoto({ gameId, pairId, size, className = '', alt = 'Student photo' }) {
  const version = photoVersion(pairId);
  const [state, setState] = useState({ key: null, url: null, failed: false });
  const key = `${pairId}:${version}`;

  useEffect(() => {
    let cancelled = false;
    setState({ key, url: null, failed: false });
    loadPhoto(gameId, pairId)
      .then(url => { if (!cancelled) setState({ key, url, failed: false }); })
      .catch(() => { if (!cancelled) setState({ key, url: null, failed: true }); });
    return () => { cancelled = true; };
  }, [gameId, pairId, version]);

  const style = size ? { width: size, height: size } : undefined;
  const ready = state.key === key && state.url;
  return (
    <div className={`face-photo ${ready ? 'ready' : ''} ${className}`} style={style}>
      {ready
        ? <img src={state.url} alt={alt} draggable={false} />
        : state.failed
          ? <Silhouette />
          : <div className="face-photo-loading" aria-label="Loading photo" />}
    </div>
  );
}

function Silhouette() {
  return (
    <svg viewBox="0 0 100 100" className="face-photo-empty" role="img" aria-label="No photo">
      <circle cx="50" cy="38" r="18" />
      <path d="M14 96c2-22 18-32 36-32s34 10 36 32z" />
    </svg>
  );
}
