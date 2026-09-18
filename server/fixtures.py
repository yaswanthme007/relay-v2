"""Phase 3 static ledger fixture. Reconstruction needs *some* known-vocabulary
list to demonstrate constrained inference; the real per-user pronunciation
ledger (SQLite, Coverage/Phonemize APIs) is Phase 5. This fixture will be
replaced there, not extended here.

Terms match the synthetic persona already established by docs/persona.md
and web/src/pages/LedgerPage.tsx's mock data — same invented person, no new
vocabulary invented for this phase."""

DEMO_LEDGER_TERMS: list[str] = [
    "Ananya Sharma",
    "Dr. Raghunathan",
    "Dr. Mukherjee",
    "metformin",
    "levothyroxine",
    "atorvastatin",
    "salbutamol",
    "hydrochlorothiazide",
    "Maple Street Pharmacy",
    "repeat prescription",
    "sixty-day supply",
]
