// Ledger list state: the one place the page's derived numbers and its
// delete request are defined.
//
// Extracted from LedgerPage.tsx so the delete flow — request, ownership
// failure, row removal, and the stats/filters that must update with it —
// is exercisable in the existing Vitest setup without a DOM testing
// framework, the same way the audio modules are. The page keeps rendering
// from exactly these derived values; nothing maintains a second counter.
import type { LedgerCategory, LedgerEntry } from './ledgerTypes'

export interface LedgerStats {
  total: number
  covered: number
  verified: number
  uncovered: number
  /** Categories actually present, in first-seen order — drives the filter
   * pills, so a category disappears as soon as its last term is deleted. */
  categories: LedgerCategory[]
  countByCategory: Record<string, number>
}

export function deriveLedgerStats(entries: LedgerEntry[]): LedgerStats {
  const covered = entries.filter(e => e.covered).length
  const countByCategory: Record<string, number> = {}
  const categories: LedgerCategory[] = []
  for (const entry of entries) {
    if (!(entry.category in countByCategory)) {
      countByCategory[entry.category] = 0
      categories.push(entry.category)
    }
    countByCategory[entry.category] += 1
  }
  return {
    total: entries.length,
    covered,
    verified: entries.filter(e => e.verified).length,
    uncovered: entries.length - covered,
    categories,
    countByCategory,
  }
}

export function filterLedger(
  entries: LedgerEntry[],
  searchQuery: string,
  activeCategory: string | null,
): LedgerEntry[] {
  const needle = searchQuery.toLowerCase()
  return entries.filter(entry => {
    const matchesSearch = entry.word.toLowerCase().includes(needle)
    const matchesCat = activeCategory ? entry.category === activeCategory : true
    return matchesSearch && matchesCat
  })
}

export function removeEntry(entries: LedgerEntry[], entryId: string): LedgerEntry[] {
  return entries.filter(e => e.id !== entryId)
}

/** The confirmation shown before a delete. Spelled out here (rather than
 * inline at the call site) so the wording — which has to make the loss of
 * the stored pronunciation explicit — is asserted by a test. */
export function deleteConfirmationMessage(word: string): string {
  return (
    `Delete "${word}" from your ledger?\n\n` +
    'Its stored custom pronunciation will be removed permanently. ' +
    'You can add the word again and record a new pronunciation for it.'
  )
}

/** DELETE /api/ledger/entry/{id}. Ownership is enforced server-side — an
 * id belonging to another user comes back 404, exactly like a missing one,
 * and this throws rather than removing anything locally. */
export async function requestDeleteEntry(
  apiBase: string,
  userId: string,
  entryId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    `${apiBase}/api/ledger/entry/${encodeURIComponent(entryId)}?userId=${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  )
  if (!res.ok) throw new Error(`Backend returned ${res.status}`)
}
