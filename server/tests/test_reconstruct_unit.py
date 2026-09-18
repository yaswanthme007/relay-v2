"""Unit tests for server/reconstruct.py — parsing, validation, candidate
limiting, confidence handling, fallback, and prompt construction. No
network calls: `_call_groq_json` is monkeypatched throughout."""

import json

import pytest

from server import reconstruct
from server.reconstruct import (
    FALLBACK_REASONING,
    MAX_CANDIDATES,
    build_prompt,
    reconstruct as run_reconstruct,
)


def _json_reply(candidates):
    return json.dumps({"candidates": candidates})


async def test_valid_json_response_produces_candidates(monkeypatch):
    calls = []

    async def fake_call(prompt):
        calls.append(prompt)
        return _json_reply([
            {"text": "metformin, five hundred milligrams", "confidence": 0.91, "reasoning": "ledger match"},
            {"text": "metformin, two fifty milligrams", "confidence": 0.4, "reasoning": "alt dosage"},
        ])

    monkeypatch.setattr(reconstruct, "_call_groq_json", fake_call)

    result = await run_reconstruct("met four min five hunred miligrams", ["metformin"], "pharmacy", [])

    assert len(calls) == 1  # no retry needed
    assert len(result) == 2
    assert result[0].text == "metformin, five hundred milligrams"
    assert result[0].confidence == pytest.approx(0.91)
    assert result[0].reasoning == "ledger match"


async def test_confidence_is_clamped_into_range(monkeypatch):
    async def fake_call(prompt):
        return _json_reply([
            {"text": "over one", "confidence": 1.7, "reasoning": "x"},
            {"text": "under one", "confidence": -0.3, "reasoning": "y"},
        ])

    monkeypatch.setattr(reconstruct, "_call_groq_json", fake_call)

    result = await run_reconstruct("t", [], "clinic", [])

    assert result[0].confidence == 1.0
    assert result[1].confidence == 0.0
    for c in result:
        assert 0.0 <= c.confidence <= 1.0


async def test_more_than_three_candidates_is_capped(monkeypatch):
    async def fake_call(prompt):
        return _json_reply([
            {"text": f"option {i}", "confidence": 0.5, "reasoning": "r"} for i in range(6)
        ])

    monkeypatch.setattr(reconstruct, "_call_groq_json", fake_call)

    result = await run_reconstruct("t", [], "home", [])

    assert len(result) == MAX_CANDIDATES == 3
    assert [c.text for c in result] == ["option 0", "option 1", "option 2"]


async def test_malformed_candidates_are_dropped(monkeypatch):
    async def fake_call(prompt):
        return json.dumps({"candidates": [
            {"text": "valid one", "confidence": 0.8, "reasoning": "ok"},
            {"confidence": 0.8, "reasoning": "missing text"},
            {"text": "missing confidence", "reasoning": "no confidence field"},
            {"text": "missing reasoning", "confidence": 0.5},
            {"text": "wrong type confidence", "confidence": "high", "reasoning": "r"},
            {"text": "", "confidence": 0.5, "reasoning": "empty text"},
        ]})

    monkeypatch.setattr(reconstruct, "_call_groq_json", fake_call)

    result = await run_reconstruct("t", [], "phone", [])

    assert len(result) == 1
    assert result[0].text == "valid one"


async def test_prose_response_triggers_one_retry_then_succeeds(monkeypatch):
    calls = []

    async def fake_call(prompt):
        calls.append(prompt)
        if len(calls) == 1:
            return "Sure! I think the patient probably meant metformin."
        return _json_reply([{"text": "metformin", "confidence": 0.9, "reasoning": "retry succeeded"}])

    monkeypatch.setattr(reconstruct, "_call_groq_json", fake_call)

    result = await run_reconstruct("met four min", ["metformin"], "pharmacy", [])

    assert len(calls) == 2
    assert result[0].text == "metformin"
    assert result[0].reasoning == "retry succeeded"


async def test_double_failure_falls_back_to_raw_transcript(monkeypatch):
    calls = []

    async def fake_call(prompt):
        calls.append(prompt)
        return "not json at all"

    monkeypatch.setattr(reconstruct, "_call_groq_json", fake_call)

    result = await run_reconstruct("i nee a refil of met four min", [], "pharmacy", [])

    assert len(calls) == 2  # first attempt + one retry, then give up
    assert len(result) == 1
    assert result[0].text == "i nee a refil of met four min"
    assert result[0].confidence == 0.0
    assert result[0].reasoning == FALLBACK_REASONING


async def test_provider_error_also_retries_then_falls_back(monkeypatch):
    calls = []

    async def fake_call(prompt):
        calls.append(prompt)
        raise reconstruct.ReconstructionError("simulated provider outage")

    monkeypatch.setattr(reconstruct, "_call_groq_json", fake_call)

    result = await run_reconstruct("raw transcript here", [], "home", [])

    assert len(calls) == 2
    assert result[0].confidence == 0.0
    assert result[0].text == "raw transcript here"


def test_prompt_includes_all_context():
    prompt = build_prompt(
        transcript="met four min",
        ledger_terms=["metformin", "Dr. Raghunathan"],
        situation="pharmacy",
        history=["prior turn one", "prior turn two"],
    )
    assert "met four min" in prompt
    assert "metformin" in prompt
    assert "Dr. Raghunathan" in prompt
    assert "pharmacy" in prompt
    assert "prior turn one" in prompt
    assert "prior turn two" in prompt
    assert "constrained inference" not in prompt  # sanity: prompt is the playbook's, not a paraphrase
    assert "Return 2-3 candidates" in prompt


def test_prompt_handles_empty_ledger_and_history():
    prompt = build_prompt("t", [], "home", [])
    assert "(none known)" in prompt
    assert "(none — first turn)" in prompt
