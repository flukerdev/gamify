// Thin fetch wrapper. The signed session token is sent as X-Session.

import { getToken, setToken, logout } from './auth.js';

function authHeaders() {
  const token = getToken();
  return token ? { 'X-Session': token } : {};
}

// The server answers 401 when the session is missing, stale, or was issued
// under passcodes that have since changed. Signing out drops the person on
// the sign-in screen instead of leaving every tab showing an error.
// Only when the rejected token is still the current one: a slow request sent
// with an older token (say, a leaderboard poll that was in flight while the
// admin changed passcodes) must not wipe the fresh session.
function handleUnauthorized(res, tokenUsed) {
  if (res.status === 401 && tokenUsed && getToken() === tokenUsed) logout();
}

async function request(method, path, body) {
  const tokenUsed = getToken();
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error('No connection. Check your internet and try again.');
    err.status = 0;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    handleUnauthorized(res, tokenUsed);
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status; err.data = data;
    throw err;
  }
  if (data && typeof data.token === 'string') setToken(data.token);
  return data;
}

// Binary GET (card photos). Returns a Blob.
async function getBlob(path) {
  const tokenUsed = getToken();
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) {
    handleUnauthorized(res, tokenUsed);
    const err = new Error(`Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

export const api = {
  get:  (p)    => request('GET',  p),
  post: (p, b) => request('POST', p, b),
  put:  (p, b) => request('PUT',  p, b),
  del:  (p)    => request('DELETE', p),
  getBlob,
};
