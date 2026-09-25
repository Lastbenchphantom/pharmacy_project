export default function LowStockTable({ items, isLoading, onAdjust }) {
  return (
    <section className="rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
      <h2 className="text-xl font-extrabold">Low stock</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[#d9e7f0] text-xs uppercase tracking-wide text-[#607487]">
              <th className="p-2">Medicine</th>
              <th className="p-2">Qty</th>
              <th className="p-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td className="p-3 text-[#607487]" colSpan={3}>Loading low stock…</td></tr>
            )}
            {!isLoading && items.length === 0 && (
              <tr><td className="p-3 text-[#607487]" colSpan={3}>No low stock items</td></tr>
            )}
            {items.map((medicine) => (
              <tr key={medicine.id} className="border-b border-[#d9e7f0] dark:border-slate-700">
                <td className="p-2">
                  <strong className="block">{medicine.brandName}</strong>
                  <span className="text-xs text-[#607487]">{medicine.strength} · {medicine.genericName}</span>
                </td>
                <td className="p-2 font-bold">{medicine.availableQty}</td>
                <td className="p-2">
                  <button
                    type="button"
                    onClick={() => onAdjust?.(medicine)}
                    className="rounded-lg bg-[#2f80c0] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#18527f]"
                  >
                    Adjust
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
