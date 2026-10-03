// Card photos for photo games.
//
// Photos are private: they are fetched through the API with the session token
// (so a plain <img src> cannot load them) and turned into object URLs. Each
// (pair, version) is fetched at most once per page load, and the browser's
// own HTTP cache makes later page loads instant because the versioned URL is
// served as immutable.
import { api } from './api.js';

const versions = new Map();   // pairId -> photo_version
const urls = new Map();       // `${pairId}:${version}` -> Promise<objectURL>

// GameShell calls this whenever it (re)loads the game's cards.
export function setPhotoVersions(pairs) {
  for (const p of pairs || []) {
    if (p.photo_version != null) versions.set(p.id, p.photo_version);
    else versions.delete(p.id);
  }
}

export function photoVersion(pairId) {
  return versions.has(pairId) ? versions.get(pairId) : null;
}

// Resolves to an object URL, or rejects if the card has no photo.
export function loadPhoto(gameId, pairId) {
  const v = photoVersion(pairId);
  if (v == null) return Promise.reject(new Error('No photo'));
  const key = `${pairId}:${v}`;
  if (!urls.has(key)) {
    const p = api.getBlob(`/api/games/${gameId}/photos/${pairId}?v=${v}`)
      .then(blob => URL.createObjectURL(blob));
    // A failed fetch must not be remembered, or the photo could never retry.
    p.catch(() => { if (urls.get(key) === p) urls.delete(key); });
    urls.set(key, p);
  }
  return urls.get(key);
}

// Warm every photo in the background, a few at a time, so cards flip without
// a loading flash.
export function preloadPhotos(gameId, pairs) {
  const ids = (pairs || []).filter(p => p.photo_version != null).map(p => p.id);
  let i = 0;
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try { await loadPhoto(gameId, id); } catch { /* shown as a placeholder */ }
    }
  };
  for (let n = 0; n < 4; n++) worker();
}
