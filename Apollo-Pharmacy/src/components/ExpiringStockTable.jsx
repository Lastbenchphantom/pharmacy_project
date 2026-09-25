const daysUntil = (expiryDate) => {
  if (!expiryDate) return null
  const expiry = new Date(expiryDate)
  if (Number.isNaN(expiry.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  expiry.setHours(0, 0, 0, 0)
  return Math.ceil((expiry - today) / (1000 * 60 * 60 * 24))
}

const statusBadge = (expiryDate) => {
  const days = daysUntil(expiryDate)
  if (days === null) return { label: 'Unknown', className: 'bg-[#e7f4fc] text-[#18527f]' }
  if (days < 0) return { label: 'Expired', className: 'bg-[#fff0ef] text-[#b94f49]' }
  if (days <= 30) return { label: '≤30d', className: 'bg-[#ffe6b3] text-[#795f00]' }
  if (days <= 90) return { label: '≤90d', className: 'bg-[#fff8df] text-[#795f00]' }
  return { label: `≤${days}d`, className: 'bg-[#e7f4fc] text-[#18527f]' }
}

export default function ExpiringStockTable({ items, isLoading, onEditBatch }) {
  return (
    <section className="rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
      <h2 className="text-xl font-extrabold">Expiring / expired</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[#d9e7f0] text-xs uppercase tracking-wide text-[#607487]">
              <th className="p-2">Medicine</th>
              <th className="p-2">Batch</th>
              <th className="p-2">Expiry</th>
              <th className="p-2">Qty</th>
              <th className="p-2">Status</th>
              <th className="p-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td className="p-3 text-[#607487]" colSpan={6}>Loading expiring stock…</td></tr>
            )}
            {!isLoading && items.length === 0 && (
              <tr><td className="p-3 text-[#607487]" colSpan={6}>No expiring batches</td></tr>
            )}
            {items.map((batch) => {
              const badge = statusBadge(batch.expiryDate)
              return (
                <tr key={batch.id} className="border-b border-[#d9e7f0] dark:border-slate-700">
                  <td className="p-2">
                    <strong className="block">{batch.brandName}</strong>
                    <span className="text-xs text-[#607487]">{batch.strength}</span>
                  </td>
                  <td className="p-2">{batch.batchNumber || '—'}</td>
                  <td className="p-2">{batch.expiryDate ? String(batch.expiryDate).slice(0, 10) : '—'}</td>
                  <td className="p-2 font-bold">{batch.quantity}</td>
                  <td className="p-2">
                    <span className={`rounded-full px-2 py-1 text-xs font-bold ${badge.className}`}>{badge.label}</span>
                  </td>
                  <td className="p-2">
                    <button
                      type="button"
                      onClick={() => onEditBatch?.(batch)}
                      className="rounded-lg border border-[#d9e7f0] bg-white px-3 py-1.5 text-xs font-bold hover:bg-[#e7f4fc] dark:border-slate-600 dark:bg-slate-800"
                    >
                      Edit batch
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
