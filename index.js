// Lost Dogs Ayrshire: the notification sender.
// The app calls this when a coordinator or admin adds a dog, asks for availability or posts an update,
// when a coordinator asks for a post to be removed, and when someone asks to join.
// It checks who is asking, works out who should be told, and sends the notification to their phones.
// It also tidies away closed cases each night, and deletes a removed volunteer when an admin asks.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 2, memory: '256MiB', timeoutSeconds: 30 });

// Where the app lives. Tapping a notification opens this address.
const SITE = 'https://lostdogsayrshiredrones-netizen.github.io/Lost-Dogs-Ayrshire/';

const STATUS = { missing: 'Missing', loose: 'Loose dog', found: 'Found' };

// Send one notification to every phone belonging to the given people.
async function sendTo(uids, title, body, link, type) {
  const wanted = new Set(uids);
  if (!wanted.size) return { sent: 0, failed: 0 };
  const db = admin.firestore();
  const phones = (await db.collection('devices').get()).docs.filter(d => wanted.has(d.data().uid) && d.data().token);
  if (!phones.length) return { sent: 0, failed: 0 };

  const result = await admin.messaging().sendEachForMulticast({
    tokens: phones.map(d => d.data().token),
    notification: { title, body },
    data: { type: String(type || ''), link },
    webpush: {
      // High priority so Android delivers it straight away, even when the phone is idle (battery saving
      // holds back normal-priority alerts). Kept for a day if the phone is off or out of signal.
      headers: { Urgency: 'high', TTL: '86400' },
      notification: { icon: SITE + 'icon-192.png', badge: SITE + 'icon-192.png', vibrate: [200, 100, 200, 100, 300] },
      fcmOptions: { link }
    }
  });

  // Phones that have removed the app or switched notifications off are forgotten.
  const gone = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];
  await Promise.all(result.responses.map((r, i) =>
    (!r.success && r.error && gone.includes(r.error.code)) ? phones[i].ref.delete() : null));
  return { sent: result.successCount, failed: result.failureCount };
}

async function peopleWithRole(roles) {
  const snap = await admin.firestore().collection('users').where('role', 'in', roles).get();
  return snap.docs.map(d => d.id);
}

exports.notify = onCall(async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = request.auth.uid;
  const db = admin.firestore();
  const me = await db.collection('users').doc(uid).get();
  if (!me.exists) throw new HttpsError('permission-denied', 'No member record.');
  const role = me.data().role;
  const type = request.data && request.data.type;

  // Someone has just created an account: tell the admins, once only.
  if (type === 'join') {
    if (role !== 'pending' || me.data().joinNotified) return { sent: 0, failed: 0 };
    await me.ref.update({ joinNotified: true });
    const name = String(me.data().name || 'Someone').slice(0, 60);
    return sendTo(await peopleWithRole(['admin', 'developer']), 'Join request', name + ' has asked to join.', SITE + '#members', 'join');
  }

  // An admin has sent a document for review: tell the developer.
  // The developer has approved or rejected one: tell the admin who added it.
  if (type === 'doc' || type === 'docReview') {
    const docId = String((request.data && request.data.docId) || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(docId)) throw new HttpsError('invalid-argument', 'Which document?');
    const d = await db.collection('docs').doc(docId).get();
    if (!d.exists) throw new HttpsError('not-found', 'That document is not there.');
    const doc = d.data(), title = String(doc.title || 'a document').slice(0, 80), link = SITE + '#documents';
    if (type === 'doc') {
      if (!['admin', 'developer'].includes(role) || doc.addedByUid !== uid || doc.status !== 'pending') throw new HttpsError('permission-denied', 'Not allowed.');
      const devs = (await peopleWithRole(['developer'])).filter(id => id !== uid);
      return sendTo(devs, 'Document to review', String(me.data().name || 'An admin').slice(0, 60) + ' added \u201c' + title + '\u201d.', link, 'doc');
    }
    if (role !== 'developer' || !['approved', 'rejected'].includes(doc.status) || !doc.addedByUid || doc.addedByUid === uid) return { sent: 0, failed: 0 };
    return sendTo([doc.addedByUid], doc.status === 'approved' ? 'Document approved' : 'Document not approved',
      '\u201c' + title + '\u201d ' + (doc.status === 'approved' ? 'is now in the app.' : 'was not added' + (doc.rejectReason ? ': ' + String(doc.rejectReason).slice(0, 120) : '.')), link, 'docReview');
  }

  // Everything else is for coordinators and admins only.
  if (!['admin', 'developer', 'coordinator'].includes(role)) throw new HttpsError('permission-denied', 'Coordinators and admins only.');
  const dogId = String((request.data && request.data.dogId) || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(dogId)) throw new HttpsError('invalid-argument', 'Which dog?');
  const dogSnap = await db.collection('dogs').doc(dogId).get();
  if (!dogSnap.exists) throw new HttpsError('not-found', 'That dog is not listed.');
  const dog = dogSnap.data();
  // Notifications name the place, not the dog: many dogs are added as "Unknown".
  // The name is only used when there is no place.
  const place = String(dog.lastSeenPlace || '').trim().slice(0, 80), name = String(dog.name || '').trim().slice(0, 60);
  const where = place || (/^(unknown|unnamed.*|not known|no name|n\/a|\?+)?$/i.test(name) ? '' : name);
  const say = (...parts) => parts.filter(Boolean).join('. ');
  const everyoneElse = (await peopleWithRole(['member', 'coordinator', 'admin', 'developer'])).filter(id => id !== uid);
  const link = SITE + '#dog/' + dogId;

  if (type === 'dog') {
    const label = STATUS[dog.status] || 'Missing';
    return sendTo(everyoneElse, 'New dog: ' + label, say(where, dog.askAvailability ? 'Can you help? Please give your availability.' : '') || 'Open the app for details.', link, 'dog');
  }
  if (type === 'availability') {
    return sendTo(everyoneElse, 'Availability needed', say(where, 'Can you help with this search?'), link, 'availability');
  }
  // A coordinator has asked for a dog's post to be removed: tell the admins.
  if (type === 'removal') {
    const admins = (await peopleWithRole(['admin', 'developer'])).filter(id => id !== uid);
    const who = String(me.data().name || 'A coordinator').slice(0, 60);
    return sendTo(admins, 'Removal request', who + ' has asked to remove ' + (where ? 'the post for ' + where : 'a post') + '.', link, 'removal');
  }
  // A coordinator or admin has posted an update on a dog's page.
  if (type === 'update') {
    const updateId = String((request.data && request.data.updateId) || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(updateId)) throw new HttpsError('invalid-argument', 'Which update?');
    const update = await db.collection('dogs').doc(dogId).collection('updates').doc(updateId).get();
    if (!update.exists) throw new HttpsError('not-found', 'That update is not there.');
    const text = String(update.data().text || '').replace(/\s+/g, ' ').trim();
    return sendTo(everyoneElse, where ? 'Update: ' + where : 'Dog update', text.length > 160 ? text.slice(0, 157) + '...' : text, link, 'update');
  }
  throw new HttpsError('invalid-argument', 'Unknown request.');
});

// ---- Closed cases tidy themselves away ----
// Once a day, any dog that has been closed (Reunited, Home safe, No further sightings, Paws down)
// for more than 30 days is deleted, together with its photos, posters, updates, sightings and availability.
// Reopening a dog (changing it back to Missing, Loose dog or Found) stops the clock.
const CLOSED = ['reunited', 'home-safe', 'no-further-sightings', 'paws-down'];
const KEEP_DAYS = 30;
const millis = ts => (ts && typeof ts.toMillis === 'function') ? ts.toMillis() : 0;

exports.tidyClosedDogs = onSchedule({ schedule: 'every day 03:00', timeZone: 'Europe/London' }, async () => {
  const db = admin.firestore();
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  const closed = await db.collection('dogs').where('status', 'in', CLOSED).get();
  let removed = 0;
  for (const dog of closed.docs) {
    const d = dog.data();
    const closedAt = millis(d.statusAt) || millis(d.updatedAt) || millis(d.createdAt);   // older dogs have no closing date, so use the last change
    if (closedAt && closedAt < cutoff) { await db.recursiveDelete(dog.ref); removed++; }
  }
  console.log('Closed cases removed:', removed);
  await tidyReports();   // public reports: see further down
});

// ---- Delete a volunteer for good ----
// Only an admin (or the developer) can do this, and only for someone whose access has already been removed.
// It deletes their member record, profile, signed agreement, SOP sign-offs, availability replies,
// registered phones and their sign-in, so the email address can sign up afresh if they ever return.
// Names written into dog updates and sightings stay, as a record of the searches they helped with.
exports.deleteVolunteer = onCall(async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = admin.firestore();
  const me = await db.collection('users').doc(request.auth.uid).get();
  if (!me.exists || !['admin', 'developer'].includes(me.data().role)) throw new HttpsError('permission-denied', 'Admins only.');
  const uid = String((request.data && request.data.uid) || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || uid === request.auth.uid) throw new HttpsError('invalid-argument', 'Which volunteer?');
  const user = await db.collection('users').doc(uid).get();
  if (!user.exists) throw new HttpsError('not-found', 'That person is not on the members list.');
  if (user.data().role !== 'blocked') throw new HttpsError('failed-precondition', 'Remove their access first.');

  const gone = [];
  const drop = async ref => { await ref.delete(); gone.push(ref.path); };
  await drop(db.collection('profiles').doc(uid));
  await drop(db.collection('agreements').doc(uid));
  for (const d of (await db.collection('sopReads').where('uid', '==', uid).get()).docs) await drop(d.ref);
  for (const d of (await db.collection('devices').where('uid', '==', uid).get()).docs) await drop(d.ref);
  for (const dog of (await db.collection('dogs').get()).docs) await drop(dog.ref.collection('availability').doc(uid));
  await drop(user.ref);
  try { await admin.auth().deleteUser(uid); }
  catch (e) { if (!e || e.code !== 'auth/user-not-found') throw new HttpsError('internal', 'Their records were deleted but their sign-in could not be. Try again.'); }
  return { deleted: true };
});

// ---- Facebook: post a poster to the Lost Dogs Ayrshire Page ----
// The Page's key is kept in fbsecret/page, which the app itself can never read (the security rules
// allow no access at all). Only these functions use it. settings/facebook holds what the app may show:
// whether a Page is linked, its name and when.
const GRAPH = 'https://graph.facebook.com/';
const FB_ROLES = ['coordinator', 'admin', 'developer'];

async function graph(method, path, params) {
  const url = GRAPH + path;
  let res;
  if (method === 'GET') res = await fetch(url + '?' + new URLSearchParams(params));
  else res = await fetch(url, { method, body: params });
  let json = {};
  try { json = await res.json(); } catch (e) {}
  if (!res.ok || json.error) {
    const e = json.error || {};
    const err = new Error(e.message || ('Facebook said ' + res.status));
    err.fb = e;
    throw err;
  }
  return json;
}
// Turn a Facebook problem into a message a volunteer can act on.
function fbProblem(err) {
  const e = (err && err.fb) || {};
  if (e.code === 190 || e.code === 102 || e.type === 'OAuthException' && /session|token|expired|password/i.test(e.message || ''))
    return new HttpsError('failed-precondition', 'The Facebook link needs renewing. Ask the developer to link Facebook again.');
  if (e.code === 10 || e.code === 200 || (e.code >= 200 && e.code < 300))
    return new HttpsError('permission-denied', 'Facebook did not allow the post. Ask the developer to link Facebook again.');
  if (e.code === 4 || e.code === 17 || e.code === 32 || e.code === 368)
    return new HttpsError('resource-exhausted', 'Facebook is limiting posts right now. Please try again later.');
  return new HttpsError('unavailable', 'Facebook could not be reached' + (e.message ? ': ' + String(e.message).slice(0, 200) : '.'));
}
async function caller(request, roles) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const me = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (!me.exists || !roles.includes(me.data().role)) throw new HttpsError('permission-denied', 'Not allowed.');
  return { uid: request.auth.uid, name: String(me.data().name || '').slice(0, 80) };
}

// The developer links (or unlinks) the Page. They paste the App ID and App secret from their Meta app
// and a user token from the Graph API Explorer; this swaps it for a Page key that does not expire.
exports.facebookLink = onCall({ timeoutSeconds: 60 }, async request => {
  const me = await caller(request, ['developer']);
  const db = admin.firestore(), d = request.data || {};
  if (d.unlink) {
    await db.collection('fbsecret').doc('page').delete();
    await db.collection('settings').doc('facebook').set({ connected: false, unlinkedAt: admin.firestore.FieldValue.serverTimestamp(), unlinkedBy: me.name });
    return { unlinked: true };
  }
  const appId = String(d.appId || '').trim(), appSecret = String(d.appSecret || '').trim(), userToken = String(d.userToken || '').trim();
  if (!/^\d{5,25}$/.test(appId)) throw new HttpsError('invalid-argument', 'The App ID should be a long number.');
  if (!/^[A-Za-z0-9]{16,64}$/.test(appSecret)) throw new HttpsError('invalid-argument', 'The App secret does not look right.');
  if (userToken.length < 20 || /\s/.test(userToken)) throw new HttpsError('invalid-argument', 'The access token does not look right.');
  let pages;
  try {
    const long = await graph('GET', 'oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: userToken });
    pages = (await graph('GET', 'me/accounts', { fields: 'id,name,access_token,tasks', limit: '100', access_token: long.access_token })).data || [];
  } catch (err) {
    throw new HttpsError('failed-precondition', 'Facebook did not accept those details' + (err.fb && err.fb.message ? ': ' + String(err.fb.message).slice(0, 200) : '.'));
  }
  pages = pages.filter(p => p.access_token);
  if (!pages.length) throw new HttpsError('failed-precondition', 'No Pages were found. Make sure you ticked your Page and the three permissions when making the token.');
  const pageId = String(d.pageId || '');
  const page = pageId ? pages.find(p => p.id === pageId) : (pages.length === 1 ? pages[0] : null);
  if (!page) return { choose: pages.map(p => ({ id: p.id, name: p.name })) };
  if (Array.isArray(page.tasks) && !page.tasks.includes('CREATE_CONTENT'))
    throw new HttpsError('permission-denied', 'Your account cannot post on ' + page.name + '. You need full control of the Page.');
  await db.collection('fbsecret').doc('page').set({ pageId: page.id, pageName: page.name, token: page.access_token, linkedAt: admin.firestore.FieldValue.serverTimestamp(), linkedBy: me.name });
  await db.collection('settings').doc('facebook').set({ connected: true, pageId: page.id, pageName: page.name, linkedAt: admin.firestore.FieldValue.serverTimestamp(), linkedBy: me.name });
  return { linked: true, pageName: page.name };
});

// Coordinators and admins post a poster (and optionally the dog's photo) with its text.
exports.facebookPost = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async request => {
  const me = await caller(request, FB_ROLES);
  const db = admin.firestore(), d = request.data || {};
  const message = String(d.message || '').trim();
  const images = Array.isArray(d.images) ? d.images : [];
  if (!message) throw new HttpsError('invalid-argument', 'Write the post text first.');
  if (message.length > 5000) throw new HttpsError('invalid-argument', 'The post text is too long.');
  if (images.length < 1 || images.length > 2 || !images.every(b => typeof b === 'string' && /^[A-Za-z0-9+/=]+$/.test(b) && b.length < 6e6))
    throw new HttpsError('invalid-argument', 'The pictures could not be read.');
  const dogId = d.dogId ? String(d.dogId) : '';
  if (dogId && !/^[A-Za-z0-9_-]{1,64}$/.test(dogId)) throw new HttpsError('invalid-argument', 'Which dog?');
  const dogRef = dogId ? db.collection('dogs').doc(dogId) : null;
  if (dogRef && !(await dogRef.get()).exists) throw new HttpsError('not-found', 'That dog is not listed.');
  const secret = await db.collection('fbsecret').doc('page').get();
  if (!secret.exists || !secret.data().token) throw new HttpsError('failed-precondition', 'Facebook is not linked yet. Ask the developer to link it.');
  const { pageId, token } = secret.data();

  const photo = async (b64, published, caption) => {
    const form = new FormData();
    form.append('source', new Blob([Buffer.from(b64, 'base64')], { type: 'image/jpeg' }), 'poster.jpg');
    form.append('published', published ? 'true' : 'false');
    if (caption) form.append('caption', caption);
    form.append('access_token', token);
    return graph('POST', pageId + '/photos', form);
  };
  let postId;
  try {
    if (images.length === 1) {
      const r = await photo(images[0], true, message);
      postId = r.post_id || r.id;
    } else {
      const ids = [];
      for (const b of images) ids.push((await photo(b, false)).id);
      const form = new URLSearchParams({ message, access_token: token });
      ids.forEach((id, i) => form.append('attached_media[' + i + ']', JSON.stringify({ media_fbid: id })));
      postId = (await graph('POST', pageId + '/feed', form)).id;
    }
  } catch (err) { throw fbProblem(err); }

  const parts = String(postId || '').split('_');
  const link = parts.length === 2 ? 'https://www.facebook.com/' + parts[0] + '/posts/' + parts[1] : 'https://www.facebook.com/' + postId;
  const what = String(d.label || 'poster').slice(0, 60);
  if (dogRef) {
    await dogRef.update({ fbPostId: postId, fbLink: link, fbMessage: message, fbPostedAt: admin.firestore.FieldValue.serverTimestamp(), fbPostedBy: me.name,
      fbUpdateStatus: '', fbUpdatedAt: null, fbUpdatedBy: '' });
    await dogRef.collection('updates').add({ kind: 'facebook', text: 'Posted to the Facebook Page (' + what + ').', byName: me.name, byUid: me.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  return { postId, link };
});

// When a dog's case moves on (Found, Reunited, Home safe and so on), put the news at the top of the
// original Facebook post. The original text stays underneath; a later update replaces the earlier one.
const FB_SPLIT = '\n\n\u2B07\uFE0F Original post \u2B07\uFE0F\n\n';
const UPDATE_LABEL = { found: 'Found', reunited: 'Reunited', 'home-safe': 'Home safe', 'no-further-sightings': 'No further sightings', 'paws-down': 'Paws down' };
exports.facebookUpdate = onCall({ timeoutSeconds: 60 }, async request => {
  const me = await caller(request, FB_ROLES);
  const db = admin.firestore(), d = request.data || {};
  const dogId = String(d.dogId || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(dogId)) throw new HttpsError('invalid-argument', 'Which dog?');
  const text = String(d.text || '').trim();
  if (!text) throw new HttpsError('invalid-argument', 'Write the update first.');
  if (text.length > 3000) throw new HttpsError('invalid-argument', 'The update is too long.');
  const dogRef = db.collection('dogs').doc(dogId), dogSnap = await dogRef.get();
  if (!dogSnap.exists) throw new HttpsError('not-found', 'That dog is not listed.');
  const dog = dogSnap.data();
  if (!dog.fbPostId) throw new HttpsError('failed-precondition', 'This dog has not been posted to Facebook from the app.');
  const secret = await db.collection('fbsecret').doc('page').get();
  if (!secret.exists || !secret.data().token) throw new HttpsError('failed-precondition', 'Facebook is not linked yet. Ask the developer to link it.');
  const token = secret.data().token;
  let current = '';
  try { current = String((await graph('GET', dog.fbPostId, { fields: 'message', access_token: token })).message || ''); }
  catch (err) {
    const e = err.fb || {};
    if (e.code === 100 && /does not exist|cannot be loaded|Unsupported get request/i.test(e.message || ''))
      throw new HttpsError('not-found', 'The original Facebook post could not be found. It may have been deleted on Facebook.');
    if (!dog.fbMessage) throw fbProblem(err);
  }
  if (!current) current = String(dog.fbMessage || '');
  const original = current.includes(FB_SPLIT) ? current.slice(current.indexOf(FB_SPLIT) + FB_SPLIT.length) : current;
  const message = original ? text + FB_SPLIT + original : text;
  try { await graph('POST', dog.fbPostId, new URLSearchParams({ message, access_token: token })); }
  catch (err) {
    const e = err.fb || {};
    if (e.code === 100) throw new HttpsError('failed-precondition', 'Facebook would not let this post be edited' + (e.message ? ': ' + String(e.message).slice(0, 160) : '.'));
    throw fbProblem(err);
  }
  const label = UPDATE_LABEL[dog.status] || String(dog.status || 'update');
  await dogRef.update({ fbUpdateStatus: dog.status || '', fbUpdatedAt: admin.firestore.FieldValue.serverTimestamp(), fbUpdatedBy: me.name });
  await dogRef.collection('updates').add({ kind: 'facebook', text: 'Facebook post updated (' + label + ').', byName: me.name, byUid: me.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  return { updated: true, link: dog.fbLink || '' };
});

// ============================================================
//  Public reporting website (report.html)
// ============================================================
// Members of the public can see the dogs we are looking for (photo, name, area and status only) and send
// a report: a lost dog, a loose dog, a found dog, or a sighting of a dog from our posts.
// Reports never go straight into the database from the website: they come through here, so every one is
// checked, robots and floods are turned away, and only then is it saved and the coordinators and admins told.
const crypto = require('crypto');
const PUBLIC_STATUS = { missing: 'Missing', loose: 'Loose dog', found: 'Found' };
const REPORT_TYPES = { lost: 'Lost dog', loose: 'Loose dog seen', found: 'Dog found', posts: 'Sighting' };
const REPORT_LIMITS = { perHour: 5, perDay: 12, allPerDay: 300 };
// Who is alerted to new reports. For now only the developer, while it is being tried out.
// To open it up later: ['coordinator', 'admin', 'developer'] (and canSeeReports in the app).
const REPORT_ROLES = ['developer'];
const RELATIONSHIPS = ['Family member', 'Partner', 'Friend', 'Neighbour', 'Dog walker or sitter', 'Other'];

// ---- The dogs shown on the public page ----
let publicCache = { at: 0, dogs: null };
// Dogs that are Home safe or Reunited stay on the list for 24 hours with that good news, then drop off.
// They cannot be picked for a sighting, so no more reports come in about them.
const SAFE_STATUS = { 'home-safe': 'Home safe', reunited: 'Reunited' };
const SAFE_SHOW_MS = 24 * 3600e3;
exports.publicDogs = onCall({ cors: true }, async () => {
  if (publicCache.dogs && Date.now() - publicCache.at < 60 * 1000) return { dogs: publicCache.dogs };
  const now = Date.now();
  const snap = await admin.firestore().collection('dogs').where('status', 'in', Object.keys(PUBLIC_STATUS).concat(Object.keys(SAFE_STATUS))).get();
  const dogs = snap.docs.map(d => {
    const x = d.data(), safe = !!SAFE_STATUS[x.status];
    if (safe && !(millis(x.statusAt) > now - SAFE_SHOW_MS)) return null;     // safe for more than a day (or no date): gone
    return {
      id: d.id,
      name: String(x.name || '').trim().slice(0, 60) || 'Unknown',
      area: String(x.lastSeenPlace || '').trim().slice(0, 80),
      status: x.status, statusLabel: safe ? SAFE_STATUS[x.status] : PUBLIC_STATUS[x.status], safe,
      thumb: typeof x.thumb === 'string' && x.thumb.startsWith('data:image/') && x.thumb.length < 120000 ? x.thumb : '',
      added: millis(x.createdAt)
    };
  }).filter(Boolean)
    .sort((a, b) => (a.safe - b.safe) || (b.added - a.added))        // dogs still being looked for come first
    .map(({ added, ...rest }) => rest);
  publicCache = { at: now, dogs };
  return { dogs };
});

// Tidy a piece of text typed by the public: no control characters, no runs of spaces, a sensible length.
function cleanText(v, max, multiline) {
  let s = String(v == null ? '' : v).replace(/\r\n?/g, '\n');
  s = multiline ? s.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}
function bad(msg) { return new HttpsError('invalid-argument', msg); }

// ---- A report from the public ----
exports.submitReport = onCall({ cors: true, timeoutSeconds: 30 }, async request => {
  const d = request.data || {}, db = admin.firestore(), now = Date.now();

  // Robots: the website has a hidden box people never see (robots fill it in), and a person takes
  // more than a few seconds to fill in the form. Either sign gets a polite "thank you" and nothing is kept.
  if (d.website || !(Number(d.tookMs) >= 4000)) return { ok: true };

  // Floods: a handful of reports an hour from one connection, and an overall daily ceiling.
  const ip = String((request.rawRequest && (request.rawRequest.ip || (request.rawRequest.headers || {})['x-forwarded-for'])) || 'unknown').split(',')[0].trim();
  const who = crypto.createHash('sha256').update('lda-report:' + ip).digest('hex').slice(0, 32);   // the address itself is never stored
  const limitRef = db.collection('limits').doc(who);
  const limitSnap = await limitRef.get();
  const times = ((limitSnap.exists && limitSnap.data().times) || []).filter(t => t > now - 24 * 3600e3);
  if (times.filter(t => t > now - 3600e3).length >= REPORT_LIMITS.perHour || times.length >= REPORT_LIMITS.perDay)
    throw new HttpsError('resource-exhausted', 'You have sent several reports already. Please phone us on 07715 950588 instead.');
  const dayRef = db.collection('limits').doc('all-' + new Date(now).toISOString().slice(0, 10));
  const daySnap = await dayRef.get();
  const dayCount = daySnap.exists ? Number(daySnap.data().n || 0) : 0;
  if (dayCount >= REPORT_LIMITS.allPerDay) throw new HttpsError('resource-exhausted', 'We are very busy. Please phone us on 07715 950588 instead.');

  // Check every box.
  const type = String(d.type || '');
  if (!REPORT_TYPES[type]) throw bad('Please choose what you are reporting.');
  if (d.consent !== true) throw bad('Please tick the box so a coordinator can contact you.');
  const town = cleanText(d.town, 60);
  if (town.length < 2) throw bad('Please add the Town/Village.');
  const details = cleanText(d.details, 1000, true);
  if (type !== 'posts' && details.length < 5) throw bad('Please add a short description.');
  const name = cleanText(d.name, 60);
  if (!name) throw bad('Please add your name.');
  const phone = String(d.phone || '').replace(/[\s()\-.]/g, '').replace(/^\+44/, '0').replace(/^0044/, '0');
  if (!/^0\d{9,10}$/.test(phone)) throw bad('Please add a UK phone number.');
  const seenDate = String(d.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(seenDate)) throw bad('Please add the date.');
  const dayMs = Date.parse(seenDate + 'T12:00:00Z');
  if (isNaN(dayMs) || dayMs > now + 36 * 3600e3) throw bad("The date can't be in the future.");
  if (dayMs < now - 366 * 24 * 3600e3) throw bad('Please check the date.');
  const seenTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(d.time || '')) ? String(d.time) : '';
  let lat = null, lng = null;
  if (d.lat != null || d.lng != null) {
    lat = Number(d.lat); lng = Number(d.lng);
    if (!(lat > 54 && lat < 57 && lng > -7 && lng < -2.5)) throw bad('The map pin is outside our area. Please check it.');
    lat = Math.round(lat * 1e5) / 1e5; lng = Math.round(lng * 1e5) / 1e5;
  }
  const isJpeg = (v, max) => typeof v === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= max;
  const photo = d.photo ? String(d.photo) : '', thumb = d.thumb ? String(d.thumb) : '';
  if (type === 'posts' && (photo || thumb)) throw bad('Photos are not needed for a sighting.');
  if (photo && !isJpeg(photo, 600000)) throw bad('That photo could not be used. Please try a different one.');
  if (thumb && !isJpeg(thumb, 80000)) throw bad('That photo could not be used. Please try a different one.');
  let dogId = '', dogName = '', behalf = null;
  if (type === 'posts') {
    dogId = String(d.dogId || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(dogId)) throw bad('Please tap the dog you saw.');
    const dog = await db.collection('dogs').doc(dogId).get();
    if (dog.exists && SAFE_STATUS[dog.data().status]) throw bad('Good news: that dog is now ' + SAFE_STATUS[dog.data().status].toLowerCase() + ', so no more sightings are needed. Thank you!');
    if (!dog.exists || !PUBLIC_STATUS[dog.data().status]) throw bad('That dog is no longer listed. Please choose "I’ve seen a loose dog" instead.');
    dogName = String(dog.data().name || '').slice(0, 60);
  } else if (type === 'lost') {
    // A lost dog is reported by its owner, or by someone reporting for the owner (who gives the owner's name and number).
    // Either way nothing is acted on until the owner has agreed: for someone reporting for the owner, a coordinator
    // must phone the owner and confirm it in the app before the dog can be created.
    if (d.owner === true) behalf = null;
    else if (d.behalf === true) {
      const relationship = String(d.relationship || ''), ownerName = cleanText(d.ownerName, 60);
      const ownerPhone = String(d.ownerPhone || '').replace(/[\s()\-.]/g, '').replace(/^\+44/, '0').replace(/^0044/, '0');
      if (!RELATIONSHIPS.includes(relationship)) throw bad('Please choose your relationship to the owner.');
      if (!ownerName) throw bad("Please add the owner's name.");
      if (!/^0\d{9,10}$/.test(ownerPhone)) throw bad("Please add the owner's UK phone number.");
      if (ownerPhone === phone) throw bad("Please give the owner's own number, not yours.");
      if (d.ownerKnows !== true) throw bad('Please tick to confirm the owner knows you are reporting this.');
      behalf = { relationship, ownerName, ownerPhone };
    } else throw bad('We can only take a lost dog report from the owner. Please ask the owner to phone us on 07715 950588.');
    dogName = cleanText(d.dogName, 60);
    if (!dogName) throw bad("Please add your dog's name.");
  }

  // Save it. The full photo is kept separately so the list of reports stays quick to open.
  const ref = await db.collection('reports').add({
    type, status: 'new', dogId, dogName, town, lat, lng, seenDate, seenTime, details,
    reporterName: name, reporterPhone: phone, thumb: thumb || '', hasPhoto: !!photo,
    ownerConfirmed: type === 'lost' && !behalf,
    ...(behalf ? { reportedFor: 'owner', relationship: behalf.relationship, ownerName: behalf.ownerName, ownerPhone: behalf.ownerPhone, ownerConsent: false } : {}),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  if (photo) await ref.collection('images').doc('main').set({ data: photo });
  await limitRef.set({ times: times.concat(now), updatedAt: now });
  await dayRef.set({ n: dayCount + 1, updatedAt: now });

  // Tell whoever handles reports.
  const title = 'New public report: ' + (type === 'posts' ? 'sighting' : REPORT_TYPES[type].toLowerCase()) + (behalf ? ' (for the owner)' : '');
  const body = type === 'posts' ? (dogName && !/^unknown$/i.test(dogName) ? dogName + ' seen in ' : 'Listed dog seen in ') + town
    : type === 'lost' ? dogName + ' lost in ' + town : type === 'found' ? 'Found in ' + town : 'Seen in ' + town;
  try { await sendTo(await peopleWithRole(REPORT_ROLES), title, body, SITE + '#report/' + ref.id, 'report'); }
  catch (e) { console.warn('Report alert not sent:', e && e.message); }
  return { ok: true };
});

// ---- Reports tidy themselves away ----
// Run each night with the closed-dog tidy: a report that has been dealt with is deleted 30 days later;
// one nobody dealt with is deleted after 60 days. The flood counters are cleared after two days.
async function tidyReports() {
  const db = admin.firestore(), now = Date.now();
  let removed = 0;
  for (const r of (await db.collection('reports').get()).docs) {
    const x = r.data();
    const dealt = x.status && x.status !== 'new';
    const from = dealt ? (millis(x.dealtAt) || millis(x.createdAt)) : millis(x.createdAt);
    if (from && from < now - (dealt ? 30 : 60) * 24 * 3600e3) { await db.recursiveDelete(r.ref); removed++; }
  }
  for (const l of (await db.collection('limits').get()).docs)
    if (!(Number(l.data().updatedAt) > now - 2 * 24 * 3600e3)) await l.ref.delete();
  console.log('Reports removed:', removed);
}
if (process.env.LDA_TEST) exports.tidyReports = tidyReports;   // for the tests only
