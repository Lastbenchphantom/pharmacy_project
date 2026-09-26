import { useEffect, useState } from 'react'
import { createMedicine, findSimilarMedicines, updateMedicine } from '../api'

export const DOSAGE_FORMS = [
  'Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Saline',
  'Cream', 'Ointment', 'Drops', 'Inhaler', 'Powder', 'Sachet', 'Other',
]

const emptyForm = {
  brandName: '',
  genericName: '',
  manufacturer: '',
  strength: '',
  dosageForm: 'Tablet',
  description: '',
  singlePiecePrice: '0',
  fullBoxPrice: '0',
  purchasePrice: '',
  availableQty: '0',
  batchNumber: '',
  expiryDate: '',
  reason: 'Initial stock on create',
}

const fieldClass = 'mt-1 w-full rounded-lg border border-[#d9e7f0] bg-[#f4f9fc] px-3 py-3 text-base text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white'

export default function MedicineFormModal({ token, medicine, onClose, onSaved }) {
  const isEdit = Boolean(medicine?.id)
  const [form, setForm] = useState(emptyForm)
  const [error, setError] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [similar, setSimilar] = useState([])
  const [forceCreate, setForceCreate] = useState(false)

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
          dosageForm: medicine.dosageForm || medicine.type || 'Tablet',
          description: medicine.description || '',
          singlePiecePrice: String(medicine.singlePiecePrice ?? medicine.sellingPrice ?? 0),
          fullBoxPrice: String(medicine.fullBoxPrice ?? medicine.singlePiecePrice ?? 0),
        })
      } else {
        setForm(emptyForm)
      }
      setSimilar([])
      setForceCreate(false)
      setError('')
    })
    return () => { cancelled = true }
  }, [medicine])

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }))
    if (!isEdit) setForceCreate(false)
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    const singlePiecePrice = Number(form.singlePiecePrice)
    const fullBoxPrice = Number(form.fullBoxPrice)
    const purchasePrice = form.purchasePrice === '' ? null : Number(form.purchasePrice)
    const availableQty = Number.parseInt(form.availableQty, 10)

    if (!form.brandName.trim()) {
      setError('Medicine/brand name is required.')
      return
    }
    if (!form.dosageForm) {
      setError('Type/category is required.')
      return
    }
    if (!Number.isFinite(singlePiecePrice) || singlePiecePrice < 0 || !Number.isFinite(fullBoxPrice) || fullBoxPrice < 0) {
      setError('Prices must be non-negative numbers.')
      return
    }
    if (purchasePrice != null && (!Number.isFinite(purchasePrice) || purchasePrice < 0)) {
      setError('Purchase price must be a non-negative number.')
      return
    }
    if (!isEdit && (!Number.isInteger(availableQty) || availableQty < 0)) {
      setError('Initial quantity must be a non-negative whole number.')
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
      dosageForm: form.dosageForm,
      description: form.description.trim() || null,
      singlePiecePrice,
      fullBoxPrice,
      sellingPrice: singlePiecePrice,
    }
    if (!isEdit) {
      payload.availableQty = availableQty
      payload.purchasePrice = purchasePrice
      payload.forceCreate = forceCreate
      if (availableQty > 0) {
        payload.batchNumber = form.batchNumber.trim() || undefined
        payload.expiryDate = form.expiryDate.trim()
        payload.reason = form.reason.trim() || 'Initial stock on create'
      }
    }

    try {
      setIsSaving(true)
      if (!isEdit && !forceCreate) {
        const check = await findSimilarMedicines(token, {
          brandName: payload.brandName,
          genericName: payload.genericName,
          strength: payload.strength,
          manufacturer: payload.manufacturer,
          dosageForm: payload.dosageForm,
        })
        if (check.similar.length > 0) {
          setSimilar(check.similar)
          setError('Similar medicine already exists. Select one below, or create anyway.')
          return
        }
      }

      const saved = isEdit
        ? await updateMedicine(token, medicine.id, payload)
        : await createMedicine(token, payload)
      onSaved?.(saved)
      onClose?.()
    } catch (saveError) {
      if (saveError.status === 409 && saveError.data?.similar?.length) {
        setSimilar(saveError.data.similar)
        setError(saveError.data.message || 'Similar medicine already exists')
      } else {
        setError(saveError.message)
      }
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[#172b3d]/45 p-3 sm:p-4">
      <form onSubmit={handleSubmit} className="max-h-[95vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-[#d9e7f0] bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-[#172b3d] sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-extrabold">{isEdit ? 'Edit medicine' : 'Add medicine'}</h2>
            <p className="mt-1 text-sm text-[#607487]">
              {isEdit
                ? 'Update metadata and selling prices. Use Add Stock for quantity.'
                : 'Creates the medicine and optional initial stock batch.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm font-bold text-[#607487]">Close</button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-bold text-[#607487] sm:col-span-2">
            Medicine / brand name *
            <input className={fieldClass} value={form.brandName} onChange={(e) => updateField('brandName', e.target.value)} required />
          </label>
          <label className="text-xs font-bold text-[#607487]">
            Generic name
            <input className={fieldClass} value={form.genericName} onChange={(e) => updateField('genericName', e.target.value)} />
          </label>
          <label className="text-xs font-bold text-[#607487]">
            Type / category *
            <select className={fieldClass} value={form.dosageForm} onChange={(e) => updateField('dosageForm', e.target.value)} required>
              {DOSAGE_FORMS.map((formName) => <option key={formName} value={formName}>{formName}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold text-[#607487]">
            Strength
            <input className={fieldClass} value={form.strength} onChange={(e) => updateField('strength', e.target.value)} placeholder="500mg" />
          </label>
          <label className="text-xs font-bold text-[#607487]">
            Manufacturer
            <input className={fieldClass} value={form.manufacturer} onChange={(e) => updateField('manufacturer', e.target.value)} />
          </label>
          <label className="text-xs font-bold text-[#607487]">
            Selling price *
            <input className={fieldClass} type="number" min="0" step="0.01" value={form.singlePiecePrice} onChange={(e) => updateField('singlePiecePrice', e.target.value)} required />
          </label>
          <label className="text-xs font-bold text-[#607487]">
            Box price
            <input className={fieldClass} type="number" min="0" step="0.01" value={form.fullBoxPrice} onChange={(e) => updateField('fullBoxPrice', e.target.value)} />
          </label>
          {!isEdit && (
            <label className="text-xs font-bold text-[#607487]">
              Purchase price
              <input className={fieldClass} type="number" min="0" step="0.01" value={form.purchasePrice} onChange={(e) => updateField('purchasePrice', e.target.value)} />
            </label>
          )}
          <label className="text-xs font-bold text-[#607487] sm:col-span-2">
            Description
            <textarea className={fieldClass} rows={2} value={form.description} onChange={(e) => updateField('description', e.target.value)} />
          </label>
        </div>

        {!isEdit && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-bold text-[#607487]">
              Initial quantity *
              <input className={fieldClass} type="number" min="0" value={form.availableQty} onChange={(e) => updateField('availableQty', e.target.value)} />
            </label>
            <label className="text-xs font-bold text-[#607487]">
              Batch number
              <input className={fieldClass} value={form.batchNumber} onChange={(e) => updateField('batchNumber', e.target.value)} />
            </label>
            <label className="text-xs font-bold text-[#607487] sm:col-span-2">
              Expiry date {Number.parseInt(form.availableQty, 10) > 0 ? '*' : '(optional)'}
              <input
                className={fieldClass}
                type="date"
                value={form.expiryDate}
                onChange={(e) => updateField('expiryDate', e.target.value)}
                required={Number.parseInt(form.availableQty, 10) > 0}
              />
            </label>
          </div>
        )}

        {similar.length > 0 && (
          <div className="mt-4 rounded-xl border border-[#f0d48a] bg-[#fff8df] p-3">
            <p className="text-sm font-bold text-[#795f00]">Similar medicine already exists</p>
            <ul className="mt-2 space-y-2">
              {similar.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="w-full rounded-lg bg-white px-3 py-2 text-left text-sm"
                    onClick={() => {
                      onSaved?.(item)
                      onClose?.()
                    }}
                  >
                    <strong className="block">{item.brandName}</strong>
                    <span className="text-xs text-[#607487]">
                      {[item.genericName, item.strength, item.dosageForm, item.manufacturer].filter(Boolean).join(' · ')}
                      {' · Qty '}{item.availableQty}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="mt-3 text-sm font-bold text-[#18527f]"
              onClick={() => {
                setForceCreate(true)
                setError('')
              }}
            >
              + Create new medicine anyway
            </button>
            {forceCreate && <p className="mt-1 text-xs font-semibold text-[#17683b]">Will create a new record on next save.</p>}
          </div>
        )}

        {error && <p className="mt-4 rounded-xl bg-[#fff0ef] p-3 text-sm font-semibold text-[#b94f49]">{error}</p>}
        <button type="submit" disabled={isSaving} className="mt-5 w-full rounded-xl bg-[#2f80c0] px-4 py-3 font-bold text-white hover:bg-[#18527f] disabled:opacity-60">
          {isSaving ? 'Saving…' : (isEdit ? 'Save changes' : (forceCreate ? 'Create new medicine' : 'Create medicine'))}
        </button>
      </form>
    </div>
  )
}
