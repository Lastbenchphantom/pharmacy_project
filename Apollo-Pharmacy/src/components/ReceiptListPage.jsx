import { useEffect, useState } from 'react'
import { getReceipts } from '../api'

const TOKEN_KEY = 'apollo-admin-token'

const STATUS_OPTIONS = ['ALL', 'PROCESSING', 'READY_FOR_REVIEW', 'FAILED', 'CONFIRMED']

export default function ReceiptListPage() {
  const [token] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [rows, setRows] = useState([])
  const [status, setStatus] = useState('ALL')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  const loadRows = async (nextStatus = status) => {
    const data = await getReceipts(token, {
      status: nextStatus === 'ALL' ? undefined : nextStatus,
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

  const changeStatus = async (nextStatus) => {
    setStatus(nextStatus)
    setError('')
    setIsLoading(true)
    try {
      await loadRows(nextStatus)
    } catch (filterError) {
      setError(filterError.message)
    } finally {
      setIsLoading(false)
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
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <a href="/admin" className="text-sm font-bold text-[#2f80c0]">← Back to pharmacy operations</a>
            <h1 className="mt-2 text-4xl font-extrabold">Receipts</h1>
            <p className="mt-2 text-[#607487]">Open non-confirmed receipts to continue review</p>
          </div>
          <a href="/admin/stock-receipt" className="rounded-xl bg-[#2f80c0] px-4 py-2 text-sm font-bold text-white hover:bg-[#18527f]">Upload new receipt</a>
        </header>

        {error && <p className="mt-6 rounded-xl bg-[#fff0ef] p-4 font-semibold text-[#b94f49]">{error}</p>}

        <div className="mt-6 flex flex-wrap gap-2">
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => changeStatus(option)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold ${status === option ? 'bg-[#2f80c0] text-white' : 'bg-[#e7f4fc] text-[#18527f] dark:bg-slate-700 dark:text-slate-200'}`}
            >
              {option === 'ALL' ? 'All' : option.replaceAll('_', ' ')}
            </button>
          ))}
        </div>

        <section className="mt-6 overflow-x-auto rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
          <table className="min-w-[900px] w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[#d9e7f0] text-xs uppercase tracking-wide text-[#607487]">
                <th className="p-2">Uploaded</th>
                <th className="p-2">File</th>
                <th className="p-2">Status</th>
                <th className="p-2">By</th>
                <th className="p-2">Error</th>
                <th className="p-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td className="p-3 text-[#607487]" colSpan={6}>Loading receipts…</td></tr>}
              {!isLoading && rows.length === 0 && <tr><td className="p-3 text-[#607487]" colSpan={6}>No receipts found</td></tr>}
              {rows.map((receipt) => {
                const canReview = receipt.status !== 'CONFIRMED'
                return (
                  <tr key={receipt.id} className="border-b border-[#d9e7f0] dark:border-slate-700">
                    <td className="p-2 whitespace-nowrap">{receipt.uploadedAt ? new Date(receipt.uploadedAt).toLocaleString() : '—'}</td>
                    <td className="p-2">{receipt.fileName}</td>
                    <td className="p-2 font-bold">{receipt.status}</td>
                    <td className="p-2">{receipt.uploadedBy || '—'}</td>
                    <td className="p-2 text-[#b94f49]">{receipt.errorMessage || '—'}</td>
                    <td className="p-2">
                      {canReview ? (
                        <a
                          href={`/admin/stock-receipt?receiptId=${encodeURIComponent(receipt.id)}`}
                          className="rounded-lg bg-[#2f80c0] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#18527f]"
                        >
                          {receipt.status === 'READY_FOR_REVIEW' ? 'Open review' : 'Open'}
                        </a>
                      ) : (
                        <span className="text-xs text-[#607487]">Confirmed</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  )
}
