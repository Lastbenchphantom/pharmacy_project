import { useEffect, useState } from 'react'
import { downloadStockCsv, downloadTransactionsCsv, getMedicines, getStockTransactions } from '../api'

const TOKEN_KEY = 'apollo-admin-token'

export default function StockHistoryPage() {
  const [token] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [rows, setRows] = useState([])
  const [medicineQuery, setMedicineQuery] = useState('')
  const [medicineId, setMedicineId] = useState('')
  const [medicineLabel, setMedicineLabel] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [type, setType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  const loadRows = async (filters = {}) => {
    const data = await getStockTransactions(token, {
      medicineId: filters.medicineId !== undefined ? (filters.medicineId || undefined) : (medicineId || undefined),
      type: filters.type !== undefined ? (filters.type || undefined) : (type || undefined),
      from: filters.from !== undefined ? (filters.from || undefined) : (from || undefined),
      to: filters.to !== undefined ? (filters.to || undefined) : (to || undefined),
      limit: 100,
    })
    setRows(data)
  }

  useEffect(() => {
    if (!token) return
    loadRows()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setIsLoading(false))
  }, [token])

  useEffect(() => {
    const search = medicineQuery.trim()
    if (search.length < 2) {
      setSuggestions([])
      return undefined
    }
    let cancelled = false
    const timer = setTimeout(() => {
      getMedicines({ limit: 8, search })
        .then((medicines) => { if (!cancelled) setSuggestions(medicines) })
        .catch(() => { if (!cancelled) setSuggestions([]) })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [medicineQuery])

  const applyFilters = async (event) => {
    event.preventDefault()
    setError('')
    setIsLoading(true)
    try {
      await loadRows()
    } catch (filterError) {
      setError(filterError.message)
    } finally {
      setIsLoading(false)
    }
  }

  const clearMedicine = () => {
    setMedicineId('')
    setMedicineLabel('')
    setMedicineQuery('')
    setSuggestions([])
  }

  const exportStock = async () => {
    try {
      await downloadStockCsv(token)
    } catch (exportError) {
      setError(exportError.message)
    }
  }

  const exportTransactions = async () => {
    try {
      await downloadTransactionsCsv(token, { from: from || undefined, to: to || undefined })
    } catch (exportError) {
      setError(exportError.message)
    }
  }

  if (!token) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f4f9fc] p-6 text-[#172b3d]">
        <div className="rounded-3xl border border-[#d9e7f0] bg-white p-8 text-center shadow-xl">
          <h1 className="text-2xl font-extrabold">Admin sign in required</h1>
          <a className="mt-4 inline-block font-bold text-[#2f80c0]" href="/admin">Go to admin sign in</a>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#f4f9fc] px-4 py-8 text-[#172b3d] dark:bg-[#101d2b] dark:text-white sm:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <a href="/admin" className="text-sm font-bold text-[#2f80c0]">← Back to pharmacy operations</a>
            <h1 className="mt-2 text-4xl font-extrabold">Stock history</h1>
            <p className="mt-2 text-[#607487]">Audit trail for purchases and manual adjustments</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={exportStock} className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-2 text-sm font-bold dark:border-slate-700 dark:bg-[#172b3d]">Export stock CSV</button>
            <button type="button" onClick={exportTransactions} className="rounded-xl bg-[#2f80c0] px-4 py-2 text-sm font-bold text-white hover:bg-[#18527f]">Export transactions CSV</button>
          </div>
        </header>

        {error && <p className="mt-6 rounded-xl bg-[#fff0ef] p-4 font-semibold text-[#b94f49]">{error}</p>}

        <form onSubmit={applyFilters} className="mt-8 grid gap-3 rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d] lg:grid-cols-[1.4fr_1fr_1fr_1fr_auto]">
          <div className="relative">
            <label className="text-xs font-bold text-[#607487]">Medicine</label>
            <input
              className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
              value={medicineLabel || medicineQuery}
              onChange={(event) => {
                clearMedicine()
                setMedicineQuery(event.target.value)
              }}
              placeholder="Search medicine"
            />
            {suggestions.length > 0 && (
              <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-[#d9e7f0] bg-white shadow-lg dark:border-slate-600 dark:bg-[#172b3d]">
                {suggestions.map((medicine) => (
                  <button
                    key={medicine.id}
                    type="button"
                    className="block w-full border-b border-[#d9e7f0] px-3 py-2 text-left text-sm last:border-0 hover:bg-[#e7f4fc] dark:border-slate-700"
                    onClick={() => {
                      setMedicineId(medicine.id)
                      setMedicineLabel(`${medicine.brandName} · ${medicine.strength}`)
                      setMedicineQuery('')
                      setSuggestions([])
                    }}
                  >
                    {medicine.brandName} · {medicine.strength}
                  </button>
                ))}
              </div>
            )}
          </div>
          <label className="text-xs font-bold text-[#607487]">
            Type
            <select className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white" value={type} onChange={(event) => setType(event.target.value)}>
              <option value="">All types</option>
              <option value="PURCHASE_RECEIPT">Purchase receipt</option>
              <option value="MANUAL_ADJUSTMENT">Manual adjustment</option>
            </select>
          </label>
          <label className="text-xs font-bold text-[#607487]">
            From
            <input className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="text-xs font-bold text-[#607487]">
            To
            <input className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <div className="flex items-end gap-2">
            <button type="submit" className="rounded-xl bg-[#2f80c0] px-4 py-2 text-sm font-bold text-white hover:bg-[#18527f]">Filter</button>
            {(medicineId || type || from || to) && (
              <button
                type="button"
                className="rounded-xl border border-[#d9e7f0] px-4 py-2 text-sm font-bold dark:border-slate-600"
                onClick={async () => {
                  clearMedicine()
                  setType('')
                  setFrom('')
                  setTo('')
                  setIsLoading(true)
                  try {
                    await loadRows({ medicineId: '', type: '', from: '', to: '' })
                  } catch (resetError) {
                    setError(resetError.message)
                  } finally {
                    setIsLoading(false)
                  }
                }}
              >
                Clear
              </button>
            )}
          </div>
        </form>

        <section className="mt-6 overflow-x-auto rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
          <table className="min-w-[1100px] w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[#d9e7f0] text-xs uppercase tracking-wide text-[#607487]">
                <th className="p-2">Date</th>
                <th className="p-2">Medicine</th>
                <th className="p-2">Type</th>
                <th className="p-2">Qty</th>
                <th className="p-2">Previous → New</th>
                <th className="p-2">Batch</th>
                <th className="p-2">Expiry</th>
                <th className="p-2">Reason</th>
                <th className="p-2">By</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td className="p-3 text-[#607487]" colSpan={9}>Loading history…</td></tr>}
              {!isLoading && rows.length === 0 && <tr><td className="p-3 text-[#607487]" colSpan={9}>No stock transactions found</td></tr>}
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-[#d9e7f0] dark:border-slate-700">
                  <td className="p-2 whitespace-nowrap">{row.createdAt ? new Date(row.createdAt).toLocaleString() : '—'}</td>
                  <td className="p-2">
                    <strong className="block">{row.brandName || row.medicineId}</strong>
                    <span className="text-xs text-[#607487]">{row.strength || ''}</span>
                  </td>
                  <td className="p-2">{row.transactionType}</td>
                  <td className="p-2 font-bold">{row.quantity}</td>
                  <td className="p-2">{row.previousStock} → {row.newStock}</td>
                  <td className="p-2">{row.batchNumber || '—'}</td>
                  <td className="p-2">{row.expiryDate || '—'}</td>
                  <td className="p-2">{row.reason || '—'}</td>
                  <td className="p-2">{row.createdBy || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  )
}
