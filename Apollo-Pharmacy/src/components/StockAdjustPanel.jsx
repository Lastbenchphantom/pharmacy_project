import { useEffect, useState } from 'react'
import { adjustStock, updateBatch } from '../api'

export default function StockAdjustPanel({
  token,
  medicine,
  batch,
  onClose,
  onSaved,
}) {
  const currentQty = batch ? Number(batch.quantity || 0) : Number(medicine?.availableQty || 0)
  const [absoluteQty, setAbsoluteQty] = useState(String(currentQty))
  const [reason, setReason] = useState('')
  const [batchNumber, setBatchNumber] = useState(batch?.batchNumber || '')
  const [expiryDate, setExpiryDate] = useState(batch?.expiryDate ? String(batch.expiryDate).slice(0, 10) : '')
  const [error, setError] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setAbsoluteQty(String(currentQty))
      setBatchNumber(batch?.batchNumber || '')
      setExpiryDate(batch?.expiryDate ? String(batch.expiryDate).slice(0, 10) : '')
      setReason('')
      setError('')
    })
    return () => { cancelled = true }
  }, [medicine?.id, batch?.id, currentQty, batch?.batchNumber, batch?.expiryDate])

  const nextQty = Number.parseInt(absoluteQty, 10)
  const isIncrease = Number.isInteger(nextQty) && nextQty > currentQty
  const dropAmount = Number.isInteger(nextQty) ? currentQty - nextQty : 0

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    if (!Number.isInteger(nextQty) || nextQty < 0) {
      setError('Enter a valid non-negative quantity.')
      return
    }
    if (!reason.trim() || reason.trim().length > 200) {
      setError('Reason is required (max 200 characters).')
      return
    }
    if (isIncrease && !expiryDate.trim()) {
      setError('Expiry date is required when adding stock')
      return
    }
    if (dropAmount >= 20 || (currentQty > 0 && dropAmount / currentQty >= 0.5)) {
      if (!window.confirm(`Reduce stock from ${currentQty} to ${nextQty}?`)) return
    }

    try {
      setIsSaving(true)
      if (batch?.id) {
        await updateBatch(token, batch.id, {
          quantity: nextQty,
          batchNumber: batchNumber.trim() || null,
          expiryDate: expiryDate.trim() || undefined,
          reason: reason.trim(),
        })
      } else {
        await adjustStock(token, {
          medicineId: medicine.id,
          absoluteQty: nextQty,
          reason: reason.trim(),
          batchNumber: batchNumber.trim() || undefined,
          expiryDate: expiryDate.trim() || undefined,
        })
      }
      onSaved?.()
      onClose?.()
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setIsSaving(false)
    }
  }

  if (!medicine && !batch) return null

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[#172b3d]/45 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-md rounded-3xl border border-[#d9e7f0] bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-[#172b3d]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-extrabold">{batch ? 'Edit batch' : 'Adjust stock'}</h2>
            <p className="mt-1 text-sm text-[#607487]">
              {batch ? `${batch.brandName || medicine?.brandName || ''} · ${batch.batchNumber || 'No batch #'}` : medicine?.brandName}
            </p>
            <p className="mt-1 text-xs text-[#607487]">Current quantity: <strong>{currentQty}</strong></p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm font-bold text-[#607487]">Close</button>
        </div>

        <label className="mt-5 block text-xs font-bold text-[#607487]">
          New quantity (absolute)
          <input
            className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            type="number"
            min="0"
            value={absoluteQty}
            onChange={(event) => setAbsoluteQty(event.target.value)}
            required
          />
        </label>

        <label className="mt-3 block text-xs font-bold text-[#607487]">
          Reason (required)
          <input
            className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </label>

        <label className="mt-3 block text-xs font-bold text-[#607487]">
          Batch number (recommended)
          <input
            className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            value={batchNumber}
            onChange={(event) => setBatchNumber(event.target.value)}
          />
        </label>

        <label className="mt-3 block text-xs font-bold text-[#607487]">
          Expiry date{isIncrease ? ' (required when adding stock)' : ''}
          <input
            className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            type="date"
            value={expiryDate}
            onChange={(event) => setExpiryDate(event.target.value)}
            required={isIncrease}
          />
        </label>
        {isIncrease && (
          <p className="mt-2 text-xs font-semibold text-[#795f00]">Expiry date is required when adding stock</p>
        )}

        {error && <p className="mt-4 rounded-xl bg-[#fff0ef] p-3 text-sm font-semibold text-[#b94f49]">{error}</p>}
        <button type="submit" disabled={isSaving} className="mt-5 w-full rounded-xl bg-[#2f80c0] px-4 py-3 font-bold text-white hover:bg-[#18527f] disabled:opacity-60">
          {isSaving ? 'Saving…' : 'Save stock change'}
        </button>
      </form>
    </div>
  )
}
