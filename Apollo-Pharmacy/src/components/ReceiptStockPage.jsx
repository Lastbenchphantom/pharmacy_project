import { useEffect, useRef, useState } from 'react'
import {
  confirmStockReceipt,
  getMedicines,
  getStockReceipt,
  processStockReceipt,
  retryStockReceipt,
  uploadStockReceipt,
} from '../api'
import { DOSAGE_FORMS } from './MedicineFormModal'

const TOKEN_KEY = 'apollo-admin-token'
const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_CLIENT_RETRIES = 3
const POLL_INTERVAL_MS = 2500
const POLL_TIMEOUT_MS = 90_000

const steps = [
  ['upload', '1. Upload Receipt'],
  ['processing', '2. OCR Extraction'],
  ['review', '3. Review and Confirm'],
  ['success', '4. Stock Updated'],
]

const fieldClass = 'mt-1 w-full rounded-xl border border-[#d9e7f0] bg-white px-3 py-3 text-base text-[#172b3d] dark:border-slate-600 dark:bg-slate-800 dark:text-white'

const humanizeReceiptError = (message) => {
  const text = String(message || '').trim()
  if (!text) return 'Receipt processing failed. Please try again.'
  if (/timed out|timeout|took too long/i.test(text)) {
    return 'Receipt processing took too long. Please try again.'
  }
  if (/scanned pdf ocr|scanned\/image-only pdf/i.test(text)) {
    return 'Scanned PDF OCR is not currently supported. Please upload the receipt as JPG or PNG.'
  }
  return text
}

const mapReceiptRows = (items) => items.map((item) => ({
  id: item.id,
  medicineName: item.medicineName || item.productName || item.brandName || '',
  genericName: item.genericName || '',
  dosageForm: item.dosageForm || item.type || '',
  strength: item.strength || '',
  manufacturer: item.manufacturer || '',
  quantity: item.quantity ?? '',
  unitPrice: item.unitPrice ?? '',
  totalPrice: item.totalPrice ?? '',
  batchNumber: item.batchNumber || '',
  expiryDate: item.expiryDate ? String(item.expiryDate).slice(0, 10) : '',
  matchedMedicineId: item.matchedMedicineId || null,
  matchedBrandName: item.matchedBrandName || '',
  matchedStrength: item.matchedStrength || '',
  currentStock: item.currentStock,
  createNew: false,
  include: true,
}))

function MedicinePicker({ value, label, createNew, onSelect, onCreateNew }) {
  const [query, setQuery] = useState(label || '')
  const [options, setOptions] = useState([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setQuery(createNew ? '' : (label || ''))
    })
    return () => { cancelled = true }
  }, [label, value, createNew])

  useEffect(() => {
    const search = query.trim()
    if (createNew || search.length < 2) {
      let cancelled = false
      queueMicrotask(() => { if (!cancelled) setOptions([]) })
      return () => { cancelled = true }
    }
    let cancelled = false
    const timer = setTimeout(() => {
      getMedicines({ limit: 15, search, includeInactive: true })
        .then((medicines) => { if (!cancelled) setOptions(medicines) })
        .catch(() => { if (!cancelled) setOptions([]) })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, createNew])

  return (
    <div className="relative">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`rounded-lg px-3 py-2 text-xs font-bold ${!createNew ? 'bg-[#2f80c0] text-white' : 'border border-[#d9e7f0] bg-white text-[#18527f]'}`}
          onClick={() => onCreateNew(false)}
        >
          Select existing
        </button>
        <button
          type="button"
          className={`rounded-lg px-3 py-2 text-xs font-bold ${createNew ? 'bg-[#2f80c0] text-white' : 'border border-[#d9e7f0] bg-white text-[#18527f]'}`}
          onClick={() => onCreateNew(true)}
        >
          + Create new medicine
        </button>
      </div>
      {!createNew && (
        <>
          <input
            className={`${fieldClass} mt-2`}
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
            <div className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-xl border border-[#d9e7f0] bg-white shadow-lg dark:border-slate-600 dark:bg-[#172b3d]">
              {options.map((medicine) => (
                <button
                  key={medicine.id}
                  type="button"
                  className="block w-full border-b border-[#d9e7f0] px-3 py-3 text-left text-sm last:border-0 hover:bg-[#e7f4fc] dark:border-slate-700"
                  onClick={() => {
                    onSelect(medicine)
                    setQuery(`${medicine.brandName}${medicine.strength ? ` · ${medicine.strength}` : ''}`)
                    setOpen(false)
                  }}
                >
                  <strong className="block">{medicine.brandName}</strong>
                  <span className="text-xs text-[#607487]">
                    {[medicine.genericName, medicine.strength, medicine.dosageForm].filter(Boolean).join(' · ')}
                    {' · Qty '}{medicine.availableQty}
                  </span>
                </button>
              ))}
            </div>
          )}
          {value
            ? <p className="mt-1 text-xs font-semibold text-[#17683b]">Selected existing medicine</p>
            : <p className="mt-1 text-xs text-[#795f00]">Select a medicine or create new</p>}
        </>
      )}
      {createNew && (
        <p className="mt-2 rounded-lg bg-[#e7f4fc] px-3 py-2 text-xs font-semibold text-[#18527f]">
          A new medicine will be created from the fields above when you confirm.
        </p>
      )}
    </div>
  )
}

export default function ReceiptStockPage() {
  const [token] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [status, setStatus] = useState('upload')
  const [receipt, setReceipt] = useState(null)
  const [receiptMeta, setReceiptMeta] = useState({
    supplierName: '',
    invoiceNumber: '',
    purchaseDate: '',
    subtotal: '',
    discount: '',
    tax: '',
    total: '',
  })
  const [rows, setRows] = useState([])
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [isWorking, setIsWorking] = useState(false)
  const [bootstrapping, setBootstrapping] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return Boolean(params.get('receiptId'))
  })
  const [retryCount, setRetryCount] = useState(0)
  const pollTimerRef = useRef(null)
  const processingRef = useRef(false)

  const clearPoll = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }

  useEffect(() => {
    if (!file) {
      let cancelled = false
      queueMicrotask(() => { if (!cancelled) setPreviewUrl('') })
      return () => { cancelled = true }
    }
    const url = URL.createObjectURL(file)
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) setPreviewUrl(url) })
    return () => {
      cancelled = true
      URL.revokeObjectURL(url)
    }
  }, [file])

  const applyReadyReceipt = (processed) => {
    setReceipt(processed)
    setReceiptMeta({
      supplierName: processed.supplierName || '',
      invoiceNumber: processed.invoiceNumber || '',
      purchaseDate: processed.purchaseDate || '',
      subtotal: processed.subtotal ?? '',
      discount: processed.discount ?? '',
      tax: processed.tax ?? '',
      total: processed.total ?? '',
    })
    setRows(mapReceiptRows(processed.items || []))
    setStatus('review')
    setError('')
  }

  const applyFailedReceipt = (failedReceipt, fallbackMessage) => {
    setReceipt(failedReceipt || null)
    setStatus('failed')
    setError(humanizeReceiptError(
      fallbackMessage
      || failedReceipt?.errorMessage
      || 'Receipt processing failed. Please try again.',
    ))
  }

  const pollUntilSettled = async (receiptId, cancelled) => {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (!cancelled?.() && Date.now() < deadline) {
      const latest = await getStockReceipt(token, receiptId)
      if (cancelled?.()) return null
      setReceipt(latest)
      if (latest.status === 'READY_FOR_REVIEW') return { type: 'ready', receipt: latest }
      if (latest.status === 'FAILED') return { type: 'failed', receipt: latest }
      if (latest.status === 'CONFIRMED') return { type: 'confirmed', receipt: latest }
      await new Promise((resolve) => {
        pollTimerRef.current = setTimeout(resolve, POLL_INTERVAL_MS)
      })
    }
    return { type: 'timeout' }
  }

  const runProcess = async (receiptId, { useRetryEndpoint = false } = {}) => {
    if (processingRef.current) {
      setError('This receipt is already being processed. Please wait.')
      return
    }
    processingRef.current = true
    setIsWorking(true)
    setError('')
    setStatus('processing')
    clearPoll()
    try {
      const processFn = useRetryEndpoint ? retryStockReceipt : processStockReceipt
      const processed = await processFn(token, receiptId)
      if (processed.status === 'READY_FOR_REVIEW') {
        applyReadyReceipt(processed)
        return
      }
      if (processed.status === 'FAILED') {
        applyFailedReceipt(processed)
        return
      }
      const settled = await pollUntilSettled(receiptId, () => false)
      if (settled?.type === 'ready') applyReadyReceipt(settled.receipt)
      else if (settled?.type === 'failed') applyFailedReceipt(settled.receipt)
      else if (settled?.type === 'confirmed') {
        setStatus('success')
        setResult({ updated: [], skipped: [], alreadyConfirmed: true })
        setError('This receipt is already confirmed.')
      } else {
        applyFailedReceipt(null, 'Receipt processing took too long. Please try again.')
      }
    } catch (processError) {
      try {
        const latest = await getStockReceipt(token, receiptId)
        if (latest.status === 'READY_FOR_REVIEW') {
          applyReadyReceipt(latest)
          return
        }
        if (latest.status === 'FAILED') {
          applyFailedReceipt(latest, processError.message)
          return
        }
        if (latest.status === 'PROCESSING') {
          const settled = await pollUntilSettled(receiptId, () => false)
          if (settled?.type === 'ready') {
            applyReadyReceipt(settled.receipt)
            return
          }
          if (settled?.type === 'failed') {
            applyFailedReceipt(settled.receipt, processError.message)
            return
          }
        }
      } catch {
        // Fall through
      }
      applyFailedReceipt(receipt ? { ...receipt, status: 'FAILED' } : { id: receiptId, status: 'FAILED' }, processError.message)
    } finally {
      processingRef.current = false
      setIsWorking(false)
      clearPoll()
    }
  }

  useEffect(() => {
    if (!token) return undefined
    const params = new URLSearchParams(window.location.search)
    const receiptId = params.get('receiptId')
    if (!receiptId) {
      let cancelled = false
      queueMicrotask(() => { if (!cancelled) setBootstrapping(false) })
      return () => { cancelled = true }
    }

    let cancelled = false
    const boot = async () => {
      setBootstrapping(true)
      setError('')
      try {
        const loaded = await getStockReceipt(token, receiptId)
        if (cancelled) return
        setReceipt(loaded)

        if (loaded.status === 'READY_FOR_REVIEW') {
          applyReadyReceipt(loaded)
          return
        }
        if (loaded.status === 'CONFIRMED') {
          setStatus('success')
          setResult({ updated: [], skipped: [], alreadyConfirmed: true })
          setError('This receipt is already confirmed.')
          return
        }
        if (loaded.status === 'FAILED') {
          const shouldAutoRetry = params.get('retry') === '1'
          if (shouldAutoRetry) {
            if (cancelled) return
            setBootstrapping(false)
            setRetryCount(1)
            await runProcess(receiptId, { useRetryEndpoint: true })
            if (!cancelled) {
              window.history.replaceState({}, '', `/admin/stock-receipt?receiptId=${encodeURIComponent(receiptId)}`)
            }
            return
          }
          applyFailedReceipt(loaded)
          return
        }
        if (loaded.status === 'PROCESSING') {
          if (cancelled) return
          setBootstrapping(false)
          setStatus('processing')
          await runProcess(receiptId)
          return
        }
        setError(`Unsupported receipt status: ${loaded.status}`)
        setStatus('upload')
      } catch (loadError) {
        if (!cancelled) {
          setError(humanizeReceiptError(loadError.message))
          setStatus('upload')
        }
      } finally {
        if (!cancelled) setBootstrapping(false)
      }
    }
    queueMicrotask(boot)

    return () => {
      cancelled = true
      clearPoll()
    }
  }, [token])

  const handleFileChange = (event) => {
    const selectedFile = event.target.files?.[0]
    setError('')
    setResult(null)
    setRetryCount(0)
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
    if (!file && !receipt?.id) {
      setError('Select a receipt before processing.')
      return
    }
    setError('')
    setStatus('processing')
    try {
      let receiptId = receipt?.id
      if (!receiptId) {
        try {
          const uploaded = await uploadStockReceipt(token, file)
          receiptId = uploaded.receiptId
          setReceipt({ id: receiptId, fileName: uploaded.fileName || file.name, status: 'PROCESSING' })
          window.history.replaceState({}, '', `/admin/stock-receipt?receiptId=${encodeURIComponent(receiptId)}`)
        } catch (uploadError) {
          const existingId = uploadError?.data?.receiptId
          if (uploadError?.status === 409 && existingId) {
            receiptId = existingId
            setReceipt({
              id: existingId,
              fileName: file.name,
              status: uploadError.data?.status || 'FAILED',
            })
          } else {
            setError(humanizeReceiptError(uploadError.message || 'Upload failed.'))
            setStatus('upload')
            return
          }
        }
      }
      await runProcess(receiptId, {
        useRetryEndpoint: Boolean(receipt?.status === 'FAILED'),
      })
    } catch (processingError) {
      setError(humanizeReceiptError(processingError.message || 'Receipt processing failed.'))
      setStatus(receipt?.id ? 'failed' : 'upload')
    }
  }

  const handleRetry = async () => {
    if (!receipt?.id) {
      setError('No receipt to retry.')
      return
    }
    if (retryCount >= MAX_CLIENT_RETRIES) {
      setError(`Retry limit reached (${MAX_CLIENT_RETRIES}). Upload a clearer JPG or PNG, or try again later.`)
      return
    }
    setRetryCount((count) => count + 1)
    await runProcess(receipt.id, { useRetryEndpoint: receipt.status === 'FAILED' || status === 'failed' })
  }

  const updateRow = (id, field, value) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)))
  }

  const selectMedicine = (row, medicine) => {
    setRows((current) => current.map((item) => (item.id === row.id
      ? {
        ...item,
        matchedMedicineId: medicine?.id || null,
        matchedBrandName: medicine?.brandName || '',
        matchedStrength: medicine?.strength || '',
        currentStock: medicine?.availableQty ?? item.currentStock,
        createNew: false,
        dosageForm: item.dosageForm || medicine?.dosageForm || '',
      }
      : item)))
  }

  const confirm = async () => {
    const included = rows.filter((row) => row.include !== false)
    if (included.length === 0) {
      setError('Include at least one item before confirming.')
      return
    }

    const missingExpiry = included.filter((row) => !String(row.expiryDate || '').trim())
    if (missingExpiry.length > 0) {
      setError('Expiry date is required before stock can be added.')
      return
    }

    for (const row of included) {
      if (!String(row.medicineName || '').trim()) {
        setError('Product name is required for every item.')
        return
      }
      if (!String(row.dosageForm || '').trim()) {
        setError('Type/category is required for every item.')
        return
      }
      const qty = Number(row.quantity)
      if (!Number.isInteger(qty) || qty <= 0) {
        setError('Each item needs a positive quantity.')
        return
      }
      if (!row.createNew && !row.matchedMedicineId) {
        setError('Select an existing medicine or choose Create new medicine for each item.')
        return
      }
    }

    setIsWorking(true)
    setError('')
    try {
      const confirmed = await confirmStockReceipt(
        token,
        receipt.id,
        included.map((row) => ({
          id: row.id,
          medicineId: row.createNew ? undefined : row.matchedMedicineId,
          createNew: row.createNew === true,
          medicineName: row.medicineName,
          productName: row.medicineName,
          genericName: row.genericName || null,
          dosageForm: row.dosageForm,
          type: row.dosageForm,
          strength: row.strength || null,
          manufacturer: row.manufacturer || null,
          quantity: Number(row.quantity),
          unitPrice: row.unitPrice === '' || row.unitPrice == null ? null : Number(row.unitPrice),
          totalPrice: row.totalPrice === '' || row.totalPrice == null ? null : Number(row.totalPrice),
          batchNumber: row.batchNumber || null,
          expiryDate: row.expiryDate,
        })),
        {
          supplierName: receiptMeta.supplierName,
          invoiceNumber: receiptMeta.invoiceNumber,
          purchaseDate: receiptMeta.purchaseDate,
          subtotal: receiptMeta.subtotal === '' ? null : Number(receiptMeta.subtotal),
          discount: receiptMeta.discount === '' ? null : Number(receiptMeta.discount),
          tax: receiptMeta.tax === '' ? null : Number(receiptMeta.tax),
          total: receiptMeta.total === '' ? null : Number(receiptMeta.total),
        },
      )
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

  const activeStep = status === 'failed' ? 'processing' : status

  return (
    <main className="min-h-screen bg-[#f4f9fc] px-4 py-8 text-[#172b3d] dark:bg-[#101d2b] dark:text-white sm:px-8">
      <div className="mx-auto max-w-3xl lg:max-w-5xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <a href="/admin" className="text-sm font-bold text-[#2f80c0]">← Back to pharmacy operations</a>
            <h1 className="mt-2 text-3xl font-extrabold sm:text-4xl">Update stock from receipt</h1>
            <p className="mt-2 text-[#607487] dark:text-slate-300">OCR extracts data only. You review and confirm before stock changes.</p>
          </div>
          <a href="/admin/receipts" className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-2 text-sm font-bold text-[#18527f] dark:border-slate-600 dark:bg-[#172b3d]">Receipts list</a>
        </header>

        <nav className="mt-8 grid gap-2 sm:grid-cols-4" aria-label="Receipt workflow">
          {steps.map(([step, label]) => (
            <div key={step} className={`rounded-xl border px-4 py-3 text-sm font-bold ${activeStep === step ? 'border-[#2f80c0] bg-[#e7f4fc] text-[#18527f]' : 'border-[#d9e7f0] bg-white text-[#607487] dark:border-slate-700 dark:bg-[#172b3d]'}`}>{label}</div>
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
            <div className="rounded-3xl border border-[#d9e7f0] bg-white p-6 shadow-lg dark:border-slate-700 dark:bg-[#172b3d]">
              <h2 className="text-2xl font-extrabold">Upload purchase receipt</h2>
              <p className="mt-2 text-sm text-[#607487]">JPG, PNG, and PDF files up to 10 MB.</p>
              <label className="mt-6 block cursor-pointer rounded-2xl border-2 border-dashed border-[#2f80c0] bg-[#f4f9fc] p-8 text-center dark:bg-slate-800">
                <span className="block font-bold text-[#18527f]">Choose receipt file</span>
                <span className="mt-2 block text-sm text-[#607487]">or capture with camera</span>
                <input className="sr-only" type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" capture="environment" onChange={handleFileChange} />
              </label>
              {file && <div className="mt-4 rounded-xl bg-[#e7f4fc] p-3 text-sm font-semibold text-[#18527f]">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</div>}
              <button type="button" disabled={!file || isWorking} onClick={startProcessing} className="mt-5 w-full rounded-xl bg-[#2f80c0] px-5 py-3 font-bold text-white hover:bg-[#18527f] disabled:opacity-50">
                {isWorking ? 'Processing…' : 'Extract receipt data'}
              </button>
            </div>
            <div className="rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
              <h2 className="text-2xl font-extrabold">Receipt preview</h2>
              <div className="mt-4 grid min-h-80 place-items-center overflow-hidden rounded-2xl bg-[#f4f9fc] dark:bg-slate-800">
                {!previewUrl && <p className="p-6 text-center text-[#607487]">Preview appears here.</p>}
                {previewUrl && file?.type === 'application/pdf' && <iframe className="h-[420px] w-full" title="Receipt preview" src={previewUrl} />}
                {previewUrl && file?.type !== 'application/pdf' && <img className="max-h-[420px] max-w-full object-contain" src={previewUrl} alt="Selected receipt preview" />}
              </div>
            </div>
          </section>
        )}

        {!bootstrapping && status === 'processing' && (
          <section className="mt-8 rounded-3xl border border-[#d9e7f0] bg-white p-12 text-center dark:border-slate-700 dark:bg-[#172b3d]">
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-[#d9e7f0] border-t-[#2f80c0]" />
            <h2 className="mt-6 text-2xl font-extrabold">Extracting receipt data</h2>
            <p className="mt-2 text-[#607487]">OCR only — stock is not changed until you confirm.</p>
          </section>
        )}

        {!bootstrapping && status === 'failed' && (
          <section className="mt-8 rounded-3xl border border-[#f0c7c3] bg-white p-8 text-center dark:border-[#7a3b36] dark:bg-[#172b3d]">
            <h2 className="text-2xl font-extrabold text-[#b94f49]">Receipt processing failed</h2>
            <p className="mt-3 text-[#607487]">Please retry or upload a clearer JPG/PNG.</p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button type="button" disabled={isWorking || retryCount >= MAX_CLIENT_RETRIES} onClick={handleRetry} className="rounded-xl bg-[#2f80c0] px-5 py-3 font-bold text-white disabled:opacity-50">
                {isWorking ? 'Retrying…' : 'Retry'}
              </button>
              <button
                type="button"
                disabled={isWorking}
                onClick={() => {
                  setStatus('upload')
                  setError('')
                  setReceipt(null)
                  setFile(null)
                  setRetryCount(0)
                  window.history.replaceState({}, '', '/admin/stock-receipt')
                }}
                className="rounded-xl border border-[#d9e7f0] bg-white px-5 py-3 font-bold text-[#18527f]"
              >
                Upload a different file
              </button>
            </div>
          </section>
        )}

        {!bootstrapping && status === 'review' && receipt && (
          <section className="mt-8 space-y-5 pb-28">
            <div className="rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
              <div className="rounded-xl bg-[#fff8df] p-3 text-sm font-bold text-[#795f00]">
                Stock has NOT been updated yet. Expiry is required for every item before confirmation.
              </div>
              <h2 className="mt-5 text-2xl font-extrabold">Receipt information</h2>
              <p className="mt-1 text-sm text-[#607487]">{receipt.fileName}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {[
                  ['supplierName', 'Supplier'],
                  ['invoiceNumber', 'Invoice'],
                  ['purchaseDate', 'Purchase date'],
                  ['subtotal', 'Subtotal'],
                  ['discount', 'Discount'],
                  ['tax', 'Tax'],
                  ['total', 'Total'],
                ].map(([field, label]) => (
                  <label key={field} className="text-xs font-bold text-[#607487]">
                    {label}
                    <input
                      className={fieldClass}
                      type={['subtotal', 'discount', 'tax', 'total'].includes(field) ? 'number' : 'text'}
                      step="0.01"
                      value={receiptMeta[field]}
                      onChange={(e) => setReceiptMeta((current) => ({ ...current, [field]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            </div>

            {rows.map((row, index) => (
              <article key={row.id} className="rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xl font-extrabold">Item {index + 1}</h3>
                  <label className="flex items-center gap-2 text-sm font-bold text-[#607487]">
                    <input
                      type="checkbox"
                      checked={row.include !== false}
                      onChange={(e) => updateRow(row.id, 'include', e.target.checked)}
                    />
                    Include in confirmation
                  </label>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-bold text-[#607487] sm:col-span-2">
                    Product name *
                    <input className={fieldClass} value={row.medicineName} onChange={(e) => updateRow(row.id, 'medicineName', e.target.value)} />
                  </label>
                  <label className="text-xs font-bold text-[#607487]">
                    Generic name
                    <input className={fieldClass} value={row.genericName} onChange={(e) => updateRow(row.id, 'genericName', e.target.value)} />
                  </label>
                  <label className="text-xs font-bold text-[#607487]">
                    Type / category *
                    <select className={fieldClass} value={row.dosageForm || ''} onChange={(e) => updateRow(row.id, 'dosageForm', e.target.value)}>
                      <option value="">Select type…</option>
                      {DOSAGE_FORMS.map((form) => <option key={form} value={form}>{form}</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-bold text-[#607487]">
                    Strength
                    <input className={fieldClass} value={row.strength} onChange={(e) => updateRow(row.id, 'strength', e.target.value)} />
                  </label>
                  <label className="text-xs font-bold text-[#607487]">
                    Manufacturer
                    <input className={fieldClass} value={row.manufacturer} onChange={(e) => updateRow(row.id, 'manufacturer', e.target.value)} />
                  </label>
                  <label className="text-xs font-bold text-[#607487]">
                    Quantity *
                    <input className={fieldClass} type="number" min="1" value={row.quantity} onChange={(e) => updateRow(row.id, 'quantity', e.target.value === '' ? '' : Number(e.target.value))} />
                  </label>
                  <label className="text-xs font-bold text-[#607487]">
                    Unit price
                    <input className={fieldClass} type="number" min="0" step="0.01" value={row.unitPrice} onChange={(e) => updateRow(row.id, 'unitPrice', e.target.value)} />
                  </label>
                  <label className="text-xs font-bold text-[#607487]">
                    Total price
                    <input className={fieldClass} type="number" min="0" step="0.01" value={row.totalPrice} onChange={(e) => updateRow(row.id, 'totalPrice', e.target.value)} />
                  </label>
                  <label className="text-xs font-bold text-[#607487]">
                    Batch number
                    <input className={fieldClass} value={row.batchNumber} onChange={(e) => updateRow(row.id, 'batchNumber', e.target.value)} />
                  </label>
                  <label className="text-xs font-bold text-[#607487]">
                    Expiry date *
                    <input className={fieldClass} type="date" value={row.expiryDate} onChange={(e) => updateRow(row.id, 'expiryDate', e.target.value)} />
                  </label>
                  <div className="sm:col-span-2">
                    <p className="text-xs font-bold text-[#607487]">Medicine *</p>
                    <div className="mt-1">
                      <MedicinePicker
                        value={row.matchedMedicineId}
                        label={row.matchedMedicineId
                          ? `${row.matchedBrandName || row.medicineName}${row.matchedStrength ? ` · ${row.matchedStrength}` : ''}`
                          : ''}
                        createNew={row.createNew}
                        onSelect={(medicine) => selectMedicine(row, medicine)}
                        onCreateNew={(createNew) => {
                          updateRow(row.id, 'createNew', createNew)
                          if (createNew) {
                            setRows((current) => current.map((item) => (item.id === row.id
                              ? { ...item, createNew: true, matchedMedicineId: null, matchedBrandName: '', matchedStrength: '' }
                              : item)))
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
              </article>
            ))}

            <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[#d9e7f0] bg-white/95 p-4 backdrop-blur dark:border-slate-700 dark:bg-[#101d2b]/95">
              <div className="mx-auto flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between lg:max-w-5xl">
                <p className="text-sm text-[#607487]">Nothing is added to stock until you confirm.</p>
                <button
                  type="button"
                  disabled={isWorking}
                  onClick={confirm}
                  className="w-full rounded-xl bg-[#2f80c0] px-6 py-3 font-bold text-white hover:bg-[#18527f] disabled:opacity-50 sm:w-auto"
                >
                  {isWorking ? 'Confirming…' : 'Confirm & Update Stock'}
                </button>
              </div>
            </div>
          </section>
        )}

        {!bootstrapping && status === 'success' && result && (
          <section className="mt-8 rounded-3xl border border-[#b9e5ca] bg-white p-6 dark:border-[#3b8c5a] dark:bg-[#172b3d]">
            <h2 className="text-2xl font-extrabold text-[#17683b]">
              {result.alreadyConfirmed ? 'Receipt already confirmed' : 'Stock updated successfully'}
            </h2>
            <p className="mt-2 text-[#607487]">
              {result.alreadyConfirmed
                ? 'This receipt was confirmed earlier. Stock was not changed again.'
                : `${result.updated?.length || 0} item(s) updated.`}
            </p>
            <div className="mt-5 grid gap-3">
              {(result.updated || []).map((item) => (
                <div key={`${item.medicineId}-${item.expiryDate || ''}-${item.batchId || ''}`} className="rounded-xl bg-[#f4f9fc] p-4 dark:bg-slate-800">
                  <strong>{item.medicineName || item.medicineId}</strong>
                  {item.created ? <span className="ml-2 text-xs font-bold text-[#18527f]">NEW</span> : null}
                  <span className="mt-1 block text-sm text-[#607487]">
                    Previous {item.previousStock} · Added {item.quantityAdded} · New {item.newStock}
                    {item.expiryDate ? ` · Expiry ${item.expiryDate}` : ''}
                    {item.batchNumber ? ` · Batch ${item.batchNumber}` : ''}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <a href="/admin" className="rounded-xl bg-[#2f80c0] px-5 py-3 font-bold text-white">Back to operations</a>
              <a href="/admin/receipts" className="rounded-xl border border-[#d9e7f0] px-5 py-3 font-bold text-[#18527f]">Receipts list</a>
            </div>
          </section>
        )}
      </div>
    </main>
  )
}
