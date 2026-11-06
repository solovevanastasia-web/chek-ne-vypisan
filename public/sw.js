// Training always requires the live API. Never cache dialogue or evaluation responses.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
