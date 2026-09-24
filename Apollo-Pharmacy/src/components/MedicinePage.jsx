import { useEffect, useState } from 'react'
import { getMedicines } from '../api'
import MedicineCatalog from './MedicineCatalog'

export default function MedicinePage() {
  const [medicines, setMedicines] = useState([])
  const [error, setError] = useState('')
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('apollo-theme') === 'dark'
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
    localStorage.setItem('apollo-theme', isDark ? 'dark' : 'light')
  }, [isDark])

  useEffect(() => {
    getMedicines()
      .then((data) => setMedicines(data.map((medicine) => ({ ...medicine, category: medicine.category || 'General Care' }))))
      .catch((loadError) => setError(loadError.message))
  }, [])

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
          <h1 className="text-4xl font-extrabold tracking-tight dark:text-white max-sm:text-3xl">Browse all medicines</h1>
          <p className="mt-3 max-w-2xl text-[#607487] dark:text-slate-300">Search the live Apollo Pharmacy inventory by medicine, generic name, or manufacturer.</p>
        </section>

        {error && <p className="rounded-xl bg-[#fff0ef] p-4 font-semibold text-[#b94f49]">{error}</p>}
        {!error && medicines.length === 0 && <p className="rounded-xl border border-[#d9e7f0] bg-white p-6 text-[#607487] dark:border-slate-700 dark:bg-[#172b3d]">Loading live medicine catalog...</p>}
        {medicines.length > 0 && <MedicineCatalog medicines={medicines} remoteSearch scrollable />}
      </div>
    </main>
  )
}
