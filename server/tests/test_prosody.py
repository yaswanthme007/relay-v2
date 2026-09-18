"""Unit tests for server/prosody.py — exact threshold boundaries, the three
delivery-mode transformations, and defensive confidence handling. Pure
functions, no network, no FastAPI."""

import pytest

from server.prosody import PAUSE_MARKER, apply_prosody, decide_delivery


# ─── exact boundary routing (Phase 6) ──────────────────────────────────────

@pytest.mark.parametrize("confidence,expected", [
    (1.00, "statement"),
    (0.86, "statement"),
    (0.85, "question"),   # exact high boundary — mandatory test
    (0.60, "question"),
    (0.50, "question"),   # exact low boundary
    (0.49, "silent"),
    (0.00, "silent"),
])
def test_decide_delivery_exact_boundaries(confidence, expected):
    assert decide_delivery(confidence) == expected


def test_boundaries_do_not_use_wrong_comparison_operators():
    # >= 0.85 would wrongly make 0.85 a statement; > 0.50 would wrongly make
    # 0.50 silent. Both are explicitly forbidden.
    assert decide_delivery(0.85) != "statement"
    assert decide_delivery(0.50) != "silent"


# ─── statement ──────────────────────────────────────────────────────────────

def test_statement_leaves_text_completely_unchanged():
    text = "I need a refill of metformin, five hundred milligrams."
    result = apply_prosody(text, 0.92)
    assert result.mode == "statement"
    assert result.text == text
    assert result.should_speak is True


def test_statement_at_exact_upper_edge_1_0():
    result = apply_prosody("anything", 1.0)
    assert result.mode == "statement"


# ─── question ───────────────────────────────────────────────────────────────

def test_question_contains_pause_marker_and_question_mark():
    result = apply_prosody("Metformin, two fifty milligrams.", 0.6)
    assert result.mode == "question"
    assert result.should_speak is True
    assert PAUSE_MARKER in result.text
    assert result.text.endswith("?")


def test_question_does_not_corrupt_original_wording():
    result = apply_prosody("Metformin, two fifty milligrams.", 0.6)
    # Original words survive verbatim; only pause marker + terminal
    # punctuation were added/changed.
    assert "Metformin, two fifty milligrams" in result.text


def test_question_does_not_double_up_terminal_punctuation():
    result = apply_prosody("Is this correct?", 0.6)
    assert result.text.count("?") == 1


def test_question_at_each_boundary_in_range():
    for confidence in (0.5, 0.6, 0.85):
        result = apply_prosody("some candidate text", confidence)
        assert result.mode == "question"
        assert result.text.startswith(PAUSE_MARKER)


# ─── silent ─────────────────────────────────────────────────────────────────

def test_silent_should_speak_is_false():
    result = apply_prosody("Unclear low-confidence guess.", 0.2)
    assert result.mode == "silent"
    assert result.should_speak is False


def test_silent_at_zero_confidence():
    result = apply_prosody("anything", 0.0)
    assert result.should_speak is False


def test_silent_does_not_transform_text():
    # Not that it matters for playback (should_speak is False), but the
    # text field should still reflect the original, not a mangled version.
    text = "Unclear low-confidence guess."
    result = apply_prosody(text, 0.2)
    assert result.text == text


# ─── defensive confidence handling ──────────────────────────────────────────

def test_out_of_range_confidence_above_one_is_still_a_statement():
    # Candidate already constrains 0.0-1.0 at the Pydantic layer; prosody
    # itself doesn't invent a fourth threshold band for out-of-range input.
    assert decide_delivery(1.5) == "statement"


def test_out_of_range_confidence_below_zero_is_still_silent():
    assert decide_delivery(-0.1) == "silent"
