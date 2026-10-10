// Lost Dogs Ayrshire: receives phone notifications while the app is closed.
// This file must sit next to index.html and keep this exact name.
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBvsSYYymjt0h9v9cynw2_oophP0BNG0I8",
  authDomain: "lost-dogs-ayrshire.firebaseapp.com",
  projectId: "lost-dogs-ayrshire",
  storageBucket: "lost-dogs-ayrshire.firebasestorage.app",
  messagingSenderId: "302116971454",
  appId: "1:302116971454:web:e336d94d271ee433410fef"
});

// Firebase shows each notification and opens the right page when it is tapped.
firebase.messaging();
