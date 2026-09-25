import { useEffect, useState } from 'react'
import { createMedicine, updateMedicine } from '../api'

const emptyForm = {
  brandName: '',
  genericName: '',
  manufacturer: '',
  strength: '',
  singlePiecePrice: '0',
  fullBoxPrice: '0',
  availableQty: '0',
  batchNumber: '',
  expiryDate: '',
  reason: 'Initial stock on create',
}

export default function MedicineFormModal({ token, medicine, onClose, onSaved }) {
  const isEdit = Boolean(medicine?.id)
  const [form, setForm] = useState(emptyForm)
  const [error, setError] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      if (medicine) {
        setForm({
          ...emptyForm,
          brandName: medicine.brandName || '',
          genericName: medicine.genericName || '',
          manufacturer: medicine.manufacturer || '',
          strength: medicine.strength || '',
          singlePiecePrice: String(medicine.singlePiecePrice ?? 0),
          fullBoxPrice: String(medicine.fullBoxPrice ?? 0),
        })
      } else {
        setForm(emptyForm)
      }
    })
    return () => { cancelled = true }
  }, [medicine])

  const updateField = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    const singlePiecePrice = Number(form.singlePiecePrice)
    const fullBoxPrice = Number(form.fullBoxPrice)
    const availableQty = Number.parseInt(form.availableQty, 10)
    if (!form.brandName.trim() || !form.genericName.trim() || !form.manufacturer.trim() || !form.strength.trim()) {
      setError('All medicine fields are required.')
      return
    }
    if (!Number.isFinite(singlePiecePrice) || singlePiecePrice < 0 || !Number.isFinite(fullBoxPrice) || fullBoxPrice < 0) {
      setError('Prices must be non-negative numbers.')
      return
    }
    if (!isEdit && (!Number.isInteger(availableQty) || availableQty < 0)) {
      setError('Initial stock must be a non-negative whole number.')
      return
    }
    if (!isEdit && availableQty > 0 && !form.expiryDate.trim()) {
      setError('Expiry date is required when adding initial stock.')
      return
    }

    const payload = {
      brandName: form.brandName.trim(),
      genericName: form.genericName.trim(),
      manufacturer: form.manufacturer.trim(),
      strength: form.strength.trim(),
      singlePiecePrice,
      fullBoxPrice,
    }
    if (!isEdit) {
      payload.availableQty = availableQty
      if (availableQty > 0) {
        payload.batchNumber = form.batchNumber.trim() || undefined
        payload.expiryDate = form.expiryDate.trim()
        payload.reason = form.reason.trim() || 'Initial stock on create'
      }
    }

    try {
      setIsSaving(true)
      const saved = isEdit
        ? await updateMedicine(token, medicine.id, payload)
        : await createMedicine(token, payload)
      onSaved?.(saved)
      onClose?.()
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[#172b3d]/45 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-lg rounded-3xl border border-[#d9e7f0] bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-[#172b3d]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-extrabold">{isEdit ? 'Edit medicine' : 'Add medicine'}</h2>
            <p className="mt-1 text-sm text-[#607487]">
              {isEdit
                ? 'Update metadata and prices. Use Adjust stock for quantity changes.'
                : 'Creates the medicine in the database. Optional initial stock syncs to StockBatch.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm font-bold text-[#607487]">Close</button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {[
            ['brandName', 'Brand name'],
            ['genericName', 'Generic name'],
            ['manufacturer', 'Manufacturer'],
            ['strength', 'Strength'],
            ['singlePiecePrice', 'Piece price'],
            ['fullBoxPrice', 'Box price'],
          ].map(([field, label]) => (
            <label key={field} className="text-xs font-bold text-[#607487]">
              {label}
              <input
                className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-sm text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                type={field.includes('Price') ? 'number' : 'text'}
                min={field.includes('Price') ? '0' : undefined}
                step={field.includes('Price') ? '0.01' : undefined}
                value={form[field]}
                onChange={(event) => updateField(field, event.target.value)}
                required
              />
            </label>
          ))}
        </div>

        {!isEdit && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-bold text-[#607487]">
              Initial stock qty
              <input
                className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-sm text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                type="number"
                min="0"
                value={form.availableQty}
                onChange={(event) => updateField('availableQty', event.target.value)}
              />
            </label>
            <label className="text-xs font-bold text-[#607487]">
              Batch number
              <input
                className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-sm text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                value={form.batchNumber}
                onChange={(event) => updateField('batchNumber', event.target.value)}
              />
            </label>
            <label className="text-xs font-bold text-[#607487]">
              Expiry date {Number.parseInt(form.availableQty, 10) > 0 ? '(required)' : '(optional)'}
              <input
                className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-sm text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                type="date"
                value={form.expiryDate}
                onChange={(event) => updateField('expiryDate', event.target.value)}
                required={Number.parseInt(form.availableQty, 10) > 0}
              />
            </label>
            <label className="text-xs font-bold text-[#607487]">
              Stock reason
              <input
                className="mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-2 text-sm text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                value={form.reason}
                maxLength={200}
                onChange={(event) => updateField('reason', event.target.value)}
              />
            </label>
          </div>
        )}

        {error && <p className="mt-4 rounded-xl bg-[#fff0ef] p-3 text-sm font-semibold text-[#b94f49]">{error}</p>}
        <button type="submit" disabled={isSaving} className="mt-5 w-full rounded-xl bg-[#2f80c0] px-4 py-3 font-bold text-white hover:bg-[#18527f] disabled:opacity-60">
          {isSaving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create medicine')}
        </button>
      </form>
    </div>
  )
}
