import { useEffect, useState } from 'react'
import MedicineCatalog from './components/MedicineCatalog'
import AppointmentForm from './components/AppointmentForm'
import AiChatbot from './components/AiChatbot'
import AdminPage from './components/AdminPage'
import MedicinePage from './components/MedicinePage'
import { getMedicines } from './api'

const services = [
  {
    title: '24/7 Pharmacy Support',
    description: 'Round-the-clock assistance for urgent prescriptions and repeat medicine refills.',
    icon: '🩺',
  },
  {
    title: 'Home Delivery',
    description: 'Fast local delivery for urgent medicines, wellness products, and daily essentials.',
    icon: '🚚',
  },
  {
    title: 'Doctor Consultation',
    description: 'Connect with trusted clinicians for virtual follow-ups and treatment guidance.',
    icon: '👩‍⚕️',
  },
]

const categories = [
  'General Care',
  'Skin & Hair',
  'Vitamins',
  'Baby Care',
  'Diabetes',
  'Heart Care',
]

function PublicApp() {
  const [inventory, setInventory] = useState([])
  const [doctors, setDoctors] = useState([])
  const [catalogError, setCatalogError] = useState('')
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('apollo-theme') === 'dark'
  })

  const toggleTheme = () => {
    setIsDark((current) => {
      const nextThemeIsDark = !current
      document.documentElement.classList.toggle('dark', nextThemeIsDark)
      localStorage.setItem('apollo-theme', nextThemeIsDark ? 'dark' : 'light')
      return nextThemeIsDark
    })
  }

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  useEffect(() => {
    getMedicines({ limit: 20, random: true })
      .then((medicines) => setInventory(medicines.map((medicine) => ({ ...medicine, category: medicine.category || 'General Care' }))))
      .catch((error) => setCatalogError(error.message))
  }, [])

  useEffect(() => {
    fetch('/doctors.json')
      .then((response) => {
        if (!response.ok) throw new Error('Doctor schedules are unavailable.')
        return response.json()
      })
      .then(setDoctors)
      .catch((error) => setCatalogError(error.message))
  }, [])

  return (
    <div className="min-h-screen bg-[#f4f9fc] px-4 py-6 text-[#172b3d] transition-colors dark:bg-[#101d2b] dark:text-slate-100 sm:px-8">
      <div className="mx-auto w-full max-w-[80vw] max-lg:max-w-[92vw] max-sm:max-w-none">
      <header className="sticky top-4 z-20 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#d9e7f0] bg-white/95 p-3 shadow-lg shadow-[#18527f]/10 backdrop-blur dark:border-slate-700 dark:bg-[#172b3d]/95">
        <div className="flex items-center gap-3">
          <img className="h-12 w-12 rounded-full object-contain" src="/logo.jpeg" alt="Apollo Pharmacy logo" />
          <div>
            <div className="text-lg font-extrabold text-[#172b3d] dark:text-white">Apollo Pharmacy</div>
            <div className="text-xs text-[#607487] dark:text-slate-300">Care that reaches home</div>
          </div>
        </div>

        <nav className="flex flex-wrap items-center gap-4 text-sm text-[#607487] dark:text-slate-300" aria-label="Main navigation">
          <a className="transition-colors hover:text-[#2f80c0]" href="#services">Services</a>
          <a className="transition-colors hover:text-[#2f80c0]" href="#catalog">Medicine</a>
          <a className="transition-colors hover:text-[#2f80c0]" href="#booking">Appointments</a>
          <a className="transition-colors hover:text-[#2f80c0]" href="#ai">AI Assistant</a>
          <a className="transition-colors hover:text-[#2f80c0]" href="/admin">Admin</a>
        </nav>

        <div className="flex items-center gap-2">
        <button type="button" onClick={toggleTheme} className="rounded-xl border border-[#d9e7f0] bg-white px-3 py-2 text-lg shadow-sm transition hover:bg-[#e7f4fc] dark:border-slate-600 dark:bg-slate-800 dark:hover:bg-slate-700" aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
          {isDark ? '☀️' : '🌙'}
        </button>
        <button type="button" className="rounded-xl bg-[#2f80c0] px-4 py-3 font-bold text-white shadow-lg shadow-[#2f80c0]/20 transition hover:bg-[#18527f]">
          Order Medicines
        </button>
        </div>
      </header>

      <main className="space-y-20">
        <section className="relative isolate mt-6 grid min-h-[620px] grid-cols-[1.1fr_0.9fr] items-center gap-10 overflow-hidden rounded-[28px] bg-[#172b3d] bg-[linear-gradient(90deg,rgba(18,49,75,.92),rgba(18,49,75,.76),rgba(18,49,75,.18)),url('/Hero.png')] bg-cover bg-center px-[clamp(1.75rem,6vw,5.5rem)] py-[clamp(2.75rem,7vw,5.75rem)] shadow-2xl shadow-[#18527f]/20 max-lg:grid-cols-1 max-lg:min-h-0 max-sm:px-6 dark:bg-[linear-gradient(90deg,rgba(8,20,34,.94),rgba(8,20,34,.8),rgba(8,20,34,.3)),url('/Hero.png')]">
          <div className="relative z-10">
            <p className="mb-3 text-xs font-bold uppercase tracking-[.12em] text-[#bfe4fb]">Your neighborhood pharmacy, now closer</p>
            <h1 className="max-w-2xl text-5xl font-extrabold leading-tight tracking-tight text-white max-sm:text-4xl">Better care for every day, delivered with confidence.</h1>
            <p className="mt-5 max-w-xl text-lg leading-7 text-white/85">
              From prescription support to wellness essentials, Apollo Pharmacy helps families stay healthy,
              informed, and cared for from the comfort of home.
            </p>

            <div className="mt-7 flex flex-wrap gap-3">
              <button type="button" className="rounded-xl bg-[#2f80c0] px-6 py-4 font-bold text-white shadow-lg shadow-[#2f80c0]/30 transition hover:bg-[#18527f]">
                Shop now
              </button>
            </div>

          </div>
        </section>

        <section id="services" className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[.12em] text-[#2f80c0]">What we offer</p>
            <h2 className="text-4xl font-extrabold tracking-tight text-[#172b3d] dark:text-white max-sm:text-3xl">Complete healthcare support in one place</h2>
          </div>

          <div className="grid grid-cols-3 gap-5 max-lg:grid-cols-1">
            {services.map((service) => (
              <article className="rounded-2xl border border-[#d9e7f0] bg-white p-6 shadow-lg shadow-[#18527f]/5 dark:border-slate-700 dark:bg-[#172b3d]" key={service.title}>
                <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-[#e7f4fc] text-2xl" aria-hidden="true">{service.icon}</div>
                <h3 className="mb-2 text-xl font-bold text-[#172b3d] dark:text-white">{service.title}</h3>
                <p className="leading-7 text-[#607487] dark:text-slate-300">{service.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="catalog" className="space-y-5">
          <div className="flex items-end justify-between gap-4 max-sm:flex-col max-sm:items-start">
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-[.12em] text-[#2f80c0]">Medicine catalog</p>
              <h2 className="text-4xl font-extrabold tracking-tight text-[#172b3d] dark:text-white max-sm:text-3xl">Find trusted medicines and wellness products</h2>
            </div>
            <a href="/medicines" className="rounded-xl border border-[#2f80c0] bg-white px-4 py-3 font-bold text-[#2f80c0] transition hover:bg-[#e7f4fc] dark:bg-[#172b3d]">
              View all products
            </a>
          </div>

          {catalogError && <p className="rounded-xl bg-[#fff0ef] p-4 font-semibold text-[#b94f49]">{catalogError}</p>}
          {!catalogError && inventory.length === 0 && <p className="rounded-xl border border-[#d9e7f0] bg-white p-6 text-[#607487]">Loading live medicine catalog...</p>}
          {inventory.length > 0 && <MedicineCatalog medicines={inventory} remoteSearch scrollable />}
        </section>

        <section id="booking" className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[.12em] text-[#2f80c0]">Appointments</p>
            <h2 className="text-4xl font-extrabold tracking-tight text-[#172b3d] dark:text-white max-sm:text-3xl">Schedule your consultation in minutes</h2>
          </div>

          <div className="grid grid-cols-[.9fr_1.1fr] items-start gap-5 max-lg:grid-cols-1">
            <div className="rounded-3xl border border-[#d9e7f0] bg-gradient-to-b from-[#e7f4fc] to-white p-6 dark:border-slate-700 dark:from-[#1d3d58] dark:to-[#172b3d]">
              {doctors.length === 0 ? <p className="text-[#607487]">Loading doctor schedules...</p> : doctors.map((doctor) => <article className="border-b border-[#d9e7f0] py-4 last:border-0 dark:border-slate-600" key={doctor.id}>
                <h3 className="font-bold text-[#172b3d] dark:text-white">{doctor.name}</h3>
                <p className="text-[#607487] dark:text-slate-300">{doctor.specialty}</p>
                <p className="mt-2 text-sm text-[#607487] dark:text-slate-300">{doctor.qualifications.join(' · ')}</p>
                <p className="mt-2 text-sm text-[#607487] dark:text-slate-300">Registration: {doctor.registrationNumber}</p>
                <p className="mt-2 text-sm text-[#607487] dark:text-slate-300">Morning: {doctor.visitingHours.morning}</p>
                <p className="text-sm text-[#607487] dark:text-slate-300">Evening: {doctor.visitingHours.evening}</p>
                <p className="mt-2 text-sm text-[#607487] dark:text-slate-300">Contact: {doctor.contactNumbers.join(' · ')}</p>
              </article>)}
            </div>

            <AppointmentForm doctors={doctors} />
          </div>
        </section>

        <section id="ai" className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[.12em] text-[#2f80c0]">Health assistant</p>
            <h2 className="text-4xl font-extrabold tracking-tight text-[#172b3d] dark:text-white max-sm:text-3xl">Ask Apollo AI for quick guidance</h2>
          </div>
          <AiChatbot />
        </section>

      </main>

      <footer className="mt-20 flex items-center justify-between gap-5 rounded-2xl bg-[#18527f] px-7 py-7 text-white max-sm:flex-col max-sm:items-start">
        <div>
          <div className="flex items-center gap-3">
            <img className="h-9 w-9 rounded-full object-contain" src="/logo.jpeg" alt="" aria-hidden="true" />
            <div className="font-extrabold">Apollo Pharmacy</div>
          </div>
          <p className="mt-2 text-white/75">Care for every generation, every day.</p>
        </div>
        <div className="flex gap-5 text-white/85">
          <a href="#services">Services</a>
          <a href="#catalog">Catalog</a>
          <a href="#booking">Book visit</a>
        </div>
      </footer>
      </div>
    </div>
  )
}

export default function App() {
  if (window.location.pathname === '/admin') return <AdminPage />
  if (window.location.pathname === '/medicines') return <MedicinePage />
  return <PublicApp />
}
