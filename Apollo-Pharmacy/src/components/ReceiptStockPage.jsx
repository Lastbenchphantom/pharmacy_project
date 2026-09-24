import { useEffect, useState } from 'react'
import {
  confirmStockReceipt,
  getMedicines,
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

export default function ReceiptStockPage() {
  const [token] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [status, setStatus] = useState('upload')
  const [receipt, setReceipt] = useState(null)
  const [medicines, setMedicines] = useState([])
  const [rows, setRows] = useState([])
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [isWorking, setIsWorking] = useState(false)

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
    if (!token) return
    getMedicines()
      .then(setMedicines)
      .catch(() => setMedicines([]))
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
      setRows(processed.items.map((item) => ({ ...item, quantity: item.quantity ?? '' })))
      setStatus('review')
    } catch (processingError) {
      setError(processingError.message)
      setStatus('upload')
    } finally {
      setIsWorking(false)
    }
  }

  const updateRow = (id, field, value) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, [field]: value } : row))
  }

  const selectMedicine = (row, medicineId) => {
    const medicine = medicines.find((item) => item.id === medicineId)
    setRows((current) => current.map((item) => item.id === row.id
      ? { ...item, matchedMedicineId: medicineId || null, matchStatus: medicineId ? 'MATCHED' : 'NEEDS_MANUAL', currentStock: medicine?.availableQty ?? item.currentStock }
      : item))
  }

  const confirm = async () => {
    const selectedRows = rows.filter((row) => row.matchedMedicineId && Number.isInteger(Number(row.quantity)) && Number(row.quantity) > 0)
    if (selectedRows.length === 0) {
      setError('Match at least one medicine and enter a positive quantity before confirming.')
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
    return <main className="grid min-h-screen place-items-center bg-[#f4f9fc] p-6 text-[#172b3d]"><div className="rounded-3xl border border-[#d9e7f0] bg-white p-8 text-center shadow-xl"><h1 className="text-2xl font-extrabold">Admin sign in required</h1><a className="mt-4 inline-block font-bold text-[#2f80c0]" href="/admin">Go to admin sign in</a></div></main>
  }

  return (
    <main className="min-h-screen bg-[#f4f9fc] px-4 py-8 text-[#172b3d] dark:bg-[#101d2b] dark:text-white sm:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div><a href="/admin" className="text-sm font-bold text-[#2f80c0]">← Back to pharmacy operations</a><h1 className="mt-2 text-4xl font-extrabold">Update stock from receipt</h1><p className="mt-2 text-[#607487] dark:text-slate-300">AI prepares the review. Stock changes only after your confirmation.</p></div>
        </header>

        <nav className="mt-8 grid gap-2 sm:grid-cols-4" aria-label="Receipt workflow">
          {steps.map(([step, label]) => <div key={step} className={`rounded-xl border px-4 py-3 text-sm font-bold ${status === step ? 'border-[#2f80c0] bg-[#e7f4fc] text-[#18527f]' : 'border-[#d9e7f0] bg-white text-[#607487] dark:border-slate-700 dark:bg-[#172b3d]'}`}>{label}</div>)}
        </nav>

        {error && <p className="mt-6 rounded-xl bg-[#fff0ef] p-4 font-semibold text-[#b94f49]">{error}</p>}

        {status === 'upload' && <section className="mt-8 grid gap-6 lg:grid-cols-[.8fr_1.2fr]">
          <div className="rounded-3xl border border-[#d9e7f0] bg-white p-6 shadow-lg shadow-[#18527f]/5 dark:border-slate-700 dark:bg-[#172b3d]">
            <h2 className="text-2xl font-extrabold">Upload purchase receipt</h2>
            <p className="mt-2 text-sm text-[#607487] dark:text-slate-300">JPG, PNG, and PDF files up to 10 MB are supported.</p>
            <label className="mt-6 block cursor-pointer rounded-2xl border-2 border-dashed border-[#2f80c0] bg-[#f4f9fc] p-8 text-center dark:bg-slate-800">
              <span className="block font-bold text-[#18527f] dark:text-[#bfe4fb]">Choose receipt file</span>
              <span className="mt-2 block text-sm text-[#607487]">or capture one with your device camera</span>
              <input className="sr-only" type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" capture="environment" onChange={handleFileChange} />
            </label>
            {file && <div className="mt-4 rounded-xl bg-[#e7f4fc] p-3 text-sm font-semibold text-[#18527f]">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</div>}
            <button type="button" disabled={!file || isWorking} onClick={startProcessing} className="mt-5 w-full rounded-xl bg-[#2f80c0] px-5 py-3 font-bold text-white hover:bg-[#18527f] disabled:cursor-not-allowed disabled:opacity-50">{isWorking ? 'Processing receipt...' : 'Process receipt with AI'}</button>
          </div>
          <div className="rounded-3xl border border-[#d9e7f0] bg-white p-5 dark:border-slate-700 dark:bg-[#172b3d]">
            <h2 className="text-2xl font-extrabold">Receipt preview</h2>
            <div className="mt-4 grid min-h-80 place-items-center overflow-hidden rounded-2xl bg-[#f4f9fc] dark:bg-slate-800">
              {!previewUrl && <p className="p-6 text-center text-[#607487]">Your receipt preview will appear here.</p>}
              {previewUrl && file?.type === 'application/pdf' && <iframe className="h-[520px] w-full" title="Receipt preview" src={previewUrl} />}
              {previewUrl && file?.type !== 'application/pdf' && <img className="max-h-[520px] max-w-full object-contain" src={previewUrl} alt="Selected receipt preview" />}
            </div>
          </div>
        </section>}

        {status === 'processing' && <section className="mt-8 rounded-3xl border border-[#d9e7f0] bg-white p-12 text-center shadow-lg shadow-[#18527f]/5 dark:border-slate-700 dark:bg-[#172b3d]"><div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-[#d9e7f0] border-t-[#2f80c0]" /><h2 className="mt-6 text-2xl font-extrabold">Reading your receipt</h2><p className="mt-2 text-[#607487] dark:text-slate-300">Extracting medicines and matching them against live stock. Stock has not changed.</p></section>}

        {status === 'review' && receipt && <section className="mt-8 rounded-3xl border border-[#d9e7f0] bg-white p-5 shadow-lg shadow-[#18527f]/5 dark:border-slate-700 dark:bg-[#172b3d]">
          <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-2xl font-extrabold">Review extracted medicines</h2><p className="mt-2 text-sm text-[#607487] dark:text-slate-300">{receipt.fileName}</p></div><div className="rounded-xl bg-[#fff8df] p-3 text-sm font-bold text-[#795f00]">Stock has NOT been updated yet. Review all items carefully before confirming.</div></div>
          <div className="mt-5 overflow-x-auto"><table className="min-w-[980px] w-full text-left text-sm"><thead><tr className="border-b border-[#d9e7f0] text-xs uppercase tracking-wide text-[#607487]"><th className="p-3">Medicine</th><th className="p-3">Extracted quantity</th><th className="p-3">Matched medicine</th><th className="p-3">Current stock</th><th className="p-3">New stock</th><th className="p-3">Confidence</th></tr></thead><tbody>{rows.map((row) => { const lowConfidence = row.matchStatus !== 'MATCHED' || Number(row.confidence) < 0.75 || !row.quantity; const selectedMedicine = medicines.find((medicine) => medicine.id === row.matchedMedicineId); return <tr key={row.id} className={`border-b border-[#d9e7f0] align-top dark:border-slate-700 ${lowConfidence ? 'bg-[#fff8df]' : ''}`}><td className="p-3"><input className="w-48 rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-[#172b3d]" value={row.medicineName} onChange={(event) => updateRow(row.id, 'medicineName', event.target.value)} /><p className="mt-1 text-xs text-[#607487]">{[row.strength, row.dosageForm, row.packSize].filter(Boolean).join(' · ') || 'Details not readable'}</p></td><td className="p-3"><input className="w-28 rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-[#172b3d]" type="number" min="1" value={row.quantity} onChange={(event) => updateRow(row.id, 'quantity', event.target.value === '' ? '' : Number(event.target.value))} /></td><td className="p-3"><select className="w-56 rounded-lg border border-[#d9e7f0] bg-white px-3 py-2 text-[#172b3d]" value={row.matchedMedicineId || ''} onChange={(event) => selectMedicine(row, event.target.value)}><option value="">Needs manual matching</option>{medicines.map((medicine) => <option key={medicine.id} value={medicine.id}>{medicine.brandName} · {medicine.strength}</option>)}</select><p className="mt-1 text-xs text-[#607487]">{selectedMedicine?.genericName || row.genericName || 'No match selected'}</p></td><td className="p-3 font-bold">{selectedMedicine?.availableQty ?? row.currentStock ?? '—'}</td><td className="p-3 font-bold">{selectedMedicine && Number.isInteger(Number(row.quantity)) ? selectedMedicine.availableQty + Number(row.quantity) : '—'}</td><td className="p-3"><span className={`rounded-full px-2 py-1 text-xs font-bold ${lowConfidence ? 'bg-[#ffe6b3] text-[#795f00]' : 'bg-[#d9f3e6] text-[#17683b]'}`}>{Math.round(Number(row.confidence || 0) * 100)}%{lowConfidence ? ' · Review' : ''}</span></td></tr> })}</tbody></table></div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4"><p className="text-sm text-[#607487]">Unmatched or skipped rows will be recorded in the confirmation summary and will not change stock.</p><button type="button" disabled={isWorking} onClick={confirm} className="rounded-xl bg-[#2f80c0] px-6 py-3 font-bold text-white hover:bg-[#18527f] disabled:cursor-wait disabled:opacity-50">{isWorking ? 'Confirming...' : 'Confirm Stock Update'}</button></div>
        </section>}

        {status === 'success' && result && <section className="mt-8 rounded-3xl border border-[#b9e5ca] bg-white p-6 shadow-lg dark:border-[#3b8c5a] dark:bg-[#172b3d]"><h2 className="text-2xl font-extrabold text-[#17683b]">Stock updated successfully</h2><p className="mt-2 text-[#607487] dark:text-slate-300">{result.updated.length} medicine{result.updated.length === 1 ? '' : 's'} updated. The receipt is now recorded as confirmed.</p><div className="mt-5 grid gap-3">{result.updated.map((item) => <div key={item.medicineId} className="rounded-xl bg-[#f4f9fc] p-4 dark:bg-slate-800"><strong>{medicines.find((medicine) => medicine.id === item.medicineId)?.brandName || item.medicineId}</strong><span className="ml-3 text-sm text-[#607487]">Previous {item.previousStock} · Added {item.quantityAdded} · New {item.newStock}</span></div>)}</div>{result.skipped?.length > 0 && <div className="mt-5 rounded-xl bg-[#fff8df] p-4 text-sm font-semibold text-[#795f00]"><strong>Skipped items:</strong> {result.skipped.map((item) => `${item.medicineName} (${item.reason})`).join(', ')}</div>}<a href="/admin" className="mt-6 inline-block rounded-xl bg-[#2f80c0] px-5 py-3 font-bold text-white">Back to operations</a></section>}
      </div>
    </main>
  )
}
