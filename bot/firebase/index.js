const path = require('node:path');
const fs = require('node:fs');
const { getApps, initializeApp, applicationDefault, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getStorage } = require('firebase-admin/storage');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const databaseURL = process.env.RTDB_URL || process.env.FIREBASE_DATABASE_URL;
if (!databaseURL) {
  throw new Error('RTDB_URL or FIREBASE_DATABASE_URL is required');
}

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (serviceAccountPath && !fs.existsSync(serviceAccountPath)) {
  throw new Error('GOOGLE_APPLICATION_CREDENTIALS does not exist');
}
const credential = serviceAccountPath
  ? cert(require(path.resolve(serviceAccountPath)))
  : applicationDefault();
const app = getApps()[0] || initializeApp({
  credential,
  databaseURL,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined
});

async function transactionLoaded(reference, updateValue, requireExisting = false) {
  let listener;
  try {
    const initial = await new Promise((resolve, reject) => {
      listener = (snapshot) => resolve(snapshot);
      reference.on('value', listener, reject);
    });
    if (requireExisting && !initial.exists()) return { committed: false, snapshot: initial };
    return await reference.transaction(updateValue, undefined, false);
  } finally {
    if (listener) reference.off('value', listener);
  }
}

function transactionExisting(reference, updateValue) {
  return transactionLoaded(reference, updateValue, true);
}

module.exports = { db: getDatabase(app), storage: getStorage(app), transactionLoaded, transactionExisting };
