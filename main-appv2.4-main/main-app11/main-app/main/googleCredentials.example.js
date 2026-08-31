// Template for main/googleCredentials.js, which is gitignored because it holds
// live Google "Desktop app" OAuth credentials.
//
// Copy this file to googleCredentials.js and paste your own client in. Without
// it the app still builds and runs; the license gate simply hides the Google
// button and key-paste becomes the only route in.
//
// Credentials come from the Google Cloud console -> Credentials ->
// OAuth client ID -> "Desktop app" (see website docs/DESKTOP_APP_AUTH.md).

module.exports = {
  GOOGLE_DESKTOP_CLIENT_ID: '',
  GOOGLE_DESKTOP_CLIENT_SECRET: ''
};
