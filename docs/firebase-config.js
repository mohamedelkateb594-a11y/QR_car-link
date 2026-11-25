// Public Firebase web config (NOT secret). Firebase console > Project settings > Your apps > Web app.
// databaseURL is shown in Build > Realtime Database (top of the Data tab).
// Never put service-account keys or any admin credential here.
window.FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  databaseURL: 'https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com',
  projectId: 'YOUR_PROJECT_ID',
  appId: 'YOUR_APP_ID',
};
