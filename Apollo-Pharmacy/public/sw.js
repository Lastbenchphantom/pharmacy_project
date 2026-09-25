/* Apollo Pharmacy admin push service worker */
self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(Promise.resolve())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = {
    title: 'Apollo Pharmacy',
    body: 'You have a pharmacy alert.',
    url: '/admin',
  }
  try {
    if (event.data) data = { ...data, ...event.data.json() }
  } catch {
    try {
      data.body = event.data?.text() || data.body
    } catch {
      // keep defaults
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Apollo Pharmacy', {
      body: data.body || 'Pharmacy alert',
      icon: '/logo.jpeg',
      badge: '/logo.jpeg',
      data: { url: data.url || '/admin' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/admin'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate?.(targetUrl)
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl)
      return undefined
    }),
  )
})
