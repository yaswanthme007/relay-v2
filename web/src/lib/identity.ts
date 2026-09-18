// Shared anonymous user identity (no login system — deliberately not
// invented). Extracted from SessionPage.tsx in Phase 5 so LedgerPage.tsx uses
// the exact same id: the ledger and the reconstruction/TTS paths must agree
// on who "the current user" is, or ledger entries and reconstruction
// context would silently belong to different identities.
export function getOrCreateUserId(): string {
  const key = 'relay-user-id'
  let id = localStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(key, id)
  }
  return id
}

// The session's persistent voice. Lives here alongside the user id for the
// same reason: the Ledger page's pronunciation preview must be spoken in
// the *same* Rime voice the Session page relays in, or a preview would be
// auditioning a pronunciation the user will never actually hear. The
// Session page's existing voice picker is still the only control that sets
// it — nothing new was added to the Ledger page (it reads this value and
// never writes it).
//
// This is a display name ('Meadow', 'Ember', ...), not a Rime speaker ID.
// server/voices.py owns that mapping and is the only place it happens —
// display name is deliberately NOT assumed to equal the speaker ID
// checked against Rime's live catalog rather than assumed.
const VOICE_KEY = 'relay-voice-name'

// Matches SessionPage's original default exactly, so a browser that has
// never opened the Session page previews in the voice it would relay in.
export const DEFAULT_VOICE_NAME = 'Meadow'

export function getVoiceName(): string {
  try {
    return localStorage.getItem(VOICE_KEY) || DEFAULT_VOICE_NAME
  } catch {
    return DEFAULT_VOICE_NAME
  }
}

export function setPersistedVoiceName(voiceName: string): void {
  try {
    localStorage.setItem(VOICE_KEY, voiceName)
  } catch {
    // Private-mode / storage-disabled: the picker still works for this
    // page's lifetime, the preview just falls back to the default voice.
  }
}
