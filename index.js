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
      notification: { icon: SITE + 'icon-192.png', badge: SITE + 'icon-192.png' },
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
