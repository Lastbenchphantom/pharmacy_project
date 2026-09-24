import { useCallback, useEffect, useState } from 'react'
import {
  getAdminAppointments,
  getMedicines,
  loginAdmin,
  syncMedicines,
  updateAppointmentStatus,
  updateMedicineStock,
} from '../api'

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
        <p className="mt-3 text-[#607487] dark:text-slate-300">Manage live inventory and respond to consultation requests.</p>
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
  const [medicines, setMedicines] = useState([])
  const [stockDrafts, setStockDrafts] = useState({})
  const [medicineSearch, setMedicineSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [appointments, setAppointments] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [updatingMedicineId, setUpdatingMedicineId] = useState(null)
  const [message, setMessage] = useState('')

  const setMedicineResults = (medicineData) => {
    setMedicines(medicineData)
    setStockDrafts(Object.fromEntries(medicineData.map((medicine) => [medicine.id, {
      availableQty: String(medicine.availableQty),
      singlePiecePrice: String(medicine.singlePiecePrice ?? 0),
      fullBoxPrice: String(medicine.fullBoxPrice ?? 0),
    }])))
  }

  const searchCatalog = async (search) => {
    const medicineData = await getMedicines({ limit: 20, search })
    setMedicineResults(medicineData)
  }

  const loadDashboard = async () => {
    const [medicineResult, appointmentResult] = await Promise.allSettled([
      getMedicines({ limit: 10, search: submittedSearch }),
      getAdminAppointments(token),
    ])
    if (medicineResult.status === 'fulfilled') setMedicineResults(medicineResult.value)
    if (appointmentResult.status === 'fulfilled') setAppointments(appointmentResult.value)
    const failedResult = [medicineResult, appointmentResult].find((result) => result.status === 'rejected')
    if (failedResult) throw failedResult.reason
  }

  useEffect(() => {
    Promise.allSettled([getMedicines({ limit: 10 }), getAdminAppointments(token)])
      .then(([medicineResult, appointmentResult]) => {
        if (medicineResult.status === 'fulfilled') setMedicineResults(medicineResult.value)
        if (appointmentResult.status === 'fulfilled') setAppointments(appointmentResult.value)
        const failedResult = [medicineResult, appointmentResult].find((result) => result.status === 'rejected')
        if (failedResult) {
          const error = failedResult.reason
          if (error.message.includes('session') || error.message.includes('login')) onLogout()
          else setMessage(error.message)
        }
      })
      .finally(() => setIsLoading(false))
  }, [token, onLogout])

  useEffect(() => {
    const search = medicineSearch.trim()
    if (search.length < 2 || search === submittedSearch) return undefined

    let cancelled = false
    const timer = setTimeout(() => getMedicines({ limit: 6, search })
      .then((medicineData) => {
        if (!cancelled) setSuggestions(medicineData)
      })
      .catch(() => {
        if (!cancelled) setSuggestions([])
      }), 300)

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
    } catch (error) {
      setMessage(error.message)
    }
  }

  const selectSuggestion = async (medicine) => {
    setMedicineSearch(medicine.brandName)
    setSubmittedSearch(medicine.brandName)
    setSuggestions([])
    try {
      await searchCatalog(medicine.brandName)
    } catch (error) {
      setMessage(error.message)
    }
  }

  const visibleSuggestions = medicineSearch.trim().length >= 2 && medicineSearch.trim() !== submittedSearch
    ? suggestions
    : []

  const changeStock = async (medicineId) => {
    const draft = stockDrafts[medicineId] || {}
    const quantity = Number.parseInt(draft.availableQty, 10)
    const singlePiecePrice = Number(draft.singlePiecePrice)
    const fullBoxPrice = Number(draft.fullBoxPrice)
    if (!Number.isInteger(quantity) || quantity < 0 || !Number.isFinite(singlePiecePrice) || singlePiecePrice < 0 || !Number.isFinite(fullBoxPrice) || fullBoxPrice < 0) {
      setMessage('Enter valid non-negative stock and prices.')
      return
    }
    try {
      setUpdatingMedicineId(medicineId)
      const updated = await updateMedicineStock(token, medicineId, { availableQty: quantity, singlePiecePrice, fullBoxPrice })
      setMedicines((current) => current.map((medicine) => medicine.id === updated.id ? updated : medicine))
      setStockDrafts((current) => ({
        ...current,
        [medicineId]: {
          availableQty: String(updated.availableQty),
          singlePiecePrice: String(updated.singlePiecePrice ?? 0),
          fullBoxPrice: String(updated.fullBoxPrice ?? 0),
        },
      }))
      setMessage(updated.pricesSaved === false
        ? 'Stock quantity updated. Run the Supabase price-column migration to save prices.'
        : 'Stock and prices updated successfully.')
    } catch (error) {
      setMessage(error.message)
    } finally {
      setUpdatingMedicineId(null)
    }
  }

  const updateDraft = (medicineId, field, value) => {
    setStockDrafts((current) => ({ ...current, [medicineId]: { ...current[medicineId], [field]: value } }))
  }

  const changeAppointment = async (id, status) => {
    try {
      const updated = await updateAppointmentStatus(token, id, status)
      setAppointments((current) => current.map((appointment) => appointment.id === updated.id ? updated : appointment))
      const notificationMessage = updated.notificationReason === 'sent'
        ? ' Notification email sent.'
        : updated.notificationReason === 'missing-email'
          ? ' This appointment has no email address; create a new booking with email.'
          : updated.notificationReason === 'delivery-failed'
            ? ' Email delivery failed; check the backend SMTP logs.'
            : ' SMTP is not loaded by the running backend.'
      setMessage(`Appointment ${status.toLowerCase()}.${notificationMessage}`)
    } catch (error) {
      setMessage(error.message)
    }
  }

  const importCatalog = async () => {
    try {
      const result = await syncMedicines(token)
      await loadDashboard()
      setMessage(`${result.imported} new medicines imported from the configured Bangladesh catalog.`)
    } catch (error) {
      setMessage(error.message)
    }
  }

  if (isLoading) return <main className="grid min-h-screen place-items-center bg-[#f4f9fc] text-[#172b3d]">Loading admin dashboard...</main>

  return (
    <main className="min-h-screen bg-[#f4f9fc] px-4 py-8 text-[#172b3d] dark:bg-[#101d2b] dark:text-white sm:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div><a href="/" className="text-sm font-bold text-[#2f80c0]">← Public site</a><h1 className="mt-2 text-4xl font-extrabold">Pharmacy operations</h1></div>
          <button type="button" onClick={onLogout} className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-2 font-bold dark:border-slate-700 dark:bg-[#172b3d]">Sign out</button>
        </header>
        {message && <p className="mt-6 rounded-xl bg-[#e7f4fc] p-3 font-semibold text-[#18527f]">{message}</p>}
        <section className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_.8fr]">
          <div className="rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
            <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-extrabold">Live stock</h2><button type="button" onClick={importCatalog} className="rounded-xl bg-[#2f80c0] px-4 py-2 text-sm font-bold text-white">Sync Bangladesh catalog</button></div>
            <form onSubmit={searchMedicines} className="relative mt-5 flex gap-2">
              <label className="sr-only" htmlFor="medicine-search">Search medicines</label>
              <input id="medicine-search" className="min-w-0 flex-1 rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-4 py-3 text-[#172b3d] outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white" value={medicineSearch} onChange={(event) => setMedicineSearch(event.target.value)} placeholder="Search by brand name" />
              <button type="submit" className="rounded-xl bg-[#2f80c0] px-4 py-3 text-sm font-bold text-white hover:bg-[#18527f]">Search</button>
              {visibleSuggestions.length > 0 && <div className="absolute left-0 right-[92px] top-full z-10 mt-2 overflow-hidden rounded-xl border border-[#d9e7f0] bg-white shadow-xl dark:border-slate-600 dark:bg-[#172b3d]">
                {visibleSuggestions.map((medicine) => <button key={medicine.id} type="button" onClick={() => selectSuggestion(medicine)} className="block w-full border-b border-[#d9e7f0] px-4 py-3 text-left last:border-0 hover:bg-[#e7f4fc] dark:border-slate-700 dark:hover:bg-slate-700">
                  <strong className="block text-sm dark:text-white">{medicine.brandName}</strong>
                  <span className="text-xs text-[#607487] dark:text-slate-300">{medicine.genericName} · {medicine.strength}</span>
                </button>)}
              </div>}
            </form>
            <div className="mt-5 max-h-[62vh] overflow-y-auto pr-2">
              <div className="grid gap-3">
              {medicines.length === 0 && <p className="rounded-xl bg-[#f4f9fc] p-4 text-[#607487] dark:bg-slate-800">No medicines found.</p>}
              {medicines.map((medicine) => { const draft = stockDrafts[medicine.id] || {}; const isUpdating = updatingMedicineId === medicine.id; return <div key={medicine.id} className="grid grid-cols-[1fr_110px_130px_130px_auto] items-end gap-3 rounded-2xl bg-[#f4f9fc] p-3 dark:bg-slate-800 max-sm:grid-cols-1"><div><strong className="block">{medicine.brandName}</strong><span className="text-sm text-[#607487]">{medicine.genericName} · {medicine.manufacturer}</span></div><label className="text-xs font-bold text-[#607487]">Units<input className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-[#172b3d]" type="number" min="0" value={draft.availableQty ?? ''} onChange={(event) => updateDraft(medicine.id, 'availableQty', event.target.value)} /></label><label className="text-xs font-bold text-[#607487]">Piece price<input className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-[#172b3d]" type="number" min="0" step="0.01" value={draft.singlePiecePrice ?? ''} onChange={(event) => updateDraft(medicine.id, 'singlePiecePrice', event.target.value)} /></label><label className="text-xs font-bold text-[#607487]">Box price<input className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-[#172b3d]" type="number" min="0" step="0.01" value={draft.fullBoxPrice ?? ''} onChange={(event) => updateDraft(medicine.id, 'fullBoxPrice', event.target.value)} /></label><button type="button" disabled={isUpdating} onClick={() => changeStock(medicine.id)} className="rounded-lg bg-[#2f80c0] px-3 py-2 text-sm font-bold text-white hover:bg-[#18527f] disabled:cursor-wait disabled:opacity-60">{isUpdating ? 'Saving...' : 'Update'}</button></div> })}
              </div>
            </div>
          </div>
          <div className="rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]"><h2 className="text-2xl font-extrabold">Appointments</h2><div className="mt-5 grid gap-3">{appointments.length === 0 && <p className="text-[#607487]">No appointment requests yet.</p>}{appointments.map((appointment) => <article key={appointment.id} className="rounded-2xl bg-[#f4f9fc] p-4 dark:bg-slate-800"><div className="flex items-start justify-between gap-3"><strong>{appointment.patientName}</strong><span className="text-xs font-bold">{appointment.status}</span></div><p className="mt-2 text-sm text-[#607487]">{appointment.phoneNumber} · {appointment.doctorName} · {appointment.timeSlot}</p><div className="mt-3 flex gap-2"><button type="button" onClick={() => changeAppointment(appointment.id, 'ACCEPTED')} className="rounded-lg bg-[#d9f3e6] px-3 py-2 text-xs font-bold text-[#17683b]">Accept</button><button type="button" onClick={() => changeAppointment(appointment.id, 'REJECTED')} className="rounded-lg bg-[#fff0ef] px-3 py-2 text-xs font-bold text-[#b94f49]">Reject</button></div></article>)}</div></div>
        </section>
      </div>
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
