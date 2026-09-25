import { useEffect, useState } from 'react'
import { fetchMedicines } from '../api'
import MedicineCatalog from './MedicineCatalog'

export default function MedicinePage() {
  const [medicines, setMedicines] = useState([])
  const [pagination, setPagination] = useState({ page: 1, limit: 24, total: 0, totalPages: 1 })
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('apollo-theme') === 'dark'
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
    localStorage.setItem('apollo-theme', isDark ? 'dark' : 'light')
  }, [isDark])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setIsLoading(true)
      setError('')
      try {
        const { items, pagination: nextPagination } = await fetchMedicines({
          limit: 24,
          page: pagination.page,
          search: submittedSearch,
        })
        if (cancelled) return
        setMedicines(items.map((medicine) => ({ ...medicine, category: medicine.category || 'General Care' })))
        setPagination((current) => ({ ...current, ...nextPagination }))
      } catch (loadError) {
        if (!cancelled) setError(loadError.message)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    queueMicrotask(run)
    return () => {
      cancelled = true
    }
  }, [pagination.page, submittedSearch])

  const submitSearch = (event) => {
    event.preventDefault()
    setPagination((current) => ({ ...current, page: 1 }))
    setSubmittedSearch(search.trim())
  }

  return (
    <main className="min-h-screen bg-[#f4f9fc] px-4 py-6 text-[#172b3d] transition-colors dark:bg-[#101d2b] dark:text-slate-100 sm:px-8">
      <div className="mx-auto w-full max-w-7xl">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#d9e7f0] bg-white/95 p-4 shadow-lg shadow-[#18527f]/10 backdrop-blur dark:border-slate-700 dark:bg-[#172b3d]/95">
          <div className="flex items-center gap-3">
            <img className="h-12 w-12 rounded-full object-contain" src="/logo.jpeg" alt="Apollo Pharmacy logo" />
            <div>
              <div className="text-lg font-extrabold dark:text-white">Apollo Pharmacy</div>
              <div className="text-xs text-[#607487] dark:text-slate-300">Live medicine catalog</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a href="/" className="rounded-xl border border-[#d9e7f0] px-4 py-2 text-sm font-bold text-[#18527f] transition hover:bg-[#e7f4fc] dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700">Back home</a>
            <button
              type="button"
              onClick={() => setIsDark((current) => !current)}
              className="rounded-xl border border-[#d9e7f0] bg-white px-3 py-2 text-lg shadow-sm transition hover:bg-[#e7f4fc] dark:border-slate-600 dark:bg-slate-800 dark:hover:bg-slate-700"
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? '☀️' : '🌙'}
            </button>
          </div>
        </header>

        <section className="py-12">
          <p className="mb-2 text-xs font-bold uppercase tracking-[.12em] text-[#2f80c0]">Medicine catalog</p>
          <h1 className="text-4xl font-extrabold tracking-tight dark:text-white max-sm:text-3xl">Browse medicines</h1>
          <p className="mt-3 max-w-2xl text-[#607487] dark:text-slate-300">
            Server-side search across the live inventory
            {pagination.total ? ` (${pagination.total.toLocaleString()} medicines)` : ''}.
          </p>
          <form onSubmit={submitSearch} className="mt-6 flex max-w-xl gap-2">
            <input
              className="min-w-0 flex-1 rounded-xl border border-[#d9e7f0] bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search brand, generic, manufacturer, or strength"
            />
            <button type="submit" className="rounded-xl bg-[#2f80c0] px-5 py-3 font-bold text-white hover:bg-[#18527f]">Search</button>
          </form>
        </section>

        {error && <p className="rounded-xl bg-[#fff0ef] p-4 font-semibold text-[#b94f49]">{error}</p>}
        {isLoading && <p className="rounded-xl border border-[#d9e7f0] bg-white p-6 text-[#607487] dark:border-slate-700 dark:bg-[#172b3d]">Loading medicines…</p>}
        {!isLoading && !error && medicines.length === 0 && (
          <p className="rounded-xl border border-[#d9e7f0] bg-white p-6 text-[#607487] dark:border-slate-700 dark:bg-[#172b3d]">No medicines matched this search.</p>
        )}
        {!isLoading && medicines.length > 0 && <MedicineCatalog medicines={medicines} remoteSearch scrollable />}

        {!isLoading && pagination.totalPages > 1 && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-[#607487]">
              Page {pagination.page} of {pagination.totalPages}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={pagination.page <= 1}
                onClick={() => setPagination((current) => ({ ...current, page: Math.max(1, current.page - 1) }))}
                className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-2 text-sm font-bold disabled:opacity-40 dark:border-slate-600 dark:bg-[#172b3d]"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => setPagination((current) => ({ ...current, page: Math.min(current.totalPages, current.page + 1) }))}
                className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-2 text-sm font-bold disabled:opacity-40 dark:border-slate-600 dark:bg-[#172b3d]"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
