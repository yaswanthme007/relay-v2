"""Frontend voice-name -> Rime mistv2 speaker ID mapping.

The frontend's voice picker (web/src/pages/SessionPage.tsx) offers display
names 'Meadow', 'Ember', 'Cove', 'Grove', 'Summit'. Checked against Rime's
live voice catalog (https://users.rime.ai/data/voices/all-v2.json, mistv2
block) at Phase 4 implementation time: 'ember', 'cove', 'grove', and
'summit' are real mistv2 speaker IDs (display name lowercased == speaker
ID) — but 'meadow' is not in the catalog under any model. Do not assume
display name == speaker ID without checking.

Mapped 'Meadow' to 'breeze' (present in the mistv2 catalog, same pastoral/
open-air register as the other four) rather than silently 404ing or
picking something tonally unrelated. Centralized here, not embedded in the
route or the WebSocket client, so the one substitution is visible and easy
to revisit once the frontend's voice names are reconciled with Rime's
catalog for real."""

VOICE_NAME_TO_SPEAKER: dict[str, str] = {
    "Meadow": "breeze",  # not a real mistv2 speaker — substituted, see module docstring
    "Ember": "ember",
    "Cove": "cove",
    "Grove": "grove",
    "Summit": "summit",
}

DEFAULT_SPEAKER = "cove"


def resolve_speaker(voice_name: str) -> str:
    """Voice display name -> real Rime mistv2 speaker ID. Unknown names
    (should not happen given the frontend's fixed picker, but the browser
    is untrusted input) fall back to DEFAULT_SPEAKER rather than sending an
    unverified string straight to Rime."""
    return VOICE_NAME_TO_SPEAKER.get(voice_name, DEFAULT_SPEAKER)
