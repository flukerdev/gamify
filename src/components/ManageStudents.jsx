import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { loadPhoto } from '../photos.js';
import FacePhoto from './FacePhoto.jsx';
import PhotoCropper from './PhotoCropper.jsx';
import InviteFriends from './InviteFriends.jsx';
import { rememberLink, memberLink } from '../link.js';

// Admin-only manager for a photo game. Three things live here:
//   Students   add, rename, re-crop / replace the photo, remove
//   People     take someone off the leaderboard
//   Links      the staff invite link, and making new links if one gets out
// Every change saves on its own and applies to everyone right away.
export default function ManageStudents({ game, pairs, user, onChanged, onClose }) {
  const [section, setSection] = useState('students'); // students | people | links
  const [editing, setEditing] = useState(null);       // null | { id, name } (id null = new)
  const [notice, setNotice] = useState('');

  function flash(msg) {
    setNotice(msg);
    setTimeout(() => setNotice(n => (n === msg ? '' : n)), 2500);
  }

  if (editing) {
    return (
      <Sheet title={editing.id ? 'Edit student' : 'Add a student'} onClose={() => setEditing(null)} closeLabel="Back">
        <StudentEditor
          game={game}
          student={editing}
          onCancel={() => setEditing(null)}
          onSaved={async (msg) => { await onChanged(); setEditing(null); flash(msg); }} />
      </Sheet>
    );
  }

  const students = (pairs || []).slice().sort((a, b) =>
    a.definition.localeCompare(b.definition, undefined, { sensitivity: 'base' }));

  return (
    <Sheet title="Manage" onClose={onClose} closeLabel="Close">
      <div className="seg" role="tablist">
        {[['students', 'Students'], ['people', 'Staff'], ['links', 'Links']].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={section === id}
            className={`seg-btn ${section === id ? 'on' : ''}`} onClick={() => { setSection(id); setNotice(''); }}>
            {label}
          </button>
        ))}
      </div>
      {notice ? <div className="saved-note" role="status">{notice}</div> : null}

      {section === 'students' && (
        <>
          <button className="btn btn-primary add-student" onClick={() => setEditing({ id: null, name: '' })}>
            + Add a student
          </button>
          <div className="muted small student-count">
            {students.length} {students.length === 1 ? 'student' : 'students'}. Tap one to edit.
          </div>
          <div className="student-list">
            {students.map(p => (
              <button key={p.id} className="student-row" onClick={() => setEditing({ id: p.id, name: p.definition })}>
                <FacePhoto gameId={game.id} pairId={p.id} size={52} className="round" />
                <span className="student-name">{p.definition}</span>
                <span className="student-edit">Edit</span>
              </button>
            ))}
          </div>
        </>
      )}
      {section === 'people' && <PeopleSection game={game} user={user} onNotice={flash} />}
      {section === 'links' && <LinksSection game={game} user={user} onChanged={onChanged} onNotice={flash} />}
    </Sheet>
  );
}

function Sheet({ title, onClose, closeLabel, children }) {
  return (
    <div className="modal-wrap">
      <div className="modal sheet">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost small" onClick={onClose}>{closeLabel}</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ students

function StudentEditor({ game, student, onCancel, onSaved }) {
  const isNew = !student.id;
  const [name, setName] = useState(student.name);
  const [photo, setPhoto] = useState(null);         // new cropped data URL, if any
  const [cropSource, setCropSource] = useState(null); // File | url while cropping
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileRef = useRef(null);

  function pickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';   // let the same file be chosen again later
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) { setErr('Please choose a photo.'); return; }
    setErr('');
    setCropSource(file);
  }

  async function recropCurrent() {
    setErr('');
    try {
      // Re-crop from the unsaved crop if there is one, else the saved photo.
      setCropSource(photo || await loadPhoto(game.id, student.id));
    } catch { setErr('Could not open the current photo. Choose a new one instead.'); }
  }

  async function save() {
    if (busy) return;
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean) { setErr("Enter the student's name."); return; }
    if (isNew && !photo) { setErr('Choose a photo first.'); return; }
    setErr(''); setBusy(true);
    try {
      if (isNew) {
        await api.post(`/api/games/${game.id}/students`, { name: clean, photo });
        await onSaved(`${clean} added.`);
      } else {
        const body = {};
        if (clean !== student.name) body.name = clean;
        if (photo) body.photo = photo;
        if (Object.keys(body).length) await api.put(`/api/games/${game.id}/students/${student.id}`, body);
        await onSaved(`${clean} saved.`);
      }
    } catch (e) { setErr(e.message || 'Could not save. Try again.'); setBusy(false); }
  }

  async function remove() {
    if (busy) return;
    setErr(''); setBusy(true);
    try {
      await api.del(`/api/games/${game.id}/students/${student.id}`);
      await onSaved(`${student.name} removed.`);
    } catch (e) { setErr(e.message || 'Could not remove. Try again.'); setBusy(false); }
  }

  if (cropSource) {
    return (
      <PhotoCropper
        source={cropSource}
        onCancel={() => setCropSource(null)}
        onDone={(dataUrl) => { setPhoto(dataUrl); setCropSource(null); }} />
    );
  }

  const hasPhoto = !!photo || !isNew;
  return (
    <div className="student-editor">
      <input ref={fileRef} type="file" accept="image/*" className="visually-hidden"
        onChange={pickFile} tabIndex={-1} aria-hidden="true" />

      <div className="editor-photo">
        {photo
          ? <div className="face-photo ready"><img src={photo} alt="New photo" /></div>
          : !isNew
            ? <FacePhoto gameId={game.id} pairId={student.id} />
            : (
              <button type="button" className="photo-drop" onClick={() => fileRef.current?.click()}>
                <span className="photo-drop-plus" aria-hidden="true">+</span>
                <span>Choose a photo</span>
              </button>
            )}
      </div>
      {hasPhoto ? (
        <div className="editor-photo-actions">
          <button type="button" className="btn btn-secondary small" onClick={recropCurrent} disabled={busy}>
            Zoom / crop
          </button>
          <button type="button" className="btn btn-secondary small" onClick={() => fileRef.current?.click()} disabled={busy}>
            {isNew ? 'Choose a different photo' : 'Replace photo'}
          </button>
        </div>
      ) : null}

      <label className="field-label" htmlFor="st-name">Name on the back of the card</label>
      <input id="st-name" className="text-input" value={name} maxLength={40}
        onChange={(e) => { setName(e.target.value); setErr(''); }}
        autoCapitalize="words" autoCorrect="off" autoComplete="off" spellCheck={false}
        placeholder="First name" />

      {err ? <div className="form-error" role="alert">{err}</div> : null}

      <div className="editor-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : isNew ? 'Add student' : 'Save'}
        </button>
      </div>

      {!isNew ? (
        <div className="danger-zone">
          {confirmRemove ? (
            <>
              <p className="danger-text">Remove {student.name} and delete their photo? This cannot be undone.</p>
              <div className="editor-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmRemove(false)} disabled={busy}>Keep</button>
                <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>Remove</button>
              </div>
            </>
          ) : (
            <button type="button" className="btn btn-ghost danger-link" onClick={() => setConfirmRemove(true)} disabled={busy}>
              Remove this student
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------- people

function PeopleSection({ game, user, onNotice }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [confirmId, setConfirmId] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const { leaderboard } = await api.get(`/api/games/${game.id}/leaderboard`);
      setRows((leaderboard || []).slice().sort((a, b) =>
        `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`, undefined, { sensitivity: 'base' })));
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [game.id]);

  async function remove(r) {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      await api.del(`/api/games/${game.id}/members/${r.userId}`);
      setConfirmId(null);
      await load();
      onNotice(`${r.firstName} ${r.lastName} removed.`);
    } catch (e) { setErr(e.message || 'Could not remove. Try again.'); }
    setBusy(false);
  }

  if (err && !rows) return <div className="form-error">{err}</div>;
  if (!rows) return <div className="muted">Loading…</div>;
  return (
    <>
      <p className="hub-sub">
        Everyone who has signed in. Remove someone who has left, or a name that was typed wrong. Their points go with them.
      </p>
      {err ? <div className="form-error" role="alert">{err}</div> : null}
      <div className="student-list">
        {rows.map(r => (
          <div key={r.userId} className="person-row">
            <div className="person-main">
              <span className="student-name">{r.firstName} {r.lastName}{r.userId === user.id ? ' (you)' : ''}</span>
              <span className="muted small">{Math.round(Number(r.totalPoints))} pts</span>
            </div>
            {r.userId === user.id ? null : confirmId === r.userId ? (
              <div className="person-confirm">
                <button className="btn btn-ghost small" onClick={() => setConfirmId(null)} disabled={busy}>Keep</button>
                <button className="btn btn-danger small" onClick={() => remove(r)} disabled={busy}>Remove</button>
              </div>
            ) : (
              <button className="btn btn-ghost small" onClick={() => setConfirmId(r.userId)}>Remove</button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// --------------------------------------------------------------------- links

function LinksSection({ game, user, onChanged, onNotice }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [adminLink, setAdminLink] = useState('');
  const [copied, setCopied] = useState(false);

  async function reset() {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const out = await api.post(`/api/games/${game.id}/links/reset`, {});
      // This phone keeps working: remember the new admin link right away.
      rememberLink(out.adminCode, `${user.first_name}${user.last_name ? ` ${user.last_name}` : ''}`);
      setAdminLink(memberLink(out.adminCode));
      setConfirm(false);
      await onChanged();
      onNotice('New links are ready.');
    } catch (e) { setErr(e.message || 'Could not reset. Try again.'); setConfirm(false); }
    setBusy(false);
  }
  async function copyAdmin() {
    try { await navigator.clipboard.writeText(adminLink); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { /* they can still select the text */ }
  }

  return (
    <>
      <p className="hub-sub">Send the staff link to anyone who should play. They tap it and type their name. That is all.</p>
      <InviteFriends game={game} compact />

      {adminLink ? (
        <div className="invite-card compact admin-link-card">
          <h3 className="invite-title">Your new admin link</h3>
          <p className="hint">Save this now. It is the only link that opens Manage, and it is not shown again.</p>
          <div className="invite-link-row">
            <input className="text-input invite-link-input" readOnly value={adminLink} onFocus={(e) => e.target.select()} />
            <button className="btn btn-primary" onClick={copyAdmin}>{copied ? 'Copied!' : 'Copy link'}</button>
          </div>
        </div>
      ) : null}

      {err ? <div className="form-error" role="alert">{err}</div> : null}
      <div className="danger-zone">
        {confirm ? (
          <>
            <p className="danger-text">
              Make new links? The old staff link and the old admin link stop working and everyone is signed out
              until they open the new link. Points are kept. You stay signed in on this phone.
            </p>
            <div className="editor-actions">
              <button className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
              <button className="btn btn-danger" onClick={reset} disabled={busy}>{busy ? 'Working…' : 'Make new links'}</button>
            </div>
          </>
        ) : (
          <button className="btn btn-ghost danger-link" onClick={() => setConfirm(true)}>
            Link got out? Make new links
          </button>
        )}
      </div>
    </>
  );
}
