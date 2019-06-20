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

self.spam = async function(msg) {
  let clients = await self.clients.matchAll({type:'window'});
  clients.forEach(c => c.postMessage({kind:'update', value:[msg]}));
}


let socket = self.socket = io('http://localhost:3001', {
  transports: ['websocket'],
});

socket.on('hey', async function() {
  let cs = await self.clients.matchAll({
    type: 'window'
  });

  cs.forEach(c => c.postMessage('hey from server'));
});

socket.on('connect', async function() {
  let db = await dbp;
  let name = await db.get('meta', 'client_id');
  socket.emit('auth', name, self.syncRemote);
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
  let clients = await self.clients.matchAll({type:'window'});
  clients.forEach(c=>c.postMessage({kind:'update', value:data.map(d=>d.value)}));
});


self.on('message', function(e) {
  console.log('message from client', e.source.id);
});

let dbp = idb.openDB('messages', 2, {
  async upgrade(db, oldVersion, newVersion, tx) {
    if (oldVersion < 1) {
      let meta = db.createObjectStore('meta');
      meta.add('bob', 'client_id');
      meta.add(0, 'next_server_id');
      meta.add(0, 'next_client_id');
      meta.add(0, 'next_client_id_to_sync');

      let msg = db.createObjectStore('messages', {keyPath: ['client', 'client_index']});
    }
    if (oldVersion < 2) {
      tx.objectStore('messages').createIndex('uniq', ['client', 'client_index'], {unique: true});
    }
  }
});
dbp.then(async function(db) {
  self.db = db;
  self.id = await db.get('meta', 'client_id'); // localStorage.name;// "alice"; // await db.get('meta', 'client_id');
  console.log('id', self.id);
});

self.syncRemote = async function() {
  let db = await dbp;
  let next = await db.get('meta', 'next_server_id');
  socket.emit('ask', next);
};

self.syncOwn = async function() {
  let db = await dbp;
  let next = await db.get('meta', 'next_client_id_to_sync');
  let to_sync = await db.getAll('messages', IDBKeyRange.bound([self.id, next], [self.id, Infinity], false, true));
  if (to_sync.length === 0) { return; }
  let after = next + to_sync.length;
  socket.emit('tell', to_sync, async function() {
    console.log('ack', after);
    let meta = db.transaction('meta', 'readwrite').objectStore('meta');
    let current = await meta.get('next_client_id_to_sync');
    if (after > current) {
      meta.put(next+to_sync.length, 'next_client_id_to_sync');
    }
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
  // broadcast to other tabs
});


['reconnect', 'reconnect_attempt', 'reconnecting', 'reconnect_error', 'reconnect_failed'].forEach(e => {
  socket.io.on(e, arg => console.log(e, arg));
});
socket.io.on('reconnect', self.syncOwn);
socket.io.on('reconnect', self.syncRemote);

self.on('offline', function() {
  console.log('offline now');
  socket.io.reconnection(false);
});
self.on('online', function() {
  console.log('service worker is **ONLINE**');
  if (socket.io.readyState === 'closed') {
    socket.io.reconnection(true);
    socket.io.connect();
  }
});
