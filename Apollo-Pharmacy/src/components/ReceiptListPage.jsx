import { useEffect, useState } from 'react'
import { deleteReceipt, getReceipts } from '../api'

const TOKEN_KEY = 'apollo-admin-token'

const STATUS_OPTIONS = ['ALL', 'PROCESSING', 'READY_FOR_REVIEW', 'FAILED', 'CONFIRMED']

const statusLabel = (status) => String(status || '').replaceAll('_', ' ')

export default function ReceiptListPage() {
  const [token] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [rows, setRows] = useState([])
  const [status, setStatus] = useState('ALL')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)

  const loadRows = async (nextStatus = status) => {
    const data = await getReceipts(token, {
      status: nextStatus === 'ALL' ? undefined : nextStatus,
      limit: 100,
    })
    setRows(data)
  }

  useEffect(() => {
    if (!token) return undefined
    let cancelled = false
    queueMicrotask(() => {
      loadRows()
        .catch((loadError) => { if (!cancelled) setError(loadError.message) })
        .finally(() => { if (!cancelled) setIsLoading(false) })
    })
    return () => { cancelled = true }
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

  const handleRetry = (receipt) => {
    if (receipt.status !== 'FAILED') return
    window.location.assign(`/admin/stock-receipt?receiptId=${encodeURIComponent(receipt.id)}&retry=1`)
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setBusyId(target.id)
    setError('')
    try {
      await deleteReceipt(token, target.id)
      setPendingDelete(null)
      await loadRows()
    } catch (deleteError) {
      setError(deleteError.message || 'Could not delete receipt.')
    } finally {
      setBusyId('')
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
              {option === 'ALL' ? 'All' : statusLabel(option)}
            </button>
          ))}
        </div>

        {/* Mobile-friendly stacked cards */}
        <section className="mt-6 grid gap-3 md:hidden">
          {isLoading && <p className="rounded-2xl border border-[#d9e7f0] bg-white p-4 text-[#607487] dark:border-slate-700 dark:bg-[#172b3d]">Loading receipts…</p>}
          {!isLoading && rows.length === 0 && <p className="rounded-2xl border border-[#d9e7f0] bg-white p-4 text-[#607487] dark:border-slate-700 dark:bg-[#172b3d]">No receipts found</p>}
          {rows.map((receipt) => {
            const canDelete = receipt.status !== 'CONFIRMED'
            const canRetry = receipt.status === 'FAILED'
            return (
              <article key={receipt.id} className="rounded-2xl border border-[#d9e7f0] bg-white p-4 dark:border-slate-700 dark:bg-[#172b3d]">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-bold break-all">{receipt.fileName}</p>
                    <p className="mt-1 text-xs text-[#607487]">
                      ID {receipt.id?.slice(0, 8)}…
                      {receipt.supplierName ? ` · ${receipt.supplierName}` : ''}
                    </p>
                    <p className="mt-1 text-xs text-[#607487]">
                      {receipt.uploadedAt ? new Date(receipt.uploadedAt).toLocaleString() : '—'}
                      {receipt.total != null ? ` · Total ${receipt.total}` : ''}
                    </p>
                  </div>
                  <span className="rounded-lg bg-[#e7f4fc] px-2 py-1 text-xs font-bold text-[#18527f] dark:bg-slate-700 dark:text-slate-100">
                    {statusLabel(receipt.status)}
                  </span>
                </div>
                {receipt.status === 'FAILED' && receipt.errorMessage && (
                  <p className="mt-3 text-sm font-semibold text-[#b94f49]">{receipt.errorMessage}</p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <a
                    href={`/admin/stock-receipt?receiptId=${encodeURIComponent(receipt.id)}`}
                    className="inline-flex min-h-10 items-center rounded-lg bg-[#2f80c0] px-3 py-2 text-xs font-bold text-white hover:bg-[#18527f]"
                  >
                    {receipt.status === 'CONFIRMED' ? 'View' : (receipt.status === 'READY_FOR_REVIEW' ? 'Open review' : 'Open')}
                  </a>
                  {canRetry && (
                    <button
                      type="button"
                      disabled={busyId === receipt.id}
                      onClick={() => handleRetry(receipt)}
                      className="inline-flex min-h-10 items-center rounded-lg border border-[#2f80c0] px-3 py-2 text-xs font-bold text-[#18527f] disabled:opacity-50 dark:text-[#bfe4fb]"
                    >
                      {busyId === receipt.id ? 'Retrying…' : 'Retry'}
                    </button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      disabled={busyId === receipt.id}
                      onClick={() => setPendingDelete(receipt)}
                      className="inline-flex min-h-10 items-center rounded-lg border border-[#d98b86] px-3 py-2 text-xs font-bold text-[#b94f49] disabled:opacity-50"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </article>
            )
          })}
        </section>

        {/* Desktop table */}
        <section className="mt-6 hidden overflow-x-auto rounded-3xl border border-[#d9e7f0] bg-white p-5 md:block dark:border-slate-700 dark:bg-[#172b3d]">
          <table className="min-w-full w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[#d9e7f0] text-xs uppercase tracking-wide text-[#607487]">
                <th className="p-2">ID</th>
                <th className="p-2">Supplier</th>
                <th className="p-2">Uploaded</th>
                <th className="p-2">Status</th>
                <th className="p-2">Total</th>
                <th className="p-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td className="p-3 text-[#607487]" colSpan={6}>Loading receipts…</td></tr>}
              {!isLoading && rows.length === 0 && <tr><td className="p-3 text-[#607487]" colSpan={6}>No receipts found</td></tr>}
              {rows.map((receipt) => {
                const canOpen = true
                const canDelete = receipt.status !== 'CONFIRMED'
                const canRetry = receipt.status === 'FAILED'
                return (
                  <tr key={receipt.id} className="border-b border-[#d9e7f0] dark:border-slate-700">
                    <td className="p-2 font-mono text-xs" title={receipt.id}>{receipt.id?.slice(0, 8)}…</td>
                    <td className="p-2 max-w-[160px] break-words">{receipt.supplierName || receipt.fileName || '—'}</td>
                    <td className="p-2 whitespace-nowrap">{receipt.uploadedAt ? new Date(receipt.uploadedAt).toLocaleString() : '—'}</td>
                    <td className="p-2 font-bold whitespace-nowrap">{statusLabel(receipt.status)}</td>
                    <td className="p-2">{receipt.total != null ? receipt.total : '—'}</td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-2">
                        <a
                          href={`/admin/stock-receipt?receiptId=${encodeURIComponent(receipt.id)}`}
                          className="inline-flex min-h-9 items-center rounded-lg bg-[#2f80c0] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#18527f]"
                        >
                          {receipt.status === 'CONFIRMED' ? 'View' : (receipt.status === 'READY_FOR_REVIEW' ? 'Open review' : 'Open')}
                        </a>
                        {canRetry && (
                          <button
                            type="button"
                            disabled={busyId === receipt.id}
                            onClick={() => handleRetry(receipt)}
                            className="inline-flex min-h-9 items-center rounded-lg border border-[#2f80c0] px-3 py-1.5 text-xs font-bold text-[#18527f] disabled:opacity-50"
                          >
                            {busyId === receipt.id ? 'Retrying…' : 'Retry'}
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            disabled={busyId === receipt.id}
                            onClick={() => setPendingDelete(receipt)}
                            className="inline-flex min-h-9 items-center rounded-lg border border-[#d98b86] px-3 py-1.5 text-xs font-bold text-[#b94f49] disabled:opacity-50"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      </div>

      {pendingDelete && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="delete-receipt-title">
          <div className="w-full max-w-md rounded-2xl border border-[#d9e7f0] bg-white p-6 shadow-2xl dark:border-slate-600 dark:bg-[#172b3d]">
            <h2 id="delete-receipt-title" className="text-xl font-extrabold">Delete this receipt?</h2>
            <p className="mt-3 text-sm text-[#607487] dark:text-slate-300">
              <strong className="block break-all text-[#172b3d] dark:text-white">{pendingDelete.fileName}</strong>
              <span className="mt-2 block">Status: {statusLabel(pendingDelete.status)}</span>
              <span className="mt-2 block font-semibold text-[#b94f49]">This action cannot be undone.</span>
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                disabled={busyId === pendingDelete.id}
                onClick={() => setPendingDelete(null)}
                className="rounded-xl border border-[#d9e7f0] px-4 py-2 text-sm font-bold text-[#18527f] dark:border-slate-600 dark:text-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyId === pendingDelete.id}
                onClick={confirmDelete}
                className="rounded-xl bg-[#b94f49] px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                {busyId === pendingDelete.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
