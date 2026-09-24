const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api').replace(/\/$/, '')

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...options,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'The pharmacy service is unavailable.')
  return data
}

export const getMedicines = ({ limit, random = false, search = '' } = {}) => {
  const query = new URLSearchParams()
  if (limit) query.set('limit', String(limit))
  if (random) query.set('random', 'true')
  if (search) query.set('search', search)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request(`/medicines${suffix}`)
}

export const createAppointment = (appointment) => request('/appointments', {
  method: 'POST',
  body: JSON.stringify(appointment),
})

export const loginAdmin = (password) => request('/admin/login', {
  method: 'POST',
  body: JSON.stringify({ password }),
})

export const getAdminAppointments = (token) => request('/admin/appointments', { token })

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
