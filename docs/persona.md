# Persona disclosure

Every person, prescription, clinician, and location referenced in this project is **invented**. None of it describes a real individual.

## What is synthetic

- **Ananya Sharma** — the demo user. A fictional name, not a real patient.
- **Dr. Raghunathan**, **Dr. Mukherjee** — fictional clinicians.
- Prescriptions (`metformin`, `levothyroxine`, `atorvastatin`, `salbutamol`, `hydrochlorothiazide`) — real drug names used in a fabricated scenario. No real prescription, dosage, or medical history is attached to them.
- **Maple Street Pharmacy** and any other location/context detail — invented.
- The personal pronunciation ledger vocabulary (`evidence/fixtures/vocabulary.json`, once created) is a synthetic fixture built for testing, not derived from any real person's speech or records.

## What this project does not use

- No real patient data, in any form.
- No clinical audio recordings. Any dysarthric speech used for testing is a teammate simulating impaired articulation, disclosed as such wherever it appears — never a clinical dataset (e.g. TORGO, UASpeech), which would require licensing this project does not have.
- No claim of clinical validation. Synthetic speech and a fabricated persona demonstrate the mechanism; they are not evidence the system works for real patients or in a real clinical setting.

## Why this matters

The product's subject matter — prescriptions, clinicians, a pharmacy visit — reads as healthcare data. It is not. Anyone reviewing this repo, the evidence artifacts, or the demo recording should be able to confirm from this file alone that everything resembling personal health information here was made up for the purpose of testing and demonstration.
