// Lost Dogs Ayrshire: receives phone notifications while the app is closed.
// This file must sit next to index.html and keep this exact name.
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBvsSYYymjt0h9v9cynw2_oophP0BNG0I8",
  authDomain: "lost-dogs-ayrshire.firebaseapp.com",
  projectId: "lost-dogs-ayrshire",
  storageBucket: "lost-dogs-ayrshire.firebasestorage.app",
  messagingSenderId: "302116971454",
  appId: "1:302116971454:web:e336d94d271ee433410fef"
});

// Firebase shows each notification and opens the right page when it is tapped.
firebase.messaging();

// ---- App badge (5.1): the red number on the Home Screen icon ----
// Each alert that arrives while the app is not on screen adds 1. Opening the app clears it.
// The count is kept in a tiny cache entry, as this background part has no other storage.
const BADGE_CACHE = 'lda-badge', BADGE_KEY = '/__badge_count';
async function badgeCount() {
  try { const r = await (await caches.open(BADGE_CACHE)).match(BADGE_KEY); return r ? (parseInt(await r.text(), 10) || 0) : 0; } catch (e) { return 0; }
}
async function setBadgeCount(n) {
  try { await (await caches.open(BADGE_CACHE)).put(BADGE_KEY, new Response(String(n))); } catch (e) {}
  try { if (self.navigator.setAppBadge) { if (n > 0) await self.navigator.setAppBadge(n); else if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge(); } } catch (e) {}
}
async function onAlertArrived() {
  const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (open.some(c => c.visibilityState === 'visible')) return;      // the app is on screen: no badge needed
  await setBadgeCount((await badgeCount()) + 1);
}
self.addEventListener('push', event => { event.waitUntil(onAlertArrived()); });
self.addEventListener('message', event => {                          // the app says "I've been opened"
  if (event.data && event.data.type === 'clear-badge') event.waitUntil(setBadgeCount(0));
});
