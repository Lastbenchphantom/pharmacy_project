import { useEffect, useState } from 'react'
import { getPushStatus, subscribePush, unsubscribePush } from '../api'

const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index)
  return output
}

export default function PushOptIn({ token, onMessage }) {
  const [enabled, setEnabled] = useState(false)
  const [publicKey, setPublicKey] = useState('')
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')

  useEffect(() => {
    let cancelled = false
    getPushStatus(token)
      .then(async (status) => {
        if (cancelled) return
        setEnabled(Boolean(status.enabled))
        setPublicKey(status.publicKey || '')
        setReason(status.reason || '')
        if (!status.enabled || !('serviceWorker' in navigator) || !('PushManager' in window)) return
        const registration = await navigator.serviceWorker.register('/sw.js')
        const existing = await registration.pushManager.getSubscription()
        if (!cancelled) setSubscribed(Boolean(existing))
      })
      .catch((error) => {
        if (!cancelled) setReason(error.message)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const enablePush = async () => {
    setBusy(true)
    try {
      if (!enabled || !publicKey) {
        onMessage?.({ type: 'error', text: 'Push is not configured (missing VAPID keys on the server).' })
        return
      }
      if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        onMessage?.({ type: 'error', text: 'This browser does not support push notifications.' })
        return
      }
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        onMessage?.({ type: 'error', text: 'Notification permission was not granted.' })
        return
      }
      const registration = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        })
      }
      await subscribePush(token, subscription.toJSON())
      setSubscribed(true)
      onMessage?.({ type: 'success', text: 'Browser push alerts enabled for this device.' })
    } catch (error) {
      onMessage?.({ type: 'error', text: error.message })
    } finally {
      setBusy(false)
    }
  }

  const disablePush = async () => {
    setBusy(true)
    try {
      const registration = await navigator.serviceWorker.getRegistration()
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        await unsubscribePush(token, subscription.endpoint)
        await subscription.unsubscribe()
      }
      setSubscribed(false)
      onMessage?.({ type: 'success', text: 'Browser push alerts disabled on this device.' })
    } catch (error) {
      onMessage?.({ type: 'error', text: error.message })
    } finally {
      setBusy(false)
    }
  }

  if (!enabled) {
    return (
      <p className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-3 text-sm text-[#607487] dark:border-slate-700 dark:bg-[#172b3d]">
        Browser push disabled{reason ? ` (${reason})` : ''}. Email alerts still work when SMTP is configured.
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {subscribed ? (
        <button type="button" disabled={busy} onClick={disablePush} className="rounded-xl border border-[#d9e7f0] bg-white px-4 py-2 text-sm font-bold dark:border-slate-700 dark:bg-[#172b3d] disabled:opacity-60">
          {busy ? 'Updating…' : 'Disable push alerts'}
        </button>
      ) : (
        <button type="button" disabled={busy} onClick={enablePush} className="rounded-xl border border-[#2f80c0] bg-white px-4 py-2 text-sm font-bold text-[#2f80c0] disabled:opacity-60">
          {busy ? 'Enabling…' : 'Enable browser push alerts'}
        </button>
      )}
      <span className="text-xs text-[#607487]">{subscribed ? 'This device will receive expiry pushes.' : 'Opt in to daily expiry push alerts.'}</span>
    </div>
  )
}
