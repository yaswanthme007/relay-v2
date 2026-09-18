"""One real integration verification, per the Phase 3 test
strategy: an actual Groq reconstruction call using the current verified
model and the real API key from .env (never hardcoded, never placed in
this file). Skipped automatically when no key is configured — this file
must be runnable without secrets present.

Also carries the required ledger-aware A/B demonstration: the same noisy
ASR fixture, reconstructed once with the ledger term in context and once
without, to show the known-vocabulary context actually changes the
model's output rather than being decorative."""

import pytest

from server.config import settings
from server.reconstruct import reconstruct

pytestmark = pytest.mark.skipif(
    not settings.GROQ_API_KEY,
    reason="GROQ_API_KEY not configured; skipping real Groq integration test",
)

NOISY_TRANSCRIPT = "i need a refil of met four min five hunred miligrams"


async def test_real_reconstruction_call_returns_valid_candidates():
    result = await reconstruct(
        transcript=NOISY_TRANSCRIPT,
        ledger_terms=["metformin"],
        situation="pharmacy",
        history=[],
    )

    assert len(result) >= 1
    for c in result:
        assert 0.0 <= c.confidence <= 1.0
        assert c.text.strip()
        assert c.reasoning.strip()

    # A real model call succeeding on the first or second attempt should not
    # need the fallback path. If it does, the model/provider is behaving
    # unexpectedly and the test should surface that rather than pass quietly.
    from server.reconstruct import FALLBACK_REASONING
    assert not (len(result) == 1 and result[0].reasoning == FALLBACK_REASONING), (
        "Reconstruction fell back to the raw transcript on a real call — "
        "the model or provider is not behaving as expected."
    )


async def test_ledger_changes_reconstruction_output():
    """RELAY_PLAYBOOK.md §4's required A/B: ASR hears 'met four min' — with
    'metformin' in the ledger, the model should be able to prefer it; the
    difference must come from the supplied context, not from branching in
    application code."""
    fixture_transcript = "met four min"

    with_ledger = await reconstruct(
        transcript=fixture_transcript,
        ledger_terms=["metformin"],
        situation="pharmacy",
        history=[],
    )
    without_ledger = await reconstruct(
        transcript=fixture_transcript,
        ledger_terms=[],
        situation="pharmacy",
        history=[],
    )

    with_top = with_ledger[0].text.lower()
    without_top = without_ledger[0].text.lower()

    # Empirical claim, not a hardcoded expectation: with the ledger term
    # supplied as context, the top candidate should actually contain it.
    assert "metformin" in with_top, (
        f"Expected 'metformin' in top candidate with ledger context, got: {with_ledger[0].text!r}"
    )

    # Report both outcomes for manual disclosure (visible with `pytest -s`).
    print(f"\n[A/B] without ledger -> {without_ledger[0].text!r} (confidence {without_ledger[0].confidence})")
    print(f"[A/B] with ledger    -> {with_ledger[0].text!r} (confidence {with_ledger[0].confidence})")
