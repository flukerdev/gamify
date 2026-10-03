import React, { useState } from 'react';
import { memberLink } from '../link.js';

// Build the magic invite link. The route `/?invite=CODE` is read by App.jsx on
// load and short-circuits the friend straight into the name+phone screen.
// Photo games (protected) use /?k=CODE instead: tap it, type your name, in.
export function buildInviteLink(gameOrCode) {
  const shareCode = typeof gameOrCode === 'string' ? gameOrCode : gameOrCode.share_code;
  if (typeof gameOrCode !== 'string' && gameOrCode.protected) return memberLink(shareCode);
  if (typeof window === 'undefined') return `/?invite=${shareCode}`;
  const u = new URL(window.location.origin);
  u.searchParams.set('invite', shareCode);
  return u.toString();
}

export default function InviteFriends({ game, compact = false }) {
  const [copied, setCopied] = useState(false);
  const link = buildInviteLink(game);
  const isFaces = game.kind === 'faces';

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Fallback: select the input and let the user copy manually.
    }
  }

  function share() {
    if (navigator.share) {
      navigator.share({
        title: isFaces ? game.title : `Join ${game.title} on Gamify`,
        text: isFaces
          ? `${game.title}: tap the link, type your name, and start learning names.`
          : `Join my Gamify game "${game.title}".`,
        url: link,
      }).catch(() => {});
    } else {
      copy();
    }
  }

  return (
    <div className={`invite-card ${compact ? 'compact' : ''}`}>
      <h3 className="invite-title">{isFaces ? 'Invite link' : 'Invite friends'}</h3>
      <div className="invite-link-row">
        <input className="text-input invite-link-input" readOnly value={link}
          onFocus={(e) => e.target.select()} />
        <button className="btn btn-primary" onClick={copy}>{copied ? 'Copied!' : 'Copy link'}</button>
      </div>
      {typeof navigator !== 'undefined' && navigator.share ? (
        <button className="btn btn-secondary invite-share" onClick={share}>Share…</button>
      ) : null}
      {game.protected ? (
        <div className="invite-code-line">
          Anyone with this link can get in, so only send it to people who should see the students.
        </div>
      ) : (
        <div className="invite-code-line">
          Or share the code: <b>{game.share_code}</b>
        </div>
      )}
    </div>
  );
}
