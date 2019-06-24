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
const DB_VERSION = 10;
async function upgrade(db, oldVersion, newVersion, tx) {
  [].forEach.call(db.objectStoreNames, n => db.deleteObjectStore(n));

  let meta = db.createObjectStore('meta');

  let clocks = db.createObjectStore('clocks', {keyPath:'collection'});
  clocks.createIndex('uniq', 'collection', {unique: true});
  clocks.add({
    collection: 'index',
    synced_remote: 0,
    synced_local: 0,
    last_local: 0,
  });

  let m = db.createObjectStore('messages',
      {keyPath: ['collection', 'client', 'client_index']});
  m.createIndex('primary', ['collection', 'client', 'client_index'], {unique: true});
  m.createIndex('remote', ['collection', 'server_index'], {unique:true});
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
//

// sync our own data down to the server.
// we keep track of the most recently acknowledged message
// for each collection in our 'clocks' object store.
// so, check them all for last_local > synced_local.
self.syncOwn = async function() {
  let db = await self.dbp;
  let socket = await self.pock;
  let client_id = await self.pid;

  let tx = db.transaction(['clocks', 'messages']);
  let clocks = await tx.objectStore('clocks').getAll();
  let messages = tx.objectStore('messages');

  let if_acked = {};

  let reqs = clocks
    .filter(c=>c.last_local>c.synced_local) // collections with new data to sync
    .map(c => {
      if_acked[c.collection] = c.last_local;
      let from = [c.collection, client_id, c.synced_local];
      let to = [c.collection,client_id,c.last_local];
      return messages.getAll(IDBKeyRange.bound(from,to,true,false));
    }); // everyting after synced_local, for that collection

  let sets = await Promise.all(reqs);
  if (sets.length === 0) { return; }

  socket.emit('tell', [].concat(...sets), async function() {
    console.log('ack', if_acked);
    let tx = db.transaction(['clocks'], 'readwrite');
    let clocks = tx.objectStore('clocks');
    let current_clocks = await Promise.all(Object.keys(if_acked).map(collection => clocks.get(collection)));
    for (let c of current_clocks) {
      c.synced_local = Math.max(c.synced_local, if_acked[c.collection]);
      clocks.put(c);
    }
  });
};

// server replies with a 'tell' event, so most of the hard stuff
// is in there
self.syncRemote = async function() {
  let db = await self.dbp;
  let socket = await self.pock;
  let clocks = await db.getAll('clocks');
  let ask = {};
  clocks.forEach(c => ask[c.collection] = c.synced_remote);
  socket.emit('ask', ask);
};

self.syncAll = () => Promise.all([self.syncRemote(), self.syncOwn()]);

// ok, we add all the messages we hear from the server to our database.
// we use put, so adding the same data a second time has no effect.
// we also update clocks so we know what to ask for next time
// we query for updates.
// finally, we broadcast that there's an update to all connected tabs.
// they're responsible for reading from indexeddb themselves
self.handleTell = async function(data) {
  let db = await self.dbp;
  let client_id = await self.pid;

  let tx = db.transaction(['clocks','messages'], 'readwrite');
  let messages = tx.objectStore('messages');

  // save the messages, and keep track of the max server_index for each collection
  let latests = {};
  for (let d of data) {
    messages.put(d);
    if (d.collection in latests) {
      latests[d.collection] = Math.max(latests[d.collection], d.server_index);
    } else {
      latests[d.collection] = d.server_index;
    }
  }

  // update clocks for each collection
  let clocks = tx.objectStore('clocks');
  let current_clocks = await Promise.all(Object.keys(latests).map(collection => clocks.get(collection)));
  for (let c of current_clocks) {
    c.synced_remote = Math.max(c.synced_remote, latests[c.collection]);
    clocks.put(c);
  }

  // notify connected tabs
  let clients = await self.clients.matchAll({type:'window'});
  clients.forEach(c=>c.postMessage({kind:'update'}));
};


self.pock.then((socket) => {
  // includes reconnect, apparently
  socket.on('connect', self.syncAll);
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
    // socket.io.on(e, arg => console.log(e, arg));
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

