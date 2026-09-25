import { useEffect, useState } from 'react'
import {
  confirmStockReceipt,
  getMedicines,
  getStockReceipt,
  processStockReceipt,
  uploadStockReceipt,
} from '../api'

const TOKEN_KEY = 'apollo-admin-token'
const MAX_FILE_SIZE = 10 * 1024 * 1024

const steps = [
  ['upload', '1. Upload Receipt'],
  ['processing', '2. AI Processing'],
  ['review', '3. Review and Confirm'],
  ['success', '4. Stock Updated'],
]

const mapReceiptRows = (items) => items.map((item) => ({
  ...item,
  quantity: item.quantity ?? '',
  batchNumber: item.batchNumber || '',
  expiryDate: item.expiryDate ? String(item.expiryDate).slice(0, 10) : '',
}))

function MedicineTypeahead({ value, label, onSelect }) {
  const [query, setQuery] = useState(label || '')
  const [options, setOptions] = useState([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setQuery(label || '')
  }, [label, value])

  useEffect(() => {
    const search = query.trim()
    if (search.length < 2) {
      setOptions([])
      return undefined
    }
    let cancelled = false
    const timer = setTimeout(() => {
      getMedicines({ limit: 15, search })
        .then((medicines) => { if (!cancelled) setOptions(medicines) })
        .catch(() => { if (!cancelled) setOptions([]) })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  return (
    <div className="relative">
      <input
        className="w-56 rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-[#172b3d]"
        value={query}
        placeholder="Search medicine…"
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
          if (!event.target.value.trim()) onSelect(null)
        }}
        onFocus={() => setOpen(true)}
      />
      {open && options.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-48 w-64 overflow-auto rounded-lg border border-[#d9e7f0] bg-white shadow-lg">
          {options.map((medicine) => (
            <button
              key={medicine.id}
              type="button"
              className="block w-full border-b border-[#d9e7f0] px-3 py-2 text-left text-sm last:border-0 hover:bg-[#e7f4fc]"
              onClick={() => {
                onSelect(medicine)
                setQuery(`${medicine.brandName} · ${medicine.strength}`)
                setOpen(false)
              }}
            >
              <strong className="block">{medicine.brandName}</strong>
              <span className="text-xs text-[#607487]">{medicine.genericName} · {medicine.strength}</span>
            </button>
          ))}
        </div>
      )}
      {value && <p className="mt-1 text-xs text-[#607487]">Matched</p>}
      {!value && <p className="mt-1 text-xs text-[#607487]">Needs manual matching</p>}
    </div>
  )
}

export default function ReceiptStockPage() {
  const [token] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [status, setStatus] = useState('upload')
  const [receipt, setReceipt] = useState(null)
  const [rows, setRows] = useState([])
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [isWorking, setIsWorking] = useState(false)
  const [bootstrapping, setBootstrapping] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return Boolean(params.get('receiptId'))
  })

  useEffect(() => {
    if (!file) {
      setPreviewUrl('')
      return undefined
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    if (!token) return undefined
    const params = new URLSearchParams(window.location.search)
    const receiptId = params.get('receiptId')
    if (!receiptId) {
      setBootstrapping(false)
      return undefined
    }

    let cancelled = false
    setBootstrapping(true)
    setError('')
    getStockReceipt(token, receiptId)
      .then(async (loaded) => {
        if (cancelled) return
        setReceipt(loaded)
        if (loaded.status === 'READY_FOR_REVIEW') {
          setRows(mapReceiptRows(loaded.items || []))
          setStatus('review')
          return
        }
        if (loaded.status === 'CONFIRMED') {
          setStatus('success')
          setResult({
            updated: [],
            skipped: [],
            alreadyConfirmed: true,
          })
          setError('This receipt is already confirmed.')
          return
        }
        if (loaded.status === 'FAILED' || loaded.status === 'PROCESSING') {
          setStatus('processing')
          setIsWorking(true)
          try {
            const processed = await processStockReceipt(token, receiptId)
            if (cancelled) return
            setReceipt(processed)
            setRows(mapReceiptRows(processed.items || []))
            setStatus('review')
          } catch (processError) {
            if (cancelled) return
            setError(processError.message || loaded.errorMessage || 'Receipt processing failed.')
            setStatus('upload')
          } finally {
            if (!cancelled) setIsWorking(false)
          }
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError.message)
          setStatus('upload')
        }
      })
      .finally(() => {
        if (!cancelled) setBootstrapping(false)
      })

    return () => {
      cancelled = true
    }
  }, [token])

  const handleFileChange = (event) => {
    const selectedFile = event.target.files?.[0]
    setError('')
    setResult(null)
    if (!selectedFile) return
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(selectedFile.type)) {
      setError('Choose a JPG, PNG, or PDF receipt.')
      return
    }
    if (selectedFile.size > MAX_FILE_SIZE) {
      setError('Receipt files must be 10 MB or smaller.')
      return
    }
    setFile(selectedFile)
    setStatus('upload')
    setReceipt(null)
    setRows([])
  }

  const startProcessing = async () => {
    if (!file) {
      setError('Select a receipt before processing.')
      return
    }
    setIsWorking(true)
    setError('')
    setStatus('processing')
    try {
      const uploaded = await uploadStockReceipt(token, file)
      const processed = await processStockReceipt(token, uploaded.receiptId)
      setReceipt(processed)
      setRows(mapReceiptRows(processed.items))
      setStatus('review')
    } catch (processingError) {
      setError(processingError.message || 'Receipt processing failed.')
      setStatus('upload')
    } finally {
      setIsWorking(false)
    }
  }

  const updateRow = (id, field, value) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)))
  }

  const selectMedicine = (row, medicine) => {
    setRows((current) => current.map((item) => (item.id === row.id
      ? {
        ...item,
        matchedMedicineId: medicine?.id || null,
        matchStatus: medicine ? 'MATCHED' : 'NEEDS_MANUAL',
        currentStock: medicine?.availableQty ?? item.currentStock,
        matchedBrandName: medicine?.brandName,
        matchedStrength: medicine?.strength,
      }
      : item)))
  }

  const confirm = async () => {
    const selectedRows = rows.filter((row) => row.matchedMedicineId && Number.isInteger(Number(row.quantity)) && Number(row.quantity) > 0)
    if (selectedRows.length === 0) {
      setError('Match at least one medicine and enter a positive quantity before confirming.')
      return
    }
    const missingExpiry = selectedRows.filter((row) => !String(row.expiryDate || '').trim())
    if (missingExpiry.length > 0) {
      setError('Enter expiry date for all items you are confirming')
      return
    }
    setIsWorking(true)
    setError('')
    try {
      const confirmed = await confirmStockReceipt(token, receipt.id, selectedRows.map((row) => ({
        id: row.id,
        medicineId: row.matchedMedicineId,
        medicineName: row.medicineName,
        quantity: Number(row.quantity),
        batchNumber: row.batchNumber || null,
        expiryDate: row.expiryDate,
      })))
      setResult(confirmed)
      setStatus('success')
      setReceipt((current) => ({ ...current, status: 'CONFIRMED' }))
    } catch (confirmError) {
      setError(confirmError.message)
    } finally {
      setIsWorking(false)
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
            <h1 className="mt-2 text-4xl font-extrabold">Update stock from receipt</h1>
            <p className="mt-2 text-[#607487] dark:text-slate-300">AI prepares the review. Expiry is required before stock increases.</p>
          </div>
        </header>

        <nav className="mt-8 grid gap-2 sm:grid-cols-4" aria-label="Receipt workflow">
          {steps.map(([step, label]) => (
            <div key={step} className={`rounded-xl border px-4 py-3 text-sm font-bold ${status === step ? 'border-[#2f80c0] bg-[#e7f4fc] text-[#18527f]' : 'border-[#d9e7f0] bg-white text-[#607487] dark:border-slate-700 dark:bg-[#172b3d]'}`}>{label}</div>
          ))}
        </nav>

        {error && <p className="mt-6 rounded-xl bg-[#fff0ef] p-4 font-semibold text-[#b94f49]">{error}</p>}

        {bootstrapping && (
          <section className="mt-8 rounded-3xl border border-[#d9e7f0] bg-white p-12 text-center dark:border-slate-700 dark:bg-[#172b3d]">
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-[#d9e7f0] border-t-[#2f80c0]" />
            <h2 className="mt-6 text-2xl font-extrabold">Loading receipt…</h2>
          </section>
        )}

        {!bootstrapping && status === 'upload' && (
          <section className="mt-8 grid gap-6 lg:grid-cols-[.8fr_1.2fr]">
            <div className="rounded-3xl border border-[#d9e7f0] bg-white p-6 shadow-lg shadow-[#18527f]/5 dark:border-slate-700 dark:bg-[#172b3d]">
              <h2 className="text-2xl font-extrabold">Upload purchase receipt</h2>
              <p className="mt-2 text-sm text-[#607487] dark:text-slate-300">JPG, PNG, and PDF files up to 10 MB are supported.</p>
              <label className="mt-6 block cursor-pointer rounded-2xl border-2 border-dashed border-[#2f80c0] bg-[#f4f9fc] p-8 text-center dark:bg-slate-800">
                <span className="block font-bold text-[#18527f] dark:text-[#bfe4fb]">Choose receipt file</span>
                <span className="mt-2 block text-sm text-[#607487]">or capture one with your device camera</span>
                <input className="sr-only" type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" capture="environment" onChange={handleFileChange} />
              </label>
              {file && <div className="mt-4 rounded-xl bg-[#e7f4fc] p-3 text-sm font-semibold text-[#18527f]">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</div>}
              <button type="button" disabled={!file || isWorking} onClick={startProcessing} className="mt-5 w-full rounded-xl bg-[#2f80c0] px-5 py-3 font-bold text-white hover:bg-[#18527f] disabled:cursor-not-allowed disabled:opacity-50">
                {isWorking ? 'Processing receipt...' : 'Process receipt with AI'}
              </button>
            </div>
            <div className="rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
              <h2 className="text-2xl font-extrabold">Receipt preview</h2>
              <div className="mt-4 grid min-h-80 place-items-center overflow-hidden rounded-2xl bg-[#f4f9fc] dark:bg-slate-800">
                {!previewUrl && <p className="p-6 text-center text-[#607487]">Your receipt preview will appear here.</p>}
                {previewUrl && file?.type === 'application/pdf' && <iframe className="h-[520px] w-full" title="Receipt preview" src={previewUrl} />}
                {previewUrl && file?.type !== 'application/pdf' && <img className="max-h-[520px] max-w-full object-contain" src={previewUrl} alt="Selected receipt preview" />}
              </div>
            </div>
          </section>
        )}

        {!bootstrapping && status === 'processing' && (
          <section className="mt-8 rounded-3xl border border-[#d9e7f0] bg-white p-12 text-center shadow-lg shadow-[#18527f]/5 dark:border-slate-700 dark:bg-[#172b3d]">
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-[#d9e7f0] border-t-[#2f80c0]" />
            <h2 className="mt-6 text-2xl font-extrabold">Reading your receipt</h2>
            <p className="mt-2 text-[#607487] dark:text-slate-300">Extracting medicines and matching them against live stock. Stock has not changed.</p>
          </section>
        )}

        {!bootstrapping && status === 'review' && receipt && (
          <section className="mt-8 rounded-3xl border border-[#d9e7f0] bg-white p-5 shadow-lg shadow-[#18527f]/5 dark:border-slate-700 dark:bg-[#172b3d]">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-extrabold">Review extracted medicines</h2>
                <p className="mt-2 text-sm text-[#607487] dark:text-slate-300">{receipt.fileName}</p>
              </div>
              <div className="rounded-xl bg-[#fff8df] p-3 text-sm font-bold text-[#795f00]">Stock has NOT been updated yet. Expiry is required for every confirmed line.</div>
            </div>
            <div className="mt-5 overflow-x-auto">
              <table className="min-w-[1180px] w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[#d9e7f0] text-xs uppercase tracking-wide text-[#607487]">
                    <th className="p-3">Medicine</th>
                    <th className="p-3">Qty</th>
                    <th className="p-3">Matched medicine</th>
                    <th className="p-3">Batch</th>
                    <th className="p-3">Expiry</th>
                    <th className="p-3">Current</th>
                    <th className="p-3">New</th>
                    <th className="p-3">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const lowConfidence = row.matchStatus !== 'MATCHED' || Number(row.confidence) < 0.75 || !row.quantity || !row.expiryDate
                    const matchedLabel = row.matchedMedicineId
                      ? `${row.matchedBrandName || row.medicineName}${row.matchedStrength ? ` · ${row.matchedStrength}` : ''}`
                      : ''
                    return (
                      <tr key={row.id} className={`border-b border-[#d9e7f0] align-top dark:border-slate-700 ${lowConfidence ? 'bg-[#fff8df]' : ''}`}>
                        <td className="p-3">
                          <input className="w-48 rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-[#172b3d]" value={row.medicineName} onChange={(event) => updateRow(row.id, 'medicineName', event.target.value)} />
                          <p className="mt-1 text-xs text-[#607487]">{[row.strength, row.dosageForm, row.packSize].filter(Boolean).join(' · ') || 'Details not readable'}</p>
                        </td>
                        <td className="p-3">
                          <input className="w-24 rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-[#172b3d]" type="number" min="1" value={row.quantity} onChange={(event) => updateRow(row.id, 'quantity', event.target.value === '' ? '' : Number(event.target.value))} />
                        </td>
                        <td className="p-3">
                          <MedicineTypeahead
                            value={row.matchedMedicineId}
                            label={matchedLabel}
                            onSelect={(medicine) => selectMedicine(row, medicine)}
                          />
                        </td>
                        <td className="p-3">
                          <input className="w-28 rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-[#172b3d]" value={row.batchNumber} onChange={(event) => updateRow(row.id, 'batchNumber', event.target.value)} placeholder="Batch #" />
                        </td>
                        <td className="p-3">
                          <input className="w-36 rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-[#172b3d]" type="date" value={row.expiryDate} onChange={(event) => updateRow(row.id, 'expiryDate', event.target.value)} />
                        </td>
                        <td className="p-3 font-bold">{row.currentStock ?? '—'}</td>
                        <td className="p-3 font-bold">{Number.isInteger(Number(row.currentStock)) && Number.isInteger(Number(row.quantity)) ? Number(row.currentStock) + Number(row.quantity) : '—'}</td>
                        <td className="p-3">
                          <span className={`rounded-full px-2 py-1 text-xs font-bold ${lowConfidence ? 'bg-[#ffe6b3] text-[#795f00]' : 'bg-[#d9f3e6] text-[#17683b]'}`}>
                            {Math.round(Number(row.confidence || 0) * 100)}%{lowConfidence ? ' · Review' : ''}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-[#607487]">Unmatched or skipped rows will not change stock. Confirmed rows need expiry dates.</p>
              <button type="button" disabled={isWorking} onClick={confirm} className="rounded-xl bg-[#2f80c0] px-6 py-3 font-bold text-white hover:bg-[#18527f] disabled:cursor-wait disabled:opacity-50">
                {isWorking ? 'Confirming...' : 'Confirm Stock Update'}
              </button>
            </div>
          </section>
        )}

        {!bootstrapping && status === 'success' && result && (
          <section className="mt-8 rounded-3xl border border-[#b9e5ca] bg-white p-6 shadow-lg dark:border-[#3b8c5a] dark:bg-[#172b3d]">
            <h2 className="text-2xl font-extrabold text-[#17683b]">Stock updated successfully</h2>
            <p className="mt-2 text-[#607487] dark:text-slate-300">
              {result.updated.length} medicine{result.updated.length === 1 ? '' : 's'} updated.
              {typeof result.expiringItemCount === 'number' && result.expiringItemCount > 0
                ? ` ${result.expiringItemCount} confirmed item(s) expire within the warning window.`
                : ''}
            </p>
            <div className="mt-5 grid gap-3">
              {result.updated.map((item) => (
                <div key={`${item.medicineId}-${item.expiryDate || ''}`} className="rounded-xl bg-[#f4f9fc] p-4 dark:bg-slate-800">
                  <strong>{item.medicineId}</strong>
                  <span className="ml-3 text-sm text-[#607487]">
                    Previous {item.previousStock} · Added {item.quantityAdded} · New {item.newStock}
                    {item.expiryDate ? ` · Expiry ${item.expiryDate}` : ''}
                    {item.batchNumber ? ` · Batch ${item.batchNumber}` : ''}
                  </span>
                </div>
              ))}
            </div>
            {result.skipped?.length > 0 && (
              <div className="mt-5 rounded-xl bg-[#fff8df] p-4 text-sm font-semibold text-[#795f00]">
                <strong>Skipped items:</strong> {result.skipped.map((item) => `${item.medicineName} (${item.reason})`).join(', ')}
              </div>
            )}
            <a href="/admin" className="mt-6 inline-block rounded-xl bg-[#2f80c0] px-5 py-3 font-bold text-white">Back to operations</a>
          </section>
        )}
      </div>
    </main>
  )
}
