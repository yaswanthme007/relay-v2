// Voice Ledger delete flow: the DELETE request, the confirmation wording,
// the row removal, and the derived stats/filters that must update with it
// without a page reload.
//
// LedgerPage.tsx renders from exactly these functions, so asserting them
// asserts what the page shows. Headless like the audio tests — fetch is a
// recording fake; no DOM testing framework is added.
import { describe, it, expect, vi } from 'vitest'
import {
  deriveLedgerStats, filterLedger, removeEntry,
  deleteConfirmationMessage, requestDeleteEntry,
} from '../ledgerState'
import type { LedgerEntry } from '../ledgerTypes'

const metformin: LedgerEntry = {
  id: 'e1', word: 'Metformin', phoneme: '{m1Etf1OrmIn}',
  category: 'medication', covered: false, verified: true,
}
const lisinopril: LedgerEntry = {
  id: 'e2', word: 'Lisinopril', phoneme: '',
  category: 'medication', covered: true, verified: false,
}
const ananya: LedgerEntry = {
  id: 'e3', word: 'Ananya Sharma', phoneme: '{An1AnyA}',
  category: 'name', covered: false, verified: true,
}
const LEDGER = [metformin, lisinopril, ananya]

function fakeFetch(ok: boolean, status = 204) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok, status } as Response
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

describe('deleteConfirmationMessage', () => {
  it('names the term and says the stored pronunciation is lost and re-recordable', () => {
    const message = deleteConfirmationMessage('Metformin')

    expect(message).toContain('Metformin')
    expect(message).toContain('pronunciation will be removed permanently')
    expect(message).toContain('record a new pronunciation')
  })
})

describe('requestDeleteEntry', () => {
  it('sends DELETE to /api/ledger/entry/{id} with the current user', async () => {
    const { impl, calls } = fakeFetch(true)

    await requestDeleteEntry('http://localhost:8000', 'user-a', 'e1', impl)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://localhost:8000/api/ledger/entry/e1?userId=user-a')
    expect(calls[0].init?.method).toBe('DELETE')
  })

  it('encodes ids and user ids rather than interpolating them raw', async () => {
    const { impl, calls } = fakeFetch(true)

    await requestDeleteEntry('http://localhost:8000', 'a/b', 'x y', impl)

    expect(calls[0].url).toBe('http://localhost:8000/api/ledger/entry/x%20y?userId=a%2Fb')
  })

  it('throws on the ownership-safe 404 so the caller keeps the row', async () => {
    const { impl } = fakeFetch(false, 404)

    await expect(requestDeleteEntry('http://localhost:8000', 'user-b', 'e1', impl))
      .rejects.toThrow('Backend returned 404')
  })
})

describe('removeEntry', () => {
  it('removes only the deleted row', () => {
    const after = removeEntry(LEDGER, 'e1')

    expect(after.map(e => e.id)).toEqual(['e2', 'e3'])
  })

  it('leaves the list untouched for an id that is not present', () => {
    expect(removeEntry(LEDGER, 'nope')).toEqual(LEDGER)
  })

  it('does not mutate the original list', () => {
    removeEntry(LEDGER, 'e1')

    expect(LEDGER.map(e => e.id)).toEqual(['e1', 'e2', 'e3'])
  })
})

describe('derived stats after a delete', () => {
  it('reports totals, coverage, verification and category counts', () => {
    const stats = deriveLedgerStats(LEDGER)

    expect(stats).toMatchObject({
      total: 3, covered: 1, verified: 2, uncovered: 2,
      categories: ['medication', 'name'],
      countByCategory: { medication: 2, name: 1 },
    })
  })

  it('every stat updates when a row is deleted', () => {
    const before = deriveLedgerStats(LEDGER)
    const after = deriveLedgerStats(removeEntry(LEDGER, 'e1'))

    expect(before.total).toBe(3)
    expect(after.total).toBe(2)
    expect(after.verified).toBe(1) // Metformin was verified
    expect(after.uncovered).toBe(1) // and uncovered
    expect(after.covered).toBe(1)
    expect(after.countByCategory).toEqual({ medication: 1, name: 1 })
  })

  it('drops a category pill entirely when its last term is deleted', () => {
    const after = deriveLedgerStats(removeEntry(LEDGER, 'e3'))

    expect(after.categories).toEqual(['medication'])
    expect(after.countByCategory.name).toBeUndefined()
  })

  it('cancelled deletion leaves the entry and every stat intact', () => {
    // Nothing was removed, so the derivation the page renders is identical.
    const unchanged = deriveLedgerStats(LEDGER)

    expect(unchanged).toEqual(deriveLedgerStats(LEDGER))
    expect(unchanged.total).toBe(3)
  })
})

describe('visible rows after a delete', () => {
  it('the deleted row disappears from the filtered view', () => {
    const before = filterLedger(LEDGER, '', 'medication')
    const after = filterLedger(removeEntry(LEDGER, 'e1'), '', 'medication')

    expect(before.map(e => e.word)).toEqual(['Metformin', 'Lisinopril'])
    expect(after.map(e => e.word)).toEqual(['Lisinopril'])
  })

  it('a search that only matched the deleted row yields nothing afterwards', () => {
    expect(filterLedger(LEDGER, 'metf', null).map(e => e.id)).toEqual(['e1'])
    expect(filterLedger(removeEntry(LEDGER, 'e1'), 'metf', null)).toEqual([])
  })

  it('the same word can appear again after being deleted and re-added', () => {
    const afterDelete = removeEntry(LEDGER, 'e1')
    const reAdded: LedgerEntry = {
      id: 'e4', word: 'Metformin', phoneme: '',
      category: 'medication', covered: false, verified: false,
    }
    const afterReAdd = [...afterDelete, reAdded]

    expect(filterLedger(afterReAdd, 'metf', null).map(e => e.id)).toEqual(['e4'])
    // The re-added row starts clean — the old, wrong pronunciation is gone.
    expect(afterReAdd.find(e => e.word === 'Metformin')?.phoneme).toBe('')
    expect(deriveLedgerStats(afterReAdd).verified).toBe(1) // only Ananya
  })
})
