import { useState } from 'react'
import { sendChat } from '../api'

const quickPrompts = [
  'How do I manage fever at home?',
  'What vitamin should I take daily?',
  'When should I refill a prescription?',
]

const botResponses = {
  fever: 'Rest, hydrate, and monitor your temperature. If fever lasts more than 3 days or you have breathing difficulty, seek medical attention promptly.',
  vitamin: 'A balanced diet with vitamin D, B12, and iron often helps. If you have a specific deficiency, a clinician can recommend the right supplement.',
  refill: 'Try to refill 5–7 days before your current stock runs out, especially for recurring prescriptions or chronic conditions.',
  default: 'For personal health questions, please speak with a licensed clinician. I can help with general wellness tips and pharmacy product questions.',
}

const localReply = (question) => {
  const text = question.toLowerCase()
  if (text.includes('fever') || text.includes('flu')) return botResponses.fever
  if (text.includes('vitamin') || text.includes('supplement')) return botResponses.vitamin
  if (text.includes('refill') || text.includes('prescription')) return botResponses.refill
  return botResponses.default
}

export default function AiChatbot() {
  const [messages, setMessages] = useState([
    {
      id: 1,
      sender: 'bot',
      text: 'Hi! I am Health AI Assistant. Ask about medicines, wellness, or safe self-care advice.',
    },
  ])
  const [input, setInput] = useState('')
  const [isSending, setIsSending] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!input.trim() || isSending) return

    const question = input.trim()
    const nextUserMessage = { id: Date.now(), sender: 'user', text: question }
    setMessages((current) => [...current, nextUserMessage])
    setInput('')
    setIsSending(true)

    try {
      const result = await sendChat(question)
      const reply = typeof result.response === 'string' && result.response.trim()
        ? result.response.trim()
        : localReply(question)
      setMessages((current) => [...current, { id: Date.now() + 1, sender: 'bot', text: reply }])
    } catch {
      setMessages((current) => [...current, { id: Date.now() + 1, sender: 'bot', text: localReply(question) }])
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="rounded-3xl border border-[#d9e7f0] bg-white p-5 shadow-lg shadow-[#18527f]/5 dark:border-slate-700 dark:bg-[#172b3d]">
      <div className="flex min-h-[260px] max-h-[360px] flex-col gap-3 overflow-auto pr-2">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`max-w-[80%] rounded-2xl px-4 py-3 leading-6 ${message.sender === 'user' ? 'ml-auto bg-[#2f80c0] text-white' : 'bg-[#e7f4fc] text-[#172b3d] dark:bg-slate-800 dark:text-slate-100'}`}
          >
            {message.text}
          </div>
        ))}
        {isSending && (
          <div className="max-w-[80%] rounded-2xl bg-[#e7f4fc] px-4 py-3 text-sm text-[#607487] dark:bg-slate-800">Thinking…</div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {quickPrompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="rounded-full bg-[#e7f4fc] px-3 py-2 text-xs font-semibold text-[#18527f] dark:bg-slate-700 dark:text-slate-200"
            onClick={() => setInput(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>

      <form className="mt-5 flex gap-3 max-sm:flex-col" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask Apollo AI..."
          aria-label="Ask Apollo AI"
          className="flex-1 rounded-xl border border-[#d9e7f0] bg-[#f4f9fc] px-4 py-3 text-[#172b3d] outline-none focus:ring-2 focus:ring-[#2f80c0] dark:border-slate-600 dark:bg-slate-800 dark:text-white"
        />
        <button type="submit" disabled={isSending} className="rounded-xl bg-[#2f80c0] px-5 py-3 font-bold text-white transition hover:bg-[#18527f] disabled:opacity-60">
          {isSending ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  )
}
