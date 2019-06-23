importScripts('https://unpkg.com/socket.io-client@2.2.0/dist/socket.io.slim.dev.js');
importScripts('https://unpkg.com/idb@4.0.3/build/iife/index-min.js');


// events from connected client tabs
self.handlers = {};
self.on = function(ev, handler) {
  self.handlers[ev] = self.handlers[ev] || [];
  self.handlers[ev].push(handler);
}
self.once = function(ev, handler) {
  let skip = false;
  self.handlers[ev] = self.handlers[ev] || [];
  self.handlers[ev].push((...args) => {
    if (!skip) {
      skip = true;
      handler(...args);
    }
  });
}
self.addEventListener('message', function(event) {
  if (self.handlers.message) {
    self.handlers.message.forEach(h => h(event));
  }
  if (event.data.kind && self.handlers[event.data.kind]) {
    self.handlers[event.data.kind].forEach(h => h(event.data.value, event));
  }
  if (typeof event.data === 'string' && event.data in self.handlers) {
    self.handlers[event.data].forEach(h => h(event));
  }
});

// indexedDB configuration
const DB_VERSION = 3;
async function upgrade(db, oldVersion, newVersion, tx) {
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
  if (oldVersion < 3) {
    let m = tx.objectStore('messages');
    m.deleteIndex('uniq');
    m.createIndex('by_client', ['client', 'client_index'], {unique: true});
    m.createIndex('by_server', 'server_index', {unique:true});
  }
}


// we want to avoid opening websockets and such for not-yet-active
// service workers. buuuut you can't actually tell from inside the
// service worker whether you're active or not. you can listen to
// the 'activate' event, but that only fires once, *ever*, per sw.
// the sw can be shut down due to no open tabs, then run again later,
// and have no way to tell that it's already been activated.
// so, we just ping from every active tab when they first start up,
// and that will trigger socket initialization in the sw if necessary.
self.dbp = new Promise(function(resolve) {
  self.once('init', function() {
    console.log('init db!!');
    let db = idb.openDB('messages', DB_VERSION, {upgrade});
    self.db = db;
    resolve(db);
  });
});
self.pock = new Promise(function(resolve) {
  self.once('init', function() {
    console.log('init socket!!');
    let socket = io('http://localhost:3001', {transports:['websocket']});
    self.socket = socket;
    resolve(socket);
  });
});
self.pid = self.dbp.then((db) => db.get('meta', 'client_id'));


self.dbp.catch((e) => console.log("error opening db in service worker!", e));
self.pock.catch((e) => console.log("error opening socket.io connection in service worker!", e));


// data sync logic

// sync our own data down to the server.
// we keep track of the most recently acknowledged message
// in our 'meta' object store, as 'next_client_id_to_sync'.
// keeping track of the next one instead of currently acknowledged
// means we can just initialize it to 0, instead of adding the edge
// case of null or -1.
self.syncOwn = async function() {
  let db = await self.dbp;
  let socket = await self.pock;
  let client_id = await self.pid;

  let next = await db.get('meta', 'next_client_id_to_sync');
  // get all of our messages with client_index >= next
  let range = IDBKeyRange.bound([client_id, next], [client_id, Infinity], false, true);
  let to_sync = await db.getAll('messages', range);
  // nothing new to send
  if (to_sync.length === 0) { return; }

  // the "new next" if this write goes through
  let after = next + to_sync.length;

  socket.emit('tell', to_sync, async function() {
    // when this write is acknowledged, we update meta, but check
    // (within a transaction) whether a concurrent write might have beaten
    // us to it. this prevents us from 'un-acknowledging' something.
    console.log('ack', after);
    let meta = db.transaction('meta', 'readwrite').objectStore('meta');
    let current = await meta.get('next_client_id_to_sync');
    if (after > current) {
      meta.put(next+to_sync.length, 'next_client_id_to_sync');
    }
  });
};

// all the hard stuff is in the 'tell' listener
self.syncRemote = async function() {
  let db = await self.dbp;
  let socket = await self.pock;
  let next = await db.get('meta', 'next_server_id');
  socket.emit('ask', next);
};

self.syncAll = () => Promise.all([self.syncRemote(), self.syncOwn()]);

// ok, we add all the messages we hear from the server to our database.
// we use put, so adding the same data a second time has no effect.
// we also update 'next_server_id' so we know what to ask for next time
// we query for updates.
// finally, we broadcast the data to all connected tabs. at the moment
// they'll have to de-duplicate for themselves. maybe we should handle
// that here.
self.handleTell = async function(data) {
  let db = await self.dbp;

  let tx = db.transaction(['meta','messages'], 'readwrite');
  let meta = tx.objectStore('meta');
  let messages = tx.objectStore('messages');

  data.forEach(m => messages.put(m));

  let prev = await meta.get('next_server_id');
  let latest = data.reduce((a,d)=>Math.max(a,d.server_index), prev-1);
  meta.put(latest+1, 'next_server_id');

  let clients = await self.clients.matchAll({type:'window'});
  clients.forEach(c=>c.postMessage({kind:'update', value:data}));
};


self.pock.then((socket) => {
  socket.on('connect', self.syncAll);
  socket.on('reconnect', self.syncAll);
  socket.on('tell', self.handleTell);

  // don't spam reconnection attempts if we don't have network
  self.on('offline', () => socket.io.reconnection(false));
  // try to reconnect immediately when we know we got network back
  self.on('online', () => {
    if (socket.io.readyState === 'closed') {
      socket.io.connect();
    }
    socket.io.reconnection(true);
  });

  ['connect', 'reconnect', 'reconnect_attempt', 'reconnecting', 'reconnect_error', 'reconnect_failed'].forEach(e => {
    socket.io.on(e, arg => console.log(e, arg));
  });
});

self.on('update', async function(messages, event) {
  // broadcast to other tabs
  let clients = await self.clients.matchAll({type:'window'});
  for (let c of clients) {
    if (c.id !== event.source.id) {
      c.postMessage({kind:'update'});
    }
  }
  
  // send update to server
  self.syncOwn();
});

self.auth = async function(name) {
  let db = await self.dbp;
  db.transaction('meta','readwrite').objectStore('meta').put(name, 'client_id');
  await fetch('http://localhost:3001/auth',{method: 'POST', mode:'no-cors',credentials:'include', body:name});
  let socket = await self.pock;
  socket.disconnect();
  socket.connect();
}

self.on('auth', self.auth);

