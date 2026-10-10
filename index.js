// Lost Dogs Ayrshire: the notification sender.
// The app calls this when an admin adds a dog, asks for availability, or when someone asks to join.
// It checks who is asking, works out who should be told, and sends the notification to their phones.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 2, memory: '256MiB', timeoutSeconds: 30 });

// Where the app lives. Tapping a notification opens this address.
const SITE = 'https://lostdogsayrshiredrones-netizen.github.io/Lost-Dogs-Ayrshire/';

const STATUS = { missing: 'Missing', loose: 'Loose dog', found: 'Found' };

// Send one notification to every phone belonging to the given people.
async function sendTo(uids, title, body, link) {
  const wanted = new Set(uids);
  if (!wanted.size) return { sent: 0, failed: 0 };
  const db = admin.firestore();
  const phones = (await db.collection('devices').get()).docs.filter(d => wanted.has(d.data().uid) && d.data().token);
  if (!phones.length) return { sent: 0, failed: 0 };

  const result = await admin.messaging().sendEachForMulticast({
    tokens: phones.map(d => d.data().token),
    notification: { title, body },
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
    return sendTo(await peopleWithRole(['admin']), 'Join request', name + ' has asked to join.', SITE + '#members');
  }

  // Everything else is for admins only.
  if (role !== 'admin') throw new HttpsError('permission-denied', 'Admins only.');
  const dogId = String((request.data && request.data.dogId) || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(dogId)) throw new HttpsError('invalid-argument', 'Which dog?');
  const dogSnap = await db.collection('dogs').doc(dogId).get();
  if (!dogSnap.exists) throw new HttpsError('not-found', 'That dog is not listed.');
  const dog = dogSnap.data();
  const where = String(dog.name || 'Unnamed dog').slice(0, 60) + (dog.lastSeenPlace ? ', ' + String(dog.lastSeenPlace).slice(0, 80) : '');
  const everyoneElse = (await peopleWithRole(['member', 'admin'])).filter(id => id !== uid);
  const link = SITE + '#dog/' + dogId;

  if (type === 'dog') {
    const label = STATUS[dog.status] || 'Missing';
    return sendTo(everyoneElse, 'New dog: ' + label, where + (dog.askAvailability ? '. Can you help? Please give your availability.' : ''), link);
  }
  if (type === 'availability') {
    return sendTo(everyoneElse, 'Availability needed', where + '. Can you help with this search?', link);
  }
  throw new HttpsError('invalid-argument', 'Unknown request.');
});
