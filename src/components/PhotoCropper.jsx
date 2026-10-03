import React, { useEffect, useRef, useState } from 'react';

// Square photo cropper: drag to move, pinch or use the slider to zoom.
// `source` is a File (a freshly chosen photo) or a URL string (the card's
// current photo). onDone receives a 512x512 JPEG data URL.
const OUT = 512;
// High enough to pull one face out of a group photo.
const MAX_ZOOM = 8;
const MAX_BYTES = 280 * 1024;

export default function PhotoCropper({ source, onCancel, onDone }) {
  const frameRef = useRef(null);
  const loadedRef = useRef(null);
  const centeredFor = useRef(null);
  const lastFrame = useRef(0);
  const pointers = useRef(new Map());
  const pinch = useRef(null);
  const [img, setImg] = useState(null);       // { url, w, h, revoke }
  const [frame, setFrame] = useState(0);      // frame side in CSS px
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Load the source image.
  useEffect(() => {
    let cancelled = false;
    const isFile = typeof source !== 'string';
    const url = isFile ? URL.createObjectURL(source) : source;
    const el = new Image();
    el.onload = () => {
      if (cancelled) return;
      if (!el.naturalWidth || !el.naturalHeight) { setErr('That photo could not be opened. Try a different one.'); return; }
      // Keep the decoded image itself: the export draws from it, not from the
      // on-screen <img> (which may not have decoded yet).
      loadedRef.current = el;
      setImg({ url, w: el.naturalWidth, h: el.naturalHeight });
    };
    el.onerror = () => { if (!cancelled) setErr('That photo could not be opened. Try a different one.'); };
    el.src = url;
    return () => { cancelled = true; if (isFile) URL.revokeObjectURL(url); };
  }, [source]);

  // Track the frame's size (it is fluid) so the math always uses real pixels.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setFrame(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  // Scale at zoom 1 makes the image just cover the frame.
  const base = img && frame ? frame / Math.min(img.w, img.h) : 1;
  const scale = base * view.zoom;

  function clamp(v, zoomOverride) {
    if (!img || !frame) return v;
    const z = Math.min(MAX_ZOOM, Math.max(1, zoomOverride ?? v.zoom));
    const s = base * z;
    const minX = frame - img.w * s;
    const minY = frame - img.h * s;
    return { zoom: z, x: Math.min(0, Math.max(minX, v.x)), y: Math.min(0, Math.max(minY, v.y)) };
  }

  // Center a new image once. If only the frame changes size afterwards (the
  // phone rotates), keep the same crop by scaling the offsets with it.
  useEffect(() => {
    if (!img || !frame) return;
    if (centeredFor.current !== img) {
      centeredFor.current = img;
      const s = frame / Math.min(img.w, img.h);
      setView({ zoom: 1, x: (frame - img.w * s) / 2, y: (frame - img.h * s) / 2 });
    } else if (lastFrame.current && lastFrame.current !== frame) {
      const k = frame / lastFrame.current;
      setView(v => clamp({ ...v, x: v.x * k, y: v.y * k }));
    }
    lastFrame.current = frame;
  }, [img, frame]);

  // Zoom keeping the point (px, py) of the frame fixed under the finger.
  function zoomAt(v, nextZoom, px, py) {
    const z = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
    const s0 = base * v.zoom;
    const s1 = base * z;
    const ix = (px - v.x) / s0;
    const iy = (py - v.y) / s0;
    return clamp({ zoom: z, x: px - ix * s1, y: py - iy * s1 }, z);
  }

  function localPoint(e) {
    const r = frameRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function onPointerDown(e) {
    if (!img) return;
    e.preventDefault();
    try { frameRef.current.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    pointers.current.set(e.pointerId, localPoint(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: view.zoom };
    }
  }
  function onPointerMove(e) {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId);
    const cur = localPoint(e);
    pointers.current.set(e.pointerId, cur);
    if (pointers.current.size === 1) {
      setView(v => clamp({ ...v, x: v.x + (cur.x - prev.x), y: v.y + (cur.y - prev.y) }));
    } else if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const target = pinch.current.zoom * (dist / pinch.current.dist);
      setView(v => zoomAt(v, target, mid.x, mid.y));
    }
  }
  function onPointerUp(e) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }
  function onWheel(e) {
    if (!img) return;
    const p = localPoint(e);
    setView(v => zoomAt(v, v.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), p.x, p.y));
  }
  function onSlider(e) {
    const z = Number(e.target.value);
    setView(v => zoomAt(v, z, frame / 2, frame / 2));
  }

  function finish() {
    if (!img || !frame || busy) return;
    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUT; canvas.height = OUT;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, OUT, OUT);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const side = frame / scale;               // crop size in image pixels
      ctx.drawImage(loadedRef.current, -view.x / scale, -view.y / scale, side, side, 0, 0, OUT, OUT);
      let quality = 0.86;
      let out = canvas.toDataURL('image/jpeg', quality);
      // base64 is ~4/3 the byte size; step quality down if a busy photo runs large.
      while (out.length * 0.75 > MAX_BYTES && quality > 0.5) {
        quality -= 0.1;
        out = canvas.toDataURL('image/jpeg', quality);
      }
      if (!out.startsWith('data:image/jpeg')) throw new Error('unsupported');
      onDone(out);
    } catch {
      setErr('Could not save that crop. Try choosing the photo again.');
      setBusy(false);
    }
  }

  return (
    <div className="cropper">
      <div
        ref={frameRef}
        className="crop-frame"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        onWheel={onWheel}>
        {img ? (
          <img
            src={img.url}
            alt=""
            draggable={false}
            className="crop-img"
            style={{
              width: img.w * scale, height: img.h * scale,
              transform: `translate3d(${view.x}px, ${view.y}px, 0)`,
            }} />
        ) : !err ? <div className="face-photo-loading" /> : null}
        <div className="crop-guide" aria-hidden="true" />
      </div>

      {err ? <div className="form-error" role="alert">{err}</div> : (
        <>
          <div className="crop-zoom">
            <span className="crop-zoom-label" aria-hidden="true">−</span>
            <input
              type="range" min="1" max={MAX_ZOOM} step="0.01"
              value={view.zoom} onChange={onSlider}
              aria-label="Zoom" disabled={!img} />
            <span className="crop-zoom-label" aria-hidden="true">+</span>
          </div>
          <p className="hint crop-hint">Drag to move. Pinch or use the slider to zoom. Keep the face inside the circle.</p>
        </>
      )}

      <div className="crop-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={finish} disabled={!img || busy || !!err}>
          Use this photo
        </button>
      </div>
    </div>
  );
}
