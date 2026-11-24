// Public Firebase web config (NOT secret). Fill from: Firebase console > Project settings > Your apps > Web app.
// Never put service-account keys or any admin credential here.
window.FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  appId: 'YOUR_APP_ID',
};
// Region of the Cloud Functions (default us-central1). Must match where the functions are deployed.
window.FUNCTIONS_REGION = 'us-central1';
