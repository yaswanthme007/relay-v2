// The LedgerEntry contract, shared between LedgerPage.tsx and the ledger
// state helpers. Same shape LedgerPage has always declared and the same
// shape server/models.py mirrors — moved here only so both
// the page and its testable helpers refer to one declaration instead of
// two copies. No field was added, removed, or retyped.
export type LedgerCategory = 'name' | 'medication' | 'clinician' | 'location' | 'phrase'

export interface LedgerEntry {
  id: string
  word: string
  phoneme: string
  category: LedgerCategory
  covered: boolean
  verified: boolean
}
