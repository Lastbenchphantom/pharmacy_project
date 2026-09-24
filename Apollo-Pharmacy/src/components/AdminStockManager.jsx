
import { useState } from 'react'

export default function AdminStockManager({ medicineId, currentQty = 0, singlePiecePrice = 0, fullBoxPrice = 0, brandName, adminToken, onStockUpdated }) {
  const [quantity, setQuantity] = useState(() =>
    Number.isFinite(Number(currentQty)) ? Number(currentQty) : 0,
  )
  const [piecePrice, setPiecePrice] = useState(() => Number.isFinite(Number(singlePiecePrice)) ? Number(singlePiecePrice) : 0)
  const [boxPrice, setBoxPrice] = useState(() => Number.isFinite(Number(fullBoxPrice)) ? Number(fullBoxPrice) : 0)
  const [isUpdating, setIsUpdating] = useState(false)
  const [message, setMessage] = useState('')

  const handleStockSubmit = async (e) => {
    e.preventDefault()

    if (!adminToken) {
      setMessage('❌ Security Error: Please sign in again.')
      return
    }

    const nextQty = Number.parseInt(quantity, 10)
    const nextPiecePrice = Number(piecePrice)
    const nextBoxPrice = Number(boxPrice)
    if (Number.isNaN(nextQty) || nextQty < 0 || !Number.isFinite(nextPiecePrice) || nextPiecePrice < 0 || !Number.isFinite(nextBoxPrice) || nextBoxPrice < 0) {
      setMessage('❌ Enter valid non-negative stock and prices.')
      return
    }

    setIsUpdating(true)
    setMessage('')

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000/api'}/admin/update-stock`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          medicineId,
          availableQty: nextQty,
          singlePiecePrice: nextPiecePrice,
          fullBoxPrice: nextBoxPrice,
        }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Failed to sync inventory changes.')

      setMessage('Stock updated successfully! ✅')
      setQuantity(nextQty)
      setPiecePrice(nextPiecePrice)
      setBoxPrice(nextBoxPrice)
      if (onStockUpdated) onStockUpdated(medicineId, nextQty)
    } catch (err) {
      setMessage(`❌ Error: ${err.message}`)
    } finally {
      setIsUpdating(false)
    }
  }

  return (
    <div className="max-w-sm rounded-2xl border border-[#d9e7f0] bg-white p-5 font-sans shadow-sm dark:border-slate-700 dark:bg-[#172b3d]">
      <h4 className="mb-2 text-sm font-bold text-[#172b3d] dark:text-white">
        Adjust Inventory: <span className="font-extrabold text-[#2f80c0]">{brandName}</span>
      </h4>
      
      <form onSubmit={handleStockSubmit} className="space-y-3">
        {/* Step 1: Input target volume */}
        <div>
          <label className="mb-1 block text-xs font-semibold text-[#607487] dark:text-slate-300">New Physical Stock Quantity</label>
          <input
            type="number"
            min="0"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-full rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-sm text-[#172b3d] focus:outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            required
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold text-[#607487] dark:text-slate-300">Single piece price</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={piecePrice}
            onChange={(e) => setPiecePrice(e.target.value)}
            className="w-full rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-sm text-[#172b3d] focus:outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            required
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold text-[#607487] dark:text-slate-300">Full box price</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={boxPrice}
            onChange={(e) => setBoxPrice(e.target.value)}
            className="w-full rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-sm text-[#172b3d] focus:outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            required
          />
        </div>

        <button
          type="submit"
          disabled={isUpdating}
          className="w-full rounded-xl bg-[#2f80c0] py-2 text-sm font-bold text-white shadow-sm transition-all hover:bg-[#18527f] disabled:bg-slate-300"
        >
          {isUpdating ? 'Saving Changes...' : 'Push New Stock Counts'}
        </button>
      </form>
      
      {message && (
          <p className={`mt-3 rounded-lg p-2 text-center text-xs font-semibold ${message.includes('✅') ? 'bg-[#e7f4fc] text-[#18527f]' : 'bg-[#fff0ef] text-[#b94f49]'}`}>
          {message}
        </p>
      )}
    </div>
  );
}
