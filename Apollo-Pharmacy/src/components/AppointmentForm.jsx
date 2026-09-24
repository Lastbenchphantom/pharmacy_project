import { useState } from 'react'
import { createAppointment } from '../api'

const INITIAL_FORM = {
  name: '',
  email: '',
  phone: '',
  doctorId: '',
  date: '',
  note: '',
}

export default function AppointmentForm({ doctors = [] }) {
  const [form, setForm] = useState(INITIAL_FORM)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleChange = (event) => {
    const { name, value } = event.target
    setForm((current) => ({ ...current, [name]: value }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')
    try {
      const doctor = doctors.find((item) => item.id === form.doctorId) || doctors[0]
      if (!doctor) throw new Error('Please select a doctor.')
      await createAppointment({
        patientName: form.name,
        email: form.email,
        phoneNumber: form.phone,
        doctorName: doctor.name,
        timeSlot: form.date,
        note: form.note,
      })
      setSubmitted(true)
      setForm(INITIAL_FORM)
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form className="rounded-3xl border border-[#d9e7f0] bg-white p-6 shadow-lg shadow-[#18527f]/5 dark:border-slate-700 dark:bg-[#172b3d]" onSubmit={handleSubmit}>
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
        <div className="flex flex-col gap-2">
          <label className="text-xs font-bold text-[#607487] dark:text-slate-300" htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            className="w-full rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-4 py-3 text-[#172b3d] outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            name="email"
            type="email"
            value={form.email}
            onChange={handleChange}
            placeholder="you@example.com"
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-xs font-bold text-[#607487] dark:text-slate-300" htmlFor="name">
            Full name
          </label>
          <input
            id="name"
            className="w-full rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-4 py-3 text-[#172b3d] outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            name="name"
            value={form.name}
            onChange={handleChange}
            placeholder="Your name"
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-xs font-bold text-[#607487] dark:text-slate-300" htmlFor="phone">
            Phone number
          </label>
          <input
            id="phone"
            className="w-full rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-4 py-3 text-[#172b3d] outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            name="phone"
            value={form.phone}
            onChange={handleChange}
            placeholder="01XXXXXXXXX"
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-xs font-bold text-[#607487] dark:text-slate-300" htmlFor="doctorId">
            Doctor
          </label>
          <select
            id="doctorId"
            className="w-full rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-4 py-3 text-[#172b3d] outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            name="doctorId"
            value={form.doctorId || doctors[0]?.id || ''}
            onChange={handleChange}
            required
          >
            <option value="">Select a doctor</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name} - {doctor.specialty}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-xs font-bold text-[#607487] dark:text-slate-300" htmlFor="date">
            Preferred date
          </label>
          <input
            id="date"
            className="w-full rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-4 py-3 text-[#172b3d] outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            name="date"
            type="date"
            value={form.date}
            onChange={handleChange}
            required
          />
        </div>

        <div className="col-span-full flex flex-col gap-2">
          <label className="text-xs font-bold text-[#607487] dark:text-slate-300" htmlFor="note">
            Health concern
          </label>
          <textarea
            id="note"
            className="min-h-24 w-full rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-4 py-3 text-[#172b3d] outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            name="note"
            value={form.note}
            onChange={handleChange}
            placeholder="Briefly tell us about your concern"
          />
        </div>
      </div>

      {doctors.length === 0 && <p className="mt-4 rounded-xl bg-[#fff0ef] p-3 text-sm font-bold text-[#b94f49]">Doctor schedules are currently unavailable.</p>}

      <button type="submit" disabled={isSubmitting} className="mt-5 w-full rounded-xl bg-[#2f80c0] px-5 py-3 font-bold text-white transition hover:bg-[#18527f] disabled:opacity-60">
        {isSubmitting ? 'Sending request...' : 'Confirm appointment'}
      </button>

      {submitted && <div className="mt-4 rounded-xl bg-[#e7f4fc] p-3 font-bold text-[#18527f]">Appointment request sent successfully. Our care team will contact you shortly.</div>}
      {error && <div className="mt-4 rounded-xl bg-[#fff0ef] p-3 font-bold text-[#b94f49]">{error}</div>}
    </form>
  )
}
