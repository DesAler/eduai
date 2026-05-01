require('dotenv').config();
const admin = require('firebase-admin');
admin.initializeApp({
  credential: admin.credential.cert(require('./google-credentials.json')),
  projectId: 'eduai-assistant-9fb47'
});
const db = admin.firestore();
db.collection('users').doc('8Bq68xNL8hQOnvYQOvCunCP48oh2').get().then(snap => {
  console.log('exists:', snap.exists);
  console.log('data:', JSON.stringify(snap.data()));
  process.exit(0);
}).catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
