const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api').replace(/\/$/, '')

async function request(path, options = {}) {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...options,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'The pharmacy service is unavailable.')
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

export const getMedicines = ({ limit, random = false, search = '', offset } = {}) => (
  request(withQuery('/medicines', { limit, random: random ? 'true' : undefined, search, offset }))
)

export const createAppointment = (appointment) => request('/appointments', {
  method: 'POST',
  body: JSON.stringify(appointment),
})

export const loginAdmin = (password) => request('/admin/login', {
  method: 'POST',
  body: JSON.stringify({ password }),
})

export const getAdminAppointments = (token, { status, limit, offset } = {}) => (
  request(withQuery('/admin/appointments', { status, limit, offset }), { token })
)

export const updateMedicineStock = (token, medicineId, stock) => request('/admin/update-stock', {
  method: 'PATCH',
  token,
  body: JSON.stringify({ medicineId, ...stock }),
})

export const updateAppointmentStatus = (token, appointmentId, status) => request(`/admin/appointments/${appointmentId}`, {
  method: 'PATCH',
  token,
  body: JSON.stringify({ status }),
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

export const processStockReceipt = (token, receiptId) => request('/stock/receipt/process', {
  method: 'POST',
  token,
  body: JSON.stringify({ receiptId }),
})

export const getStockReceipt = (token, receiptId) => request(`/stock/receipt/${receiptId}`, { token })

export const confirmStockReceipt = (token, receiptId, items) => request('/stock/receipt/confirm', {
  method: 'POST',
  token,
  body: JSON.stringify({ receiptId, items }),
})

export const getDashboard = (token) => request('/admin/dashboard', { token })

export const getLowStock = (token, { threshold, limit, offset } = {}) => (
  request(withQuery('/admin/stock/low', { threshold, limit, offset }), { token })
)

export const getExpiringStock = (token, { days, includeExpired = true, limit, offset } = {}) => (
  request(withQuery('/admin/stock/expiring', {
    days,
    includeExpired: includeExpired ? 'true' : 'false',
    limit,
    offset,
  }), { token })
)

export const adjustStock = (token, payload) => request('/admin/stock/adjust', {
  method: 'POST',
  token,
  body: JSON.stringify(payload),
})

export const getBatches = (token, medicineId) => (
  request(withQuery('/admin/batches', { medicineId }), { token })
)

export const updateBatch = (token, batchId, payload) => request(`/admin/batches/${batchId}`, {
  method: 'PATCH',
  token,
  body: JSON.stringify(payload),
})

export const getStockTransactions = (token, { medicineId, type, from, to, limit, offset } = {}) => (
  request(withQuery('/admin/stock/transactions', { medicineId, type, from, to, limit, offset }), { token })
)

export const getReceipts = (token, { status, limit, offset } = {}) => (
  request(withQuery('/admin/receipts', { status, limit, offset }), { token })
)

export const createMedicine = (token, payload) => request('/admin/medicines', {
  method: 'POST',
  token,
  body: JSON.stringify(payload),
})

export const updateMedicine = (token, medicineId, payload) => request(`/admin/medicines/${medicineId}`, {
  method: 'PATCH',
  token,
  body: JSON.stringify(payload),
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
  const response = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
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
