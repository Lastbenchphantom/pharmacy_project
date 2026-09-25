import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchMedicines,
  getDashboard,
  getExpiringStock,
  getLowStock,
  getMedicines,
  loginAdmin,
  sendExpiryAlertEmail,
  syncMedicines,
} from '../api'
import DashboardStats from './DashboardStats'
import LowStockTable from './LowStockTable'
import ExpiringStockTable from './ExpiringStockTable'
import MedicineFormModal from './MedicineFormModal'
import StockAdjustPanel from './StockAdjustPanel'
import PushOptIn from './PushOptIn'

const TOKEN_KEY = 'apollo-admin-token'
const MEDICINE_PAGE_SIZE = 25

function AdminLogin({ onLogin }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    setIsLoading(true)
    setError('')
    try {
      const result = await loginAdmin(password)
      localStorage.setItem(TOKEN_KEY, result.token)
      onLogin(result.token)
    } catch (loginError) {
      setError(loginError.message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#f4f9fc] px-4 py-8 text-[#172b3d] dark:bg-[#101d2b] dark:text-white">
      <form onSubmit={handleSubmit} className="w-full max-w-md rounded-3xl border border-[#d9e7f0] bg-white p-8 shadow-2xl dark:border-slate-700 dark:bg-[#172b3d]">
        <a href="/" className="text-sm font-bold text-[#2f80c0]">← Back to pharmacy</a>
        <p className="mt-8 text-xs font-bold uppercase tracking-[.12em] text-[#2f80c0]">Staff portal</p>
        <h1 className="mt-2 text-4xl font-extrabold">Admin sign in</h1>
        <p className="mt-3 text-[#607487] dark:text-slate-300">Control stock, expiry, and receipt imports.</p>
        <label className="mt-8 block text-sm font-bold" htmlFor="admin-password">Admin password</label>
        <input
          id="admin-password"
          className="mt-2 w-full rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-4 py-3 outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoComplete="current-password"
        />
        <button className="mt-5 w-full rounded-xl bg-[#2f80c0] px-5 py-3 font-bold text-white hover:bg-[#18527f] disabled:opacity-60" disabled={isLoading}>
          {isLoading ? 'Signing in...' : 'Sign in securely'}
        </button>
        {error && <p className="mt-4 rounded-xl bg-[#fff0ef] p-3 text-sm font-semibold text-[#b94f49]">{error}</p>}
      </form>
    </main>
  )
}

function AdminDashboard({ token, onLogout }) {
  const [stats, setStats] = useState(null)
  const [lowStock, setLowStock] = useState([])
  const [expiring, setExpiring] = useState([])
  const [medicines, setMedicines] = useState([])
  const [medicinePagination, setMedicinePagination] = useState({ page: 1, total: 0, totalPages: 1, limit: MEDICINE_PAGE_SIZE })
  const [medicineSearch, setMedicineSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [medicinesLoading, setMedicinesLoading] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [dashboardLoading, setDashboardLoading] = useState(true)
  const [alertsLoading, setAlertsLoading] = useState(true)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [medicineModal, setMedicineModal] = useState(null)
  const [adjustTarget, setAdjustTarget] = useState(null)
  const medicineRequestId = useRef(0)

  const showSuccess = (text) => {
    setSuccess(text)
    setError('')
  }
  const showError = (text) => {
    setError(text)
    setSuccess('')
  }

  const refreshAlerts = useCallback(async () => {
    setDashboardLoading(true)
    setAlertsLoading(true)
    const [dashboardResult, lowResult, expiringResult] = await Promise.allSettled([
      getDashboard(token),
      getLowStock(token, { limit: 20 }),
      getExpiringStock(token, { includeExpired: true, limit: 20 }),
    ])
    if (dashboardResult.status === 'fulfilled') setStats(dashboardResult.value)
    else if (dashboardResult.reason?.message) showError(dashboardResult.reason.message)
    if (lowResult.status === 'fulfilled') setLowStock(lowResult.value)
    else if (lowResult.reason?.message) showError(lowResult.reason.message)
    if (expiringResult.status === 'fulfilled') setExpiring(expiringResult.value)
    else if (expiringResult.reason?.message) showError(expiringResult.reason.message)
    const authFail = [dashboardResult, lowResult, expiringResult].find((result) => {
      const message = result.reason?.message || ''
      return result.status === 'rejected' && (message.includes('session') || message.includes('login'))
    })
    if (authFail) onLogout()
    setDashboardLoading(false)
    setAlertsLoading(false)
  }, [token, onLogout])

  const searchCatalog = useCallback(async (search, page = 1) => {
    const requestId = ++medicineRequestId.current
    setMedicinesLoading(true)
    try {
      const { items, pagination } = await fetchMedicines({ limit: MEDICINE_PAGE_SIZE, page, search })
      if (requestId !== medicineRequestId.current) return
      setMedicines(items)
      setMedicinePagination(pagination)
    } finally {
      if (requestId === medicineRequestId.current) setMedicinesLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      const [alertsResult, medicineResult] = await Promise.allSettled([
        refreshAlerts(),
        fetchMedicines({ limit: MEDICINE_PAGE_SIZE, page: 1 }),
      ])
      if (cancelled) return
      if (medicineResult.status === 'fulfilled') {
        setMedicines(medicineResult.value.items)
        setMedicinePagination(medicineResult.value.pagination)
      } else if (medicineResult.status === 'rejected') {
        const message = medicineResult.reason?.message || 'Failed to load medicines'
        if (message.includes('session') || message.includes('login')) onLogout()
        else showError(message)
      }
      if (alertsResult.status === 'rejected') {
        const message = alertsResult.reason?.message || 'Failed to load admin alerts'
        if (message.includes('session') || message.includes('login')) onLogout()
      }
      setIsLoading(false)
    }
    queueMicrotask(boot)
    return () => {
      cancelled = true
    }
  }, [token, onLogout, refreshAlerts])

  useEffect(() => {
    const search = medicineSearch.trim()
    if (search.length < 2 || search === submittedSearch) return undefined
    let cancelled = false
    const timer = setTimeout(() => getMedicines({ limit: 6, search })
      .then((medicineData) => { if (!cancelled) setSuggestions(medicineData) })
      .catch(() => { if (!cancelled) setSuggestions([]) }), 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [medicineSearch, submittedSearch])

  const searchMedicines = async (event) => {
    event.preventDefault()
    const search = medicineSearch.trim()
    setSubmittedSearch(search)
    setSuggestions([])
    try {
      await searchCatalog(search, 1)
    } catch (searchError) {
      showError(searchError.message)
    }
  }

  const selectSuggestion = async (medicine) => {
    setMedicineSearch(medicine.brandName)
    setSubmittedSearch(medicine.brandName)
    setSuggestions([])
    try {
      await searchCatalog(medicine.brandName, 1)
    } catch (searchError) {
      showError(searchError.message)
    }
  }

  const importCatalog = async () => {
    try {
      const result = await syncMedicines(token)
      await refreshAlerts()
      await searchCatalog(submittedSearch, medicinePagination.page || 1)
      showSuccess(`${result.imported} new medicines imported from the Bangladesh catalog.`)
    } catch (syncError) {
      showError(syncError.message)
    }
  }

  const emailExpiryReport = async () => {
    try {
      const result = await sendExpiryAlertEmail(token)
      if (result.sent) showSuccess(`Expiry report emailed (${result.count} items).`)
      else showError(result.reason === 'smtp-not-configured' ? 'SMTP is not configured on the server.' : (result.reason || 'Email was not sent.'))
    } catch (emailError) {
      showError(emailError.message)
    }
  }

  const visibleSuggestions = medicineSearch.trim().length >= 2 && medicineSearch.trim() !== submittedSearch
    ? suggestions
    : []

  if (isLoading) {
    return <main className="grid min-h-screen place-items-center bg-[#f4f9fc] text-[#172b3d]">Loading admin dashboard...</main>
  }

  return (
    <main className="min-h-screen bg-[#f4f9fc] px-4 py-8 text-[#172b3d] dark:bg-[#101d2b] dark:text-white sm:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-4xl font-extrabold">Pharmacy operations</h1>
            <p className="mt-1 text-sm text-[#607487]">Admin-first stock, expiry, and receipt processing</p>
          </div>
          <nav className="flex flex-wrap gap-2">
            <a href="/" className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-2 text-sm font-bold dark:border-slate-700 dark:bg-[#172b3d]">Public site</a>
            <a href="/admin/stock-receipt" className="rounded-xl bg-[#2f80c0] px-4 py-2 text-sm font-bold text-white hover:bg-[#18527f]">Receipt stock</a>
            <a href="/admin/stock-history" className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-2 text-sm font-bold dark:border-slate-700 dark:bg-[#172b3d]">Stock history</a>
            <a href="/admin/receipts" className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-2 text-sm font-bold dark:border-slate-700 dark:bg-[#172b3d]">Receipts list</a>
            <button type="button" onClick={onLogout} className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-2 text-sm font-bold dark:border-slate-700 dark:bg-[#172b3d]">Sign out</button>
          </nav>
        </header>

        {success && <p className="mt-6 rounded-xl bg-[#d9f3e6] p-3 font-semibold text-[#17683b]">{success}</p>}
        {error && <p className="mt-6 rounded-xl bg-[#fff0ef] p-3 font-semibold text-[#b94f49]">{error}</p>}

        <div className="mt-8">
          <DashboardStats stats={stats} isLoading={dashboardLoading} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={emailExpiryReport} className="rounded-xl bg-[#2f80c0] px-4 py-2 text-sm font-bold text-white hover:bg-[#18527f]">
            Email expiry report
          </button>
          <button type="button" onClick={() => setMedicineModal({})} className="rounded-xl border border-[#2f80c0] bg-white px-4 py-2 text-sm font-bold text-[#2f80c0]">
            Add medicine
          </button>
          <button type="button" onClick={importCatalog} className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-2 text-sm font-bold dark:border-slate-700 dark:bg-[#172b3d]">
            Sync Bangladesh catalog
          </button>
        </div>

        <div className="mt-4">
          <PushOptIn
            token={token}
            onMessage={({ type, text }) => {
              if (type === 'success') showSuccess(text)
              else showError(text)
            }}
          />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <LowStockTable
            items={lowStock}
            isLoading={alertsLoading}
            onAdjust={(medicine) => setAdjustTarget({ medicine })}
          />
          <ExpiringStockTable
            items={expiring}
            isLoading={alertsLoading}
            onEditBatch={(batch) => setAdjustTarget({
              medicine: {
                id: batch.medicineId,
                brandName: batch.brandName,
                availableQty: batch.availableQty,
              },
              batch,
            })}
          />
        </div>

        <section className="mt-8 rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
          <h2 className="text-2xl font-extrabold">Live stock search</h2>
          <p className="mt-1 text-sm text-[#607487]">
            Server-side search and pagination (25 per page). Adjust stock with reason + expiry when adding.
          </p>
          <form onSubmit={searchMedicines} className="relative mt-5 flex gap-2">
            <label className="sr-only" htmlFor="medicine-search">Search medicines</label>
            <input
              id="medicine-search"
              className="min-w-0 flex-1 rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-4 py-3 text-[#172b3d] outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
              value={medicineSearch}
              onChange={(event) => setMedicineSearch(event.target.value)}
              placeholder="Search brand, generic, manufacturer, or strength"
            />
            <button type="submit" className="rounded-xl bg-[#2f80c0] px-4 py-3 text-sm font-bold text-white hover:bg-[#18527f]">Search</button>
            {visibleSuggestions.length > 0 && (
              <div className="absolute left-0 right-[92px] top-full z-10 mt-2 overflow-hidden rounded-xl border border-[#d9e7f0] bg-white shadow-xl dark:border-slate-600 dark:bg-[#172b3d]">
                {visibleSuggestions.map((medicine) => (
                  <button key={medicine.id} type="button" onClick={() => selectSuggestion(medicine)} className="block w-full border-b border-[#d9e7f0] px-4 py-3 text-left last:border-0 hover:bg-[#e7f4fc] dark:border-slate-700 dark:hover:bg-slate-700">
                    <strong className="block text-sm dark:text-white">{medicine.brandName}</strong>
                    <span className="text-xs text-[#607487] dark:text-slate-300">{medicine.genericName} · {medicine.strength}</span>
                  </button>
                ))}
              </div>
            )}
          </form>
          <div className="mt-5 max-h-[55vh] overflow-y-auto pr-2">
            {medicinesLoading && <p className="rounded-xl bg-[#f4f9fc] p-4 text-[#607487] dark:bg-slate-800">Searching medicines…</p>}
            {!medicinesLoading && (
              <div className="grid gap-3">
                {medicines.length === 0 && <p className="rounded-xl bg-[#f4f9fc] p-4 text-[#607487] dark:bg-slate-800">No medicines found.</p>}
                {medicines.map((medicine) => (
                  <div key={medicine.id} className="flex flex-wrap items-end justify-between gap-3 rounded-2xl bg-[#f4f9fc] p-3 dark:bg-slate-800">
                    <div>
                      <strong className="block">{medicine.brandName}</strong>
                      <span className="text-sm text-[#607487]">{medicine.genericName} · {medicine.strength}</span>
                      <p className="mt-1 text-sm font-bold">Qty {medicine.availableQty} · Piece {medicine.singlePiecePrice} · Box {medicine.fullBoxPrice}</p>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setMedicineModal(medicine)} className="rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-sm font-bold dark:border-slate-600 dark:bg-[#172b3d]">Edit</button>
                      <button type="button" onClick={() => setAdjustTarget({ medicine })} className="rounded-lg bg-[#2f80c0] px-3 py-2 text-sm font-bold text-white hover:bg-[#18527f]">Adjust stock</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {medicinePagination.totalPages > 1 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-[#607487]">
                Page {medicinePagination.page} of {medicinePagination.totalPages}
                {medicinePagination.total ? ` · ${medicinePagination.total.toLocaleString()} total` : ''}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={medicinesLoading || medicinePagination.page <= 1}
                  onClick={() => searchCatalog(submittedSearch, medicinePagination.page - 1)}
                  className="rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-sm font-bold disabled:opacity-40 dark:border-slate-600 dark:bg-[#172b3d]"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={medicinesLoading || medicinePagination.page >= medicinePagination.totalPages}
                  onClick={() => searchCatalog(submittedSearch, medicinePagination.page + 1)}
                  className="rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-sm font-bold disabled:opacity-40 dark:border-slate-600 dark:bg-[#172b3d]"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {medicineModal && (
        <MedicineFormModal
          token={token}
          medicine={medicineModal.id ? medicineModal : null}
          onClose={() => setMedicineModal(null)}
          onSaved={async (saved) => {
            setMedicines((current) => {
              const exists = current.some((item) => item.id === saved.id)
              return exists ? current.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...current]
            })
            await refreshAlerts()
            showSuccess(medicineModal.id
              ? 'Medicine updated in the database.'
              : `Medicine created${saved.availableQty > 0 ? ` with stock ${saved.availableQty}` : ''}.`)
          }}
        />
      )}

      {adjustTarget && (
        <StockAdjustPanel
          token={token}
          medicine={adjustTarget.medicine}
          batch={adjustTarget.batch}
          onClose={() => setAdjustTarget(null)}
          onSaved={async () => {
            await refreshAlerts()
            await searchCatalog(submittedSearch, medicinePagination.page || 1)
            showSuccess('Stock synced with the database.')
          }}
        />
      )}
    </main>
  )
}

export default function AdminPage() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY))
  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
  }, [])
  return token ? <AdminDashboard token={token} onLogout={logout} /> : <AdminLogin onLogin={setToken} />
}
