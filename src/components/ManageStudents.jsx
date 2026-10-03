import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { loadPhoto } from '../photos.js';
import FacePhoto from './FacePhoto.jsx';
import PhotoCropper from './PhotoCropper.jsx';

// Admin-only manager for a photo game. Three things live here:
//   Students   add, rename, re-crop / replace the photo, remove
//   People     take someone off the leaderboard
//   Passcodes  change the staff or admin passcode
// Every change saves on its own and applies to everyone right away.
export default function ManageStudents({ game, pairs, user, onChanged, onClose }) {
  const [section, setSection] = useState('students'); // students | people | passcodes
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
        {[['students', 'Students'], ['people', 'Staff'], ['passcodes', 'Passcodes']].map(([id, label]) => (
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
      {section === 'passcodes' && <PasscodeSection game={game} onNotice={flash} />}
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

// ----------------------------------------------------------------- passcodes

function PasscodeSection({ game, onNotice }) {
  const [staff, setStaff] = useState('');
  const [admin, setAdmin] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function review() {
    setErr('');
    if (!staff.trim() && !admin.trim()) { setErr('Type a new passcode in at least one box.'); return; }
    setConfirm(true);
  }
  async function save() {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const body = {};
      if (staff.trim()) body.staffPasscode = staff;
      if (admin.trim()) body.adminPasscode = admin;
      await api.put(`/api/games/${game.id}/passcodes`, body);
      setStaff(''); setAdmin(''); setConfirm(false);
      onNotice('Passcodes updated.');
    } catch (e) { setErr(e.message || 'Could not save. Try again.'); setConfirm(false); }
    setBusy(false);
  }

  return (
    <>
      <p className="hub-sub">
        The staff passcode lets people in to play. The admin passcode also opens this Manage screen, so keep it to yourself.
        Leave a box empty to keep that passcode as it is.
      </p>
      <label className="field-label" htmlFor="pc-staff">New staff passcode</label>
      <input id="pc-staff" className="text-input" value={staff} onChange={e => { setStaff(e.target.value); setConfirm(false); }}
        autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} placeholder="At least 4 characters" />
      <label className="field-label" htmlFor="pc-admin">New admin passcode</label>
      <input id="pc-admin" className="text-input" value={admin} onChange={e => { setAdmin(e.target.value); setConfirm(false); }}
        autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} placeholder="At least 6 characters" />
      {err ? <div className="form-error" role="alert">{err}</div> : null}
      {confirm ? (
        <div className="danger-zone open">
          <p className="danger-text">
            Everyone will be signed out and will need the new passcode to get back in. Their points are kept. You stay signed in.
          </p>
          <div className="editor-actions">
            <button className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Change passcodes'}</button>
          </div>
        </div>
      ) : (
        <div className="editor-actions">
          <button className="btn btn-primary" onClick={review}>Save passcodes</button>
        </div>
      )}
    </>
  );
}
