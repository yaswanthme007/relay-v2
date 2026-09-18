"""AT-1 — Deterministic pronunciation of personal vocabulary (Phase 8).

Claim under test (RIME_EVIDENCE.md, committed before this script existed):
    "For a 20-item personal vocabulary fixture, the ledger raises correct
    pronunciation from baseline to >=85%."

Reuses server/ledger.py directly — no duplicated Coverage API, Phonemize
normalization, or injection logic (Phase 8 prompt §4 is explicit that this
is mandatory):
    - check_coverage()        real Rime Coverage (OOV) API
    - normalize_phoneme()     the exact brace-wrapping the product uses
    - inject_pronunciations() the exact regex/word-boundary substitution
                              server/session_ws.py uses at synthesis time

Also reuses server/rime_ws.py's RimeSpeechClient for synthesis (same
modelId="mistv2" guarantee, same speaker resolution) and server/asr.py's
transcribe() for the automated re-recognition proxy described below — no
Rime/Groq call is reimplemented here.

Run (from the repo root, with RIME_API_KEY/GROQ_API_KEY set in .env):
    python evidence/at1_pronunciation.py

Disclosed, honest departures from the committed claim (do not silently
resolve — reported in the Phase 8 final report too):

1. FIXTURE SIZE. The claim says 20 items. The actual repo fixture
   (evidence/fixtures/vocabulary.json) has 12. This script uses the real
   fixture as-is (Phase 8 prompt §5: "do not silently replace... with a
   more favorable list") and reports the discrepancy rather than editing
   either the claim or the fixture.

2. PHONEME SOURCE. The primary path (RELAY_PLAYBOOK.md §3, Phase 5) is: record a human saying the term correctly -> Phonemize API
   -> verified phoneme. This execution environment has no microphone and
   no human present to record a reference pronunciation (same disclosed
   limitation as Phase 7's browser/mic testing). RELAY_PLAYBOOK.md §10's
   own pre-approved fallback for exactly this situation: "hand-write
   phoneme strings from Rime's alphabet reference for 8 high-value terms
   and reduce the AT-1 fixture from 20 items to 8." This script takes that
   documented fallback for the pronunciation-improvement subset (8 of the
   12 real fixture terms — the proper nouns/medications most likely to be
   mispronounced), hand-authored against Rime's published phoneme alphabet
   (docs.rime.ai/platform/rime-phonetic-alphabet), and says so plainly in
   every result row. Only server/ledger.py's phonemize() (the real audio
   round trip) is unused; check_coverage() and inject_pronunciations() are
   the real calls throughout, and metformin's phoneme string is the same
   one already verified real in RIME_EVIDENCE.md's Phase 0 mechanism check
   (not re-derived here).

3. BLIND HUMAN LISTENERS. The claim's scoring method is 3 blind human
   listeners. No human panel exists in this non-interactive execution
   environment. Rather than fabricate scores (explicitly prohibited —
   Phase 8 prompt §11/§13), this script leaves human_score_before/after as
   NOT_COLLECTED and instead runs an objective, disclosed, automated proxy:
   each clip is fed back through the real Groq Whisper ASR (server/asr.py)
   and checked for whether the target term is recognizable in the
   transcript. This is not a substitute for human blind scoring and is
   labeled as a proxy throughout, not as "the AT-1 result."
"""

import asyncio
import base64
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from server.asr import ASRError, transcribe  # noqa: E402
from server.ledger import check_coverage, inject_pronunciations, normalize_phoneme  # noqa: E402
from server.models import LedgerEntry  # noqa: E402
from server.rime_ws import RimeSpeechClient, RimeStreamError  # noqa: E402
from server.voices import DEFAULT_SPEAKER  # noqa: E402

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "vocabulary.json"
CLIPS_BEFORE = Path(__file__).parent / "clips" / "at1" / "before"
CLIPS_AFTER = Path(__file__).parent / "clips" / "at1" / "after"
RESULTS_CSV = Path(__file__).parent / "results" / "at1_results.csv"

CARRIER_TEMPLATE = "The next word is {term}."  # held constant across every term/condition

# Hand-authored phoneme strings (Phase 8 prompt disclosure #2 above) using
# Rime's published alphabet (vowels @ a A W x Y E R e I i o O U u N; stress
# digits 1=primary 2=secondary 0=unstressed, before the vowel they attach
# to). "metformin" is the one exception: it is the literal string already
# verified real against live Rime in RIME_EVIDENCE.md's Phase 0 mechanism
# check, not re-derived by hand here.
HAND_AUTHORED_PHONEMES = {
    "metformin": "m1Etf1OrmIn",  # Phase 0-verified real Rime output, reused verbatim
    "ananya sharma": "0xn1any0x S1arm0x",
    "dr. raghunathan": "d1akt0R r0ag0Un1aT0xn",
    "dr. mukherjee": "d1akt0R m0Uk0RJ1i",
    "levothyroxine": "l2iv0oT0Yr1aks0In",
    "atorvastatin": "0xt1Rv0xst1@t0In",
    "hydrochlorothiazide": "h2Ydr0okl0R0oT1Y0xz2Yd",
    "salbutamol": "s0@lby1ut0xm0al",
}


def slugify(term: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", term.lower()).strip("_")


def normalize_for_match(text: str) -> str:
    return re.sub(r"[^a-z]", "", text.lower())


async def synthesize(client: RimeSpeechClient, text: str) -> bytes:
    """Real Rime ws3 synthesis via the production client — modelId=mistv2
    and the given speaker are guaranteed by RimeSpeechClient itself
    (server/rime_ws.py), never re-specified/duplicated here.

    Retries once on a fresh connection if send fails: Rime closes its own
    end of the ws3 socket once a context finishes, and a rapid-fire second
    speak() on the same reused connection can occasionally lose that race
    (close_code not yet updated when connect()'s reuse check runs) — the
    same real race server/session_ws.py's ensure_client() retries around
    (found via Phase 8 real evidence testing, not hypothetical)."""
    try:
        await client.speak(text)
    except RimeStreamError:
        await client.close()
        await client.connect()
        await client.speak(text)

    chunks: list[bytes] = []
    async for event in client.events():
        if event["type"] == "chunk":
            chunks.append(event["data"])
        elif event["type"] == "done":
            break
        elif event["type"] == "error":
            raise RimeStreamError(event["message"])
    return b"".join(chunks)


async def asr_recognizes_term(audio_bytes: bytes, term: str) -> tuple[str, bool]:
    """Real Groq Whisper call (server/asr.py, unmodified) as an objective,
    automated re-recognition proxy — NOT a substitute for human blind
    listening (disclosure #3 above)."""
    try:
        transcript = await transcribe(audio_bytes, content_type="audio/mp3", filename="clip.mp3")
    except ASRError as e:
        return f"ASR_ERROR: {e}", False
    target = normalize_for_match(term.replace("Dr. ", ""))
    heard = normalize_for_match(transcript)
    return transcript, target in heard


async def main() -> None:
    if not FIXTURE_PATH.exists():
        raise SystemExit(f"Fixture not found: {FIXTURE_PATH}")
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    committed_claim_size = 20
    actual_fixture_size = len(fixture)
    if actual_fixture_size != committed_claim_size:
        print(
            f"[DISCLOSURE] RIME_EVIDENCE.md's AT-1 claim specifies a "
            f"{committed_claim_size}-item fixture; the actual repo fixture "
            f"({FIXTURE_PATH}) has {actual_fixture_size} items. Running "
            f"against the real fixture as-is, not editing either.",
            file=sys.stderr,
        )

    CLIPS_BEFORE.mkdir(parents=True, exist_ok=True)
    CLIPS_AFTER.mkdir(parents=True, exist_ok=True)
    RESULTS_CSV.parent.mkdir(parents=True, exist_ok=True)

    rows = []

    # ---- Coverage sweep: every real fixture term, real Rime Coverage API ----
    print(f"Running real Rime Coverage checks for all {actual_fixture_size} fixture terms...")
    coverage: dict[str, bool] = {}
    for item in fixture:
        term = item["word"]
        covered = await check_coverage(term)
        coverage[term] = covered
        print(f"  covered={covered!s:5}  {term}")

    # ---- Pronunciation subset: hand-authored-phoneme fallback (disclosure #2) ----
    subset_terms = [item for item in fixture if item["word"].lower() in HAND_AUTHORED_PHONEMES]
    print(
        f"\nPronunciation subset (hand-authored-phoneme fallback, "
        f"RELAY_PLAYBOOK.md §10 risk #4): {len(subset_terms)} of "
        f"{actual_fixture_size} fixture terms."
    )
    if len(subset_terms) != 8:
        print(
            f"[DISCLOSURE] Expected an 8-term reduced subset per the "
            f"documented fallback; matched {len(subset_terms)} terms "
            f"against the current fixture.",
            file=sys.stderr,
        )

    client = RimeSpeechClient(speaker=DEFAULT_SPEAKER)
    try:
        for item in subset_terms:
            term = item["word"]
            category = item["category"]
            slug = slugify(term)
            raw_phoneme = HAND_AUTHORED_PHONEMES[term.lower()]
            phoneme = normalize_phoneme(raw_phoneme)  # real production function
            phoneme_source = "phase0_verified_real" if term.lower() == "metformin" else "hand_authored_from_rime_alphabet_docs"

            carrier = CARRIER_TEMPLATE.format(term=term)
            # Real production injection function — not a manual string
            # replace — exercised against a synthetic LedgerEntry standing
            # in for "a verified ledger entry with this phoneme".
            fake_entry = LedgerEntry(
                id=f"at1-{slug}", word=term, phoneme=phoneme,
                category=category, covered=coverage[term], verified=True,
            )
            treatment_text = inject_pronunciations(carrier, [fake_entry])

            print(f"\nSynthesizing '{term}' (before/after)...")
            before_bytes = await synthesize(client, carrier)
            before_path = CLIPS_BEFORE / f"{slug}.mp3"
            before_path.write_bytes(before_bytes)

            after_bytes = await synthesize(client, treatment_text)
            after_path = CLIPS_AFTER / f"{slug}.mp3"
            after_path.write_bytes(after_bytes)

            print("  Running ASR re-recognition proxy on both clips...")
            before_transcript, before_correct = await asr_recognizes_term(before_bytes, term)
            after_transcript, after_correct = await asr_recognizes_term(after_bytes, term)
            print(f"  before: correct={before_correct}  transcript={before_transcript!r}")
            print(f"  after:  correct={after_correct}  transcript={after_transcript!r}")

            rows.append({
                "term": term,
                "category": category,
                "covered": coverage[term],
                "in_pronunciation_subset": True,
                "phoneme_source": phoneme_source,
                "phoneme": phoneme,
                "carrier_sentence": carrier,
                "before_clip": str(before_path.relative_to(Path(__file__).parent)),
                "after_clip": str(after_path.relative_to(Path(__file__).parent)),
                "asr_proxy_before_transcript": before_transcript,
                "asr_proxy_before_correct": before_correct,
                "asr_proxy_after_transcript": after_transcript,
                "asr_proxy_after_correct": after_correct,
                "human_score_before": "NOT_COLLECTED",
                "human_score_after": "NOT_COLLECTED",
                "delta_asr_proxy": int(after_correct) - int(before_correct),
            })
    finally:
        await client.close()

    # ---- Terms outside the pronunciation subset: coverage-only rows ----
    for item in fixture:
        if item["word"].lower() in HAND_AUTHORED_PHONEMES:
            continue
        rows.append({
            "term": item["word"],
            "category": item["category"],
            "covered": coverage[item["word"]],
            "in_pronunciation_subset": False,
            "phoneme_source": "n/a",
            "phoneme": "",
            "carrier_sentence": "",
            "before_clip": "",
            "after_clip": "",
            "asr_proxy_before_transcript": "",
            "asr_proxy_before_correct": "",
            "asr_proxy_after_transcript": "",
            "asr_proxy_after_correct": "",
            "human_score_before": "NOT_COLLECTED",
            "human_score_after": "NOT_COLLECTED",
            "delta_asr_proxy": "",
        })

    write_csv(rows)
    print_summary(rows, actual_fixture_size, committed_claim_size)


def write_csv(rows: list[dict]) -> None:
    import csv
    fieldnames = list(rows[0].keys())
    with open(RESULTS_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"\nWrote {len(rows)} rows to {RESULTS_CSV}")


def print_summary(rows: list[dict], actual_fixture_size: int, committed_claim_size: int) -> None:
    subset = [r for r in rows if r["in_pronunciation_subset"]]
    baseline_correct = [r for r in subset if r["asr_proxy_before_correct"] is True]
    improved = [r for r in subset if r["asr_proxy_before_correct"] is False and r["asr_proxy_after_correct"] is True]
    still_wrong = [r for r in subset if r["asr_proxy_after_correct"] is False]

    print("\n" + "=" * 70)
    print("AT-1 SUMMARY (automated ASR re-recognition proxy — NOT human blind scoring)")
    print("=" * 70)
    print(f"Committed claim fixture size: {committed_claim_size}")
    print(f"Actual repo fixture size:     {actual_fixture_size}")
    print(f"Pronunciation subset size:    {len(subset)} (hand-authored-phoneme fallback)")
    print(f"Baseline-already-correct (proxy): {len(baseline_correct)}/{len(subset)} — NOT counted as wins")
    print(f"Improved by custom pronunciation (proxy): {len(improved)}/{len(subset)}")
    print(f"Still incorrect after treatment (proxy): {len(still_wrong)}/{len(subset)} — honest losses")
    print("Human blind-listener scores: NOT_COLLECTED (no human panel in this environment)")


if __name__ == "__main__":
    asyncio.run(main())
