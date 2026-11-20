// FlightOps has moved into the Lost Dogs Ayrshire app.
// This replaces the old offline helper: it clears the old saved copy of the page so phones load the
// latest version, then switches itself off. Flight records (kept separately on the phone) are not touched.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  await self.clients.claim();
  await self.registration.unregister();
  const wins = await self.clients.matchAll({ type: 'window' });
  wins.forEach(w => w.navigate(w.url));     // reload open pages so the new version shows straight away
})()));
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });   // always the latest from the website
