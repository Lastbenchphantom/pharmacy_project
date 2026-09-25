import { useCallback, useEffect, useState } from 'react'
import {
  getAdminAppointments,
  getDashboard,
  getExpiringStock,
  getLowStock,
  getMedicines,
  loginAdmin,
  sendExpiryAlertEmail,
  syncMedicines,
  updateAppointmentStatus,
} from '../api'
import DashboardStats from './DashboardStats'
import LowStockTable from './LowStockTable'
import ExpiringStockTable from './ExpiringStockTable'
import MedicineFormModal from './MedicineFormModal'
import StockAdjustPanel from './StockAdjustPanel'
import PushOptIn from './PushOptIn'

const TOKEN_KEY = 'apollo-admin-token'

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
        <p className="mt-3 text-[#607487] dark:text-slate-300">Control stock, expiry, receipts, and appointments.</p>
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
  const [appointments, setAppointments] = useState([])
  const [appointmentFilter, setAppointmentFilter] = useState('ALL')
  const [medicineSearch, setMedicineSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [medicineModal, setMedicineModal] = useState(null)
  const [adjustTarget, setAdjustTarget] = useState(null)

  const showSuccess = (text) => {
    setSuccess(text)
    setError('')
  }
  const showError = (text) => {
    setError(text)
    setSuccess('')
  }

  const refreshAlerts = useCallback(async () => {
    const [dashboardResult, lowResult, expiringResult] = await Promise.allSettled([
      getDashboard(token),
      getLowStock(token, { limit: 20 }),
      getExpiringStock(token, { includeExpired: true, limit: 20 }),
    ])
    if (dashboardResult.status === 'fulfilled') setStats(dashboardResult.value)
    if (lowResult.status === 'fulfilled') setLowStock(lowResult.value)
    if (expiringResult.status === 'fulfilled') setExpiring(expiringResult.value)
    const authFail = [dashboardResult, lowResult, expiringResult].find((result) => (
      result.status === 'rejected' && (result.reason.message.includes('session') || result.reason.message.includes('login'))
    ))
    if (authFail) onLogout()
  }, [token, onLogout])

  const loadAppointments = useCallback(async (status = appointmentFilter) => {
    const query = status === 'ALL' ? {} : { status }
    const data = await getAdminAppointments(token, { ...query, limit: 50 })
    setAppointments(data)
  }, [token, appointmentFilter])

  const searchCatalog = async (search) => {
    const medicineData = await getMedicines({ limit: 20, search })
    setMedicines(medicineData)
  }

  useEffect(() => {
    Promise.allSettled([
      refreshAlerts(),
      getMedicines({ limit: 10 }),
      getAdminAppointments(token, { limit: 50 }),
    ]).then(([alertsResult, medicineResult, appointmentResult]) => {
      if (medicineResult.status === 'fulfilled') setMedicines(medicineResult.value)
      if (appointmentResult.status === 'fulfilled') setAppointments(appointmentResult.value)
      const failed = [alertsResult, medicineResult, appointmentResult].find((result) => result.status === 'rejected')
      if (failed) {
        const message = failed.reason.message || 'Failed to load admin data'
        if (message.includes('session') || message.includes('login')) onLogout()
        else showError(message)
      }
    }).finally(() => setIsLoading(false))
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
      await searchCatalog(search)
    } catch (searchError) {
      showError(searchError.message)
    }
  }

  const selectSuggestion = async (medicine) => {
    setMedicineSearch(medicine.brandName)
    setSubmittedSearch(medicine.brandName)
    setSuggestions([])
    try {
      await searchCatalog(medicine.brandName)
    } catch (searchError) {
      showError(searchError.message)
    }
  }

  const changeAppointment = async (id, status) => {
    if (status === 'REJECTED' && !window.confirm('Reject this appointment?')) return
    try {
      const updated = await updateAppointmentStatus(token, id, status)
      setAppointments((current) => current.map((appointment) => (appointment.id === updated.id ? updated : appointment)))
      await refreshAlerts()
      const notificationMessage = updated.notificationReason === 'sent'
        ? ' Notification email sent.'
        : updated.notificationReason === 'missing-email'
          ? ' This appointment has no email address.'
          : updated.notificationReason === 'delivery-failed'
            ? ' Email delivery failed.'
            : ' Status saved (email not configured).'
      showSuccess(`Appointment ${status.toLowerCase()}.${notificationMessage}`)
    } catch (appointmentError) {
      showError(appointmentError.message)
    }
  }

  const importCatalog = async () => {
    try {
      const result = await syncMedicines(token)
      await refreshAlerts()
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

  const filterAppointments = async (status) => {
    setAppointmentFilter(status)
    try {
      await loadAppointments(status)
    } catch (filterError) {
      showError(filterError.message)
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
            <p className="mt-1 text-sm text-[#607487]">Admin-first stock, expiry, receipts, and appointments</p>
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
          <DashboardStats stats={stats} isLoading={!stats} />
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
            isLoading={false}
            onAdjust={(medicine) => setAdjustTarget({ medicine })}
          />
          <ExpiringStockTable
            items={expiring}
            isLoading={false}
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

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_.8fr]">
          <div className="rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
            <h2 className="text-2xl font-extrabold">Live stock search</h2>
            <p className="mt-1 text-sm text-[#607487]">Adjust stock with reason + expiry when adding. Edit metadata separately.</p>
            <form onSubmit={searchMedicines} className="relative mt-5 flex gap-2">
              <label className="sr-only" htmlFor="medicine-search">Search medicines</label>
              <input
                id="medicine-search"
                className="min-w-0 flex-1 rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-4 py-3 text-[#172b3d] outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                value={medicineSearch}
                onChange={(event) => setMedicineSearch(event.target.value)}
                placeholder="Search brand, generic, or manufacturer"
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
            </div>
          </div>

          <div className="rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
            <h2 className="text-2xl font-extrabold">Appointments</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {['ALL', 'PENDING', 'ACCEPTED', 'REJECTED'].map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => filterAppointments(status)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold ${appointmentFilter === status ? 'bg-[#2f80c0] text-white' : 'bg-[#e7f4fc] text-[#18527f] dark:bg-slate-700 dark:text-slate-200'}`}
                >
                  {status === 'ALL' ? 'All' : status.charAt(0) + status.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
            <div className="mt-5 grid gap-3">
              {appointments.length === 0 && <p className="text-[#607487]">No appointment requests yet.</p>}
              {appointments.map((appointment) => (
                <article key={appointment.id} className="rounded-2xl bg-[#f4f9fc] p-4 dark:bg-slate-800">
                  <div className="flex items-start justify-between gap-3">
                    <strong>{appointment.patientName}</strong>
                    <span className="text-xs font-bold">{appointment.status}</span>
                  </div>
                  <p className="mt-2 text-sm text-[#607487]">{appointment.phoneNumber} · {appointment.doctorName} · {appointment.timeSlot}</p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={() => changeAppointment(appointment.id, 'ACCEPTED')} className="rounded-lg bg-[#d9f3e6] px-3 py-2 text-xs font-bold text-[#17683b]">Accept</button>
                    <button type="button" onClick={() => changeAppointment(appointment.id, 'REJECTED')} className="rounded-lg bg-[#fff0ef] px-3 py-2 text-xs font-bold text-[#b94f49]">Reject</button>
                  </div>
                </article>
              ))}
            </div>
          </div>
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
            showSuccess(medicineModal.id ? 'Medicine updated.' : 'Medicine created with zero stock.')
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
            if (submittedSearch) await searchCatalog(submittedSearch)
            else setMedicines(await getMedicines({ limit: 10 }))
            showSuccess('Stock updated.')
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
