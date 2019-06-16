importScripts('https://unpkg.com/socket.io-client@2.2.0/dist/socket.io.slim.dev.js');
importScripts('https://unpkg.com/idb@4.0.3/build/iife/index-min.js');


self.handlers = {};
self.on = function(ev, handler) {
  self.handlers[ev] = self.handlers[ev] || [];
  self.handlers[ev].push(handler);
}
self.addEventListener('message', function(event) {
  if (self.handlers.message) {
    self.handlers.message.forEach(h => h(event));
  }
  if (event.data.kind && self.handlers[event.data.kind]) {
    self.handlers[event.data.kind].forEach(h => h(event.data.value));
  }
});


let socket = io('http://localhost:3001', {
  transports: ['websocket'],
});

socket.on('hey', async function() {
  let cs = await self.clients.matchAll({
    type: 'window'
  });

  cs.forEach(c => c.postMessage('hey from server'));
});

socket.on('connect', function() {
  socket.emit('auth', 'quirrel');
});

self.proxy = function(eventName) {
  self.on(eventName, (d) => socket.emit(eventName, d));
};
['ask', 'tell', 'auth'].forEach(self.proxy);
socket.on('tell', async function(data) {
  let tx = self.db.transaction(['meta','messages'], 'readwrite');
  let meta = tx.objectStore('meta');
  let messages = tx.objectStore('messages');

  data.forEach(m => messages.put(m));

  let prev = await meta.get('next_server_id');
  let latest = data.reduce((a,d)=>Math.max(a,d.server_index), prev-1);
  meta.put(latest+1, 'next_server_id');

  console.log('received server data');
});


self.on('message', function(e) {
  console.log('message from client', e.source.id);
});

let dbp = idb.openDB('messages', 1, {
  async upgrade(db, oldVersion, newVersion, tx) {
    if (oldVersion < 1) {
      let meta = db.createObjectStore('meta');
      meta.add(Math.random().toString(), 'client_id');
      meta.add(0, 'next_server_id');
      meta.add(0, 'next_client_id');
      meta.add(0, 'next_client_id_to_sync');

      let msg = db.createObjectStore('messages', {keyPath: ['client', 'client_index']});
    }
  }
});
dbp.then(async function(db) {
  self.db = db;
  self.id = "quirrel"; // await db.get('meta', 'client_id');
});

self.syncOwn = async function() {
  let db = await dbp;
  let next = await db.get('meta', 'next_client_id_to_sync');
  let to_sync = await db.getAll('messages', IDBKeyRange.bound([self.id, next], [self.id, Infinity], false, true));
  socket.emit('tell', to_sync, function() {
    debugger;
  });
};

self.on('init', async function(name) {
  let db = await dbp;
  return db.add('meta', name, 'name');
});

self.on('save', async function(messages) {
  if (!Array.isArray(messages)) {
    messages = [messages];
  }
  let db = await dbp;
  let tx = db.transaction(['meta', 'messages'], 'readwrite');
  let metastore = tx.objectStore('meta');
  let prev = await metastore.get('next_client_id');

  let store = tx.objectStore('messages');

  messages.forEach((msg, i) => store.add({client:self.id, client_index: prev+i, value: msg}));
  metastore.put(prev+messages.length, 'next_client_id');

  await tx.done;
  self.syncOwn();

});

