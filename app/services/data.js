import Service from '@ember/service';
import EmberObject, {computed} from '@ember/object';
import {openDB, unwrap} from 'idb';
import {task, timeout} from 'ember-concurrency';

const DB_NAME = 'messages';
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
const getDB = () => openDB(DB_NAME, DB_VERSION, {upgrade});


async function getFromCollection(db, collection, since) {
  let {local,remote} = since;
  let tx = db.transaction(['meta', 'clocks', 'messages']);
  let client_id = await tx.objectStore('meta').get('client_id');
  let messages = tx.objectStore('messages');

  let local_from = [collection, client_id, local];
  let local_to = [collection, client_id, Infinity];
  let locals = messages.index('primary').getAll(IDBKeyRange.bound(local_from, local_to, true, true)); // exclusive range

  let remote_from = [collection, remote];
  let remote_to = [collection, Infinity];
  let remotes = messages.index('remote').getAll(IDBKeyRange.bound(remote_from, remote_to, true, true));

  let clock = await tx.objectStore('clocks').get(collection);
  locals = await locals;
  remotes = await remotes;
  return {
    clock: {local: clock.last_local, remote: clock.synced_remote},
    values: locals.concat(remotes).map(d=>d.value),
  };
}

async function writeToCollection(db, collection, items) {
  let tx = db.transaction(['meta', 'clocks', 'messages'], 'readwrite');
  let client_id = await tx.objectStore('meta').get('client_id');
  let clock = await tx.objectStore('clocks').get(collection);
  let msg_store = tx.objectStore('messages');

  let messages = items.map(v => {
    return {
      collection,
      client: client_id,
      client_index: ++clock.last_local,
      value: v,
    };
  })
  .forEach(i => msg_store.add(i));

  tx.objectStore('clocks').put(clock);
  return tx.done;
}

const Collection = EmberObject.extend({
  id: '',
  db: null,

  clock: null,
  items: null,

  onUpdate: ()=>{},

  init() {
    this._super(...arguments);
    this.clock = {local:0,remote:0};
    this.set('items', []);

    navigator.serviceWorker.addEventListener('message', this.updateHandler);

    this._update.perform();
  },

  updateHandler: computed(function() {
    return (event) => {
      if (event.data && event.data.kind && event.data.kind === 'update') {
        this._update.perform();
      }
    };
  }),

  _update: task(function* () {
    let {values, clock} = yield getFromCollection(this.db, this.id, this.clock);
    this.set('clock', clock);
    this.set('items', this.items.concat(values));
    this.notifyPropertyChange('items');
    this.onUpdate();
  }).keepLatest(),

  save(messages) {
    if (!Array.isArray(messages)) { throw new Error('pass an array'); }
    this._save.perform(messages);
    navigator.serviceWorker.controller.postMessage({kind:'update'});
  },

  _save: task(function* (messages) {
    yield writeToCollection(this.db, this.id, messages);
    return this._update.perform();
  }).enqueue(),

  willDestroy() {
    this._super(...arguments);
    navigator.serviceWorker.removeEventListener('message', this.updateHandler);
  },
});

export default Service.extend({
  async init() {
    this._dbp = getDB();
  },

  async collection(id) {
    let db = await this._dbp;
    return Collection.create({db,id});
  },
});


window.resetDB = async function() {
  let db = await openDB('messages', DB_VERSION);
  let tx = db.transaction(['messages', 'clocks'], 'readwrite');
  tx.objectStore('messages').clear();
  await tx.objectStore('clocks').clear();
  tx.objectStore('clocks').add({
    collection: 'index',
    synced_remote: 0,
    synced_local: 0,
    last_local: 0,
  });

  await tx.done;
  location.reload();
}
