export default function DashboardStats({ stats, isLoading }) {
  const cards = [
    ['Total medicines', stats?.totalMedicines],
    ['Low stock', stats?.lowStockCount],
    ['Expiring soon', stats?.expiringSoonCount],
    ['Expired', stats?.expiredCount],
    ['Pending appointments', stats?.pendingAppointments],
    ['Pending receipts', stats?.pendingReceipts],
  ]

  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {cards.map(([label, value]) => (
        <article key={label} className="rounded-2xl border border-[#d9e7f0] bg-white p-4 dark:border-slate-700 dark:bg-[#172b3d]">
          <p className="text-xs font-bold uppercase tracking-wide text-[#607487]">{label}</p>
          <p className="mt-2 text-3xl font-extrabold text-[#172b3d] dark:text-white">
            {isLoading ? '—' : (value ?? 0)}
          </p>
        </article>
      ))}
    </section>
  )
}
