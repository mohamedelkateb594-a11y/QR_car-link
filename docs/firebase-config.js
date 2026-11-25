// Public Firebase web config (NOT secret). Firebase console > Project settings > Your apps > Web app.
// Never put service-account keys or any admin credential here.
window.FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',                       // TODO: from Project settings > Your apps > Web app
  authDomain: 'qr-car-contact.firebaseapp.com', // derived from the project id; verify against the console
  databaseURL: 'https://qr-car-contact-default-rtdb.firebaseio.com',
  projectId: 'qr-car-contact',
  appId: 'YOUR_APP_ID',                         // TODO: from the same Web app screen
};
