const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api').replace(/\/$/, '')
const REQUEST_TIMEOUT_MS = 90_000

async function request(path, options = {}) {
  const { token, headers: extraHeaders, signal, ...fetchOptions } = options
  const isFormData = typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData
  const timeoutSignal = signal ?? (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined)

  let response
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...fetchOptions,
      signal: timeoutSignal,
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('The pharmacy service timed out. Please try again.', { cause: error })
    }
    throw new Error('The pharmacy service is unavailable.', { cause: error })
  }

  const contentType = response.headers.get('content-type') || ''
  const data = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : {}

  if (!response.ok) {
    const error = new Error(data.error || 'The pharmacy service is unavailable.')
    error.status = response.status
    error.data = data
    throw error
  }
  if (!contentType.includes('application/json')) {
    throw new Error('The pharmacy service returned an unexpected response.')
  }
  return data
}

const withQuery = (path, params = {}) => {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  })
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return `${path}${suffix}`
}

const asArray = (data) => {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.items)) return data.items
  if (Array.isArray(data?.data)) return data.data
  return []
}

/** Paginated medicine fetch. Never requests unbounded catalogs. */
export const fetchMedicines = async ({
  limit = 25,
  page,
  offset,
  random = false,
  search = '',
  dosageForm,
  type,
  category,
  includeInactive = false,
  stockStatus,
} = {}) => {
  const cappedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100)
  const data = await request(withQuery('/medicines', {
    limit: cappedLimit,
    page,
    offset,
    random: random ? 'true' : undefined,
    search: search || undefined,
    dosageForm: dosageForm || type || category || undefined,
    includeInactive: includeInactive ? 'true' : undefined,
    stockStatus: stockStatus || undefined,
  }))
  const items = asArray(data)
  const pagination = data?.pagination || {
    page: page || 1,
    limit: cappedLimit,
    offset: offset || 0,
    total: items.length,
    totalPages: 1,
  }
  return { items, pagination }
}

/** Convenience wrapper that returns only the medicine array (for typeaheads). */
export const getMedicines = async (options = {}) => (await fetchMedicines(options)).items

export const loginAdmin = (password) => request('/admin/login', {
  method: 'POST',
  body: JSON.stringify({ password }),
})

export const updateMedicineStock = (token, medicineId, stock) => request('/admin/update-stock', {
  method: 'PATCH',
  token,
  body: JSON.stringify({ medicineId, ...stock }),
})

export const syncMedicines = (token) => request('/admin/medicines/sync', {
  method: 'POST',
  token,
})

export const uploadStockReceipt = (token, file) => {
  const body = new FormData()
  body.append('receipt', file)
  return request('/stock/receipt/upload', { method: 'POST', token, body })
}

const processReceiptTimeoutSignal = () => (
  typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(120_000)
    : undefined
)

export const processStockReceipt = (token, receiptId) => request('/stock/receipt/process', {
  method: 'POST',
  token,
  body: JSON.stringify({ receiptId }),
  signal: processReceiptTimeoutSignal(),
})

export const retryStockReceipt = (token, receiptId) => request('/stock/receipt/retry', {
  method: 'POST',
  token,
  body: JSON.stringify({ receiptId }),
  signal: processReceiptTimeoutSignal(),
})

export const getStockReceipt = (token, receiptId) => request(`/stock/receipt/${receiptId}`, { token })

export const confirmStockReceipt = (token, receiptId, items, receipt = undefined) => request('/stock/receipt/confirm', {
  method: 'POST',
  token,
  body: JSON.stringify({ receiptId, items, ...(receipt ? { receipt } : {}) }),
})

export const deleteReceipt = (token, receiptId) => request(`/admin/receipts/${encodeURIComponent(receiptId)}`, {
  method: 'DELETE',
  token,
})

export const getDashboard = (token) => request('/admin/dashboard', { token })

export const getLowStock = async (token, { threshold, limit, offset } = {}) => (
  asArray(await request(withQuery('/admin/stock/low', { threshold, limit, offset }), { token }))
)

export const getExpiringStock = async (token, { days, includeExpired = true, limit, offset } = {}) => (
  asArray(await request(withQuery('/admin/stock/expiring', {
    days,
    includeExpired: includeExpired ? 'true' : 'false',
    limit,
    offset,
  }), { token }))
)

export const adjustStock = (token, payload) => request('/admin/stock/adjust', {
  method: 'POST',
  token,
  body: JSON.stringify(payload),
})

export const getBatches = async (token, medicineId) => (
  asArray(await request(withQuery('/admin/batches', { medicineId }), { token }))
)

export const updateBatch = (token, batchId, payload) => request(`/admin/batches/${batchId}`, {
  method: 'PATCH',
  token,
  body: JSON.stringify(payload),
})

export const getStockTransactions = async (token, { medicineId, type, from, to, limit, offset } = {}) => (
  asArray(await request(withQuery('/admin/stock/transactions', { medicineId, type, from, to, limit, offset }), { token }))
)

export const getReceipts = async (token, { status, limit, offset } = {}) => (
  asArray(await request(withQuery('/admin/receipts', { status, limit, offset }), { token }))
)

export const createMedicine = (token, payload) => request('/admin/medicines', {
  method: 'POST',
  token,
  body: JSON.stringify(payload),
})

export const findSimilarMedicines = async (token, params = {}) => {
  const data = await request(withQuery('/admin/medicines/similar', params), { token })
  return {
    message: data.message || '',
    similar: asArray(data.similar || data),
  }
}

export const updateMedicine = (token, medicineId, payload) => request(`/admin/medicines/${medicineId}`, {
  method: 'PATCH',
  token,
  body: JSON.stringify(payload),
})

export const deactivateMedicine = (token, medicineId) => request(`/admin/medicines/${encodeURIComponent(medicineId)}`, {
  method: 'DELETE',
  token,
})

export const sendExpiryAlertEmail = (token, { days } = {}) => request('/admin/alerts/expiry/send', {
  method: 'POST',
  token,
  body: JSON.stringify({ days }),
})

export const sendChat = (prompt) => request('/chat', {
  method: 'POST',
  body: JSON.stringify({ prompt }),
})

async function downloadCsv(path, token, fallbackName) {
  const timeoutSignal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined
  let response
  try {
    response = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: timeoutSignal,
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('CSV export timed out.', { cause: error })
    }
    throw new Error('CSV export failed.', { cause: error })
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || 'CSV export failed.')
  }
  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') || ''
  const match = disposition.match(/filename="?([^"]+)"?/i)
  const filename = match?.[1] || fallbackName
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export const downloadStockCsv = (token) => downloadCsv('/admin/export/stock.csv', token, 'apollo-stock.csv')

export const downloadTransactionsCsv = (token, { from, to } = {}) => (
  downloadCsv(withQuery('/admin/export/transactions.csv', { from, to }), token, 'apollo-transactions.csv')
)

export const getPushStatus = (token) => request('/admin/push/status', { token })

export const subscribePush = (token, subscription) => request('/admin/push/subscribe', {
  method: 'POST',
  token,
  body: JSON.stringify(subscription),
})

export const unsubscribePush = (token, endpoint) => request('/admin/push/subscribe', {
  method: 'DELETE',
  token,
  body: JSON.stringify({ endpoint }),
})

export const triggerExpiryPushCron = (token, { days } = {}) => request('/admin/push/cron/expiry', {
  method: 'POST',
  token,
  body: JSON.stringify({ days }),
})
