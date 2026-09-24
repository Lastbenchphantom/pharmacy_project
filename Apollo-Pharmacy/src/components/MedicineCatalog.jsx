import { useEffect, useMemo, useState } from 'react'
import { getMedicines } from '../api'

const defaultMedicines = [
  { id: 'ap-101', brandName: 'Napa Extra', genericName: 'Paracetamol', manufacturer: 'Square Pharma', strength: '500mg', category: 'General Care', availableQty: 24 },
  { id: 'ap-102', brandName: 'Seclo', genericName: 'Omeprazole', manufacturer: 'Incepta', strength: '20mg', category: 'General Care', availableQty: 8 },
  { id: 'ap-103', brandName: 'Sergel', genericName: 'Cefixime', manufacturer: 'ACME', strength: '200mg', category: 'General Care', availableQty: 0 },
  { id: 'ap-104', brandName: 'Cenovit', genericName: 'Multivitamin', manufacturer: 'Beximco', strength: '30 tablets', category: 'Vitamins', availableQty: 32 },
  { id: 'ap-105', brandName: 'Axe', genericName: 'Hair Growth', manufacturer: 'Skinplus', strength: '60ml', category: 'Skin & Hair', availableQty: 12 },
  { id: 'ap-106', brandName: 'GlucoCare', genericName: 'Diabetes support', manufacturer: 'Orion', strength: '30 capsules', category: 'Diabetes', availableQty: 15 },
  { id: 'ap-107', brandName: 'BabyCal', genericName: 'Calcium complex', manufacturer: 'HealthyNest', strength: '90 tablets', category: 'Baby Care', availableQty: 7 },
  { id: 'ap-108', brandName: 'CardioPlus', genericName: 'Omega + CoQ10', manufacturer: 'Lifecare', strength: '30 softgels', category: 'Heart Care', availableQty: 11 },
]

export default function MedicineCatalog({ medicines = defaultMedicines, scrollable = false, remoteSearch = false }) {
  const [catalogMedicines, setCatalogMedicines] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState('All')
  const [reservedIds, setReservedIds] = useState([])
  const [suggestions, setSuggestions] = useState([])
  const medicinesToDisplay = catalogMedicines || medicines
  const categoryFilters = ['All', ...new Set(medicinesToDisplay.map((item) => item.category))]

  const withCategory = (items) => items.map((medicine) => ({ ...medicine, category: medicine.category || 'General Care' }))

  useEffect(() => {
    const query = searchQuery.trim()
    if (!remoteSearch || query.length < 2) return undefined

    let cancelled = false
    getMedicines({ limit: 20, search: query })
      .then((results) => {
        if (!cancelled) {
          const medicines = withCategory(results)
          setCatalogMedicines(medicines)
          setSuggestions(medicines.slice(0, 6))
        }
      })
      .catch(() => {
        if (!cancelled) setSuggestions([])
      })

    return () => {
      cancelled = true
    }
  }, [remoteSearch, searchQuery])

  const filteredMedicines = useMemo(() => {
    const displayMedicines = remoteSearch && searchQuery.trim().length < 2 ? medicines : medicinesToDisplay
    return displayMedicines.filter((medicine) => {
      const matchesCategory = activeCategory === 'All' || medicine.category === activeCategory
      const matchesSearch = medicine.brandName.toLowerCase().startsWith(searchQuery.toLowerCase())

      return matchesCategory && matchesSearch
    })
  }, [activeCategory, medicines, medicinesToDisplay, remoteSearch, searchQuery])

  const searchDatabase = async (event) => {
    event.preventDefault()
    const query = searchQuery.trim()
    if (!remoteSearch || !query) return
    const results = await getMedicines({ limit: 20, search: query })
    setCatalogMedicines(withCategory(results))
    setSuggestions([])
    setActiveCategory('All')
  }

  const selectSuggestion = (medicine) => {
    setSearchQuery(medicine.brandName)
    setCatalogMedicines([medicine])
    setSuggestions([])
    setActiveCategory('All')
  }

  const toggleReservation = (id) => {
    setReservedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  return (
    <div className="rounded-3xl border border-[#d9e7f0] bg-white p-5 shadow-lg shadow-[#18527f]/5 dark:border-slate-700 dark:bg-[#172b3d]">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <form onSubmit={searchDatabase} className="relative flex min-w-[220px] flex-1 gap-2">
          <span className="search-icon" aria-hidden="true">
            🔎
          </span>
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search by brand name"
            aria-label="Search medicine catalog"
          />
          {remoteSearch && <button type="submit" className="rounded-xl bg-[#2f80c0] px-4 py-2 text-sm font-bold text-white hover:bg-[#18527f]">Search</button>}
          {remoteSearch && suggestions.length > 0 && <div className="absolute left-0 right-[78px] top-full z-10 mt-2 overflow-hidden rounded-xl border border-[#d9e7f0] bg-white shadow-xl dark:border-slate-600 dark:bg-[#172b3d]">
            {suggestions.map((medicine) => <button key={medicine.id} type="button" onClick={() => selectSuggestion(medicine)} className="block w-full border-b border-[#d9e7f0] px-4 py-3 text-left last:border-0 hover:bg-[#e7f4fc] dark:border-slate-700 dark:hover:bg-slate-700">
              <strong className="block text-sm dark:text-white">{medicine.brandName}</strong>
              <span className="text-xs text-[#607487] dark:text-slate-300">{medicine.genericName} · {medicine.strength}</span>
            </button>)}
          </div>}
        </form>

        <div className="flex flex-wrap gap-2" aria-label="Medicine categories">
          {categoryFilters.map((category) => (
            <button
              key={category}
              type="button"
              className={`rounded-xl px-3 py-2 text-xs font-bold transition ${activeCategory === category ? 'bg-[#2f80c0] text-white' : 'bg-[#e7f4fc] text-[#172b3d] dark:bg-slate-700 dark:text-slate-200'}`}
              onClick={() => setActiveCategory(category)}
            >
              {category}
            </button>
          ))}
        </div>
      </div>

      {filteredMedicines.length === 0 ? (
        <div className="p-8 text-center text-[#607487]">No medicines match your search. Try a different keyword.</div>
      ) : (
        <div className={`${scrollable ? 'max-h-[68vh] overflow-y-auto pr-2' : ''} grid grid-cols-3 gap-4 max-lg:grid-cols-1`}>
          {filteredMedicines.map((medicine) => {
            const isReserved = reservedIds.includes(medicine.id)
            const isAvailable = medicine.availableQty > 0

            return (
              <article key={medicine.id} className="flex flex-col gap-4 rounded-2xl border border-[#d9e7f0] bg-[#f4f9fc] p-5 dark:border-slate-700 dark:bg-slate-800">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-bold text-[#172b3d] dark:text-white">{medicine.brandName}</h3>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-[#607487] dark:bg-slate-700">{medicine.strength}</span>
                </div>

                <p className="text-xs uppercase tracking-widest text-[#607487]">{medicine.manufacturer}</p>
                <p className="text-sm text-[#607487]">Generic: {medicine.genericName}</p>
                <div className="flex flex-wrap gap-2 text-xs font-bold text-[#18527f] dark:text-slate-200">
                  <span>Piece: ৳{Number(medicine.singlePiecePrice || 0).toFixed(2)}</span>
                  <span>Box: ৳{Number(medicine.fullBoxPrice || 0).toFixed(2)}</span>
                </div>

                <div className="flex items-center justify-between border-t border-[#d9e7f0] pt-4">
                  <span className={`rounded-full px-3 py-2 text-xs font-bold ${isAvailable ? 'bg-[#e7f4fc] text-[#18527f]' : 'bg-[#fff0ef] text-[#b94f49]'}`}>
                    {isAvailable ? `Available (${medicine.availableQty})` : 'Out of stock'}
                  </span>

                  <button
                    type="button"
                    className={`rounded-xl px-3 py-2 text-xs font-bold transition ${isReserved ? 'bg-slate-200 text-[#172b3d] dark:bg-slate-700 dark:text-white' : 'bg-[#2f80c0] text-white hover:bg-[#18527f]'}`}
                    onClick={() => toggleReservation(medicine.id)}
                  >
                    {isReserved ? 'Added' : isAvailable ? 'Reserve' : 'Consult doctor'}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
