# Firebase Cloud Sync setup for Personal Diary

This change keeps the current Vercel site and the existing diary interface. When configured, Firebase Authentication identifies the user and Cloud Firestore stores the five existing collections (plans, tasks, runs, completion events, and journal entries) in one private document per account.

## 1. Add a Firebase Web App

1. Open https://console.firebase.google.com/ and select the existing diary project.
2. Project settings (gear icon) > General > Your apps > Add app > Web (</>), if there is not already a Web app.
3. Copy the Web app configuration fields into `firebase-config.js`. Replace every `REPLACE_...` placeholder. The web config's API key is a client identifier, not a server/admin secret. Never paste a service-account private key into this file.
4. In Authentication > Sign-in method, enable **Email/Password**.
5. In Firestore Database, create a database if one does not exist.

## 2. Apply Firestore security rules

In Firestore Database > Rules, paste the contents of `firestore.rules` and click Publish. Do not use public/test rules such as `allow read, write: if true`. The supplied rules restrict each user's document to that user's Firebase Auth UID.

If Firebase CLI is installed and authenticated, `firebase.json` points the CLI at the supplied rules file, so `firebase deploy --only firestore:rules` can publish it.

## 3. Deploy on Vercel

Commit/push `index.html`, `firebase-config.js`, and `firestore.rules` to the GitHub branch connected to Vercel. The existing production Vercel URL does not need to change. Firebase browser SDKs are imported from Google's official CDN.

In Firebase Console > Authentication > Settings > Authorized domains, ensure the production Vercel hostname is allowed (for example, `diary-rho-ashy.vercel.app`). Add the actual production hostname used by your project, not the full URL or path.

## 4. First sign-in and moving existing browser records

1. Open the deployed site and choose **새 계정 만들기**, or sign in to an existing Firebase account.
2. If Firestore has no diary document and this browser contains old local records, the app asks before uploading them. Confirm to migrate the current browser's data to the signed-in account. Cancel leaves the records intact and stops opening the cloud diary.
3. On a different computer, open the same Vercel URL and sign in with the same email/password. The app loads the same cloud records and listens for changes.

## What is stored

The Firestore path is `users/{Firebase Auth UID}/diary/current`. The document stores the existing five arrays together. The existing JSON/CSV/TXT export features remain available. A user-specific localStorage cache is kept for resilience, but Firestore is the shared source after sign-in.

## Important limits

- Do not publish test rules that allow everyone to read/write. Security Rules must be published before using real diary data.
- This is a personal diary sync implementation. If the same record is edited on multiple devices simultaneously, the last full-document write may win; avoid editing the same item at the exact same time. Separate new records are usually merged from the current browser cache when it reconnects.
- The app checks document size before uploading and preserves the browser copy if cloud upload fails. A large diary may eventually need to be split into per-record documents.
- The first migration only imports localStorage from the current browser. Any records stored on other browsers must be exported from those browsers and imported separately; do not assume localStorage from other machines appears automatically.
