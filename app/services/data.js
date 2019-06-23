import Service from '@ember/service';
import {computed} from '@ember/object';
import {openDB, unwrap} from 'idb';
import {task, timeout} from 'ember-concurrency';

const DB_NAME = 'messages';
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

class DataStore {
  static async open() {
    return new this(await openDB(DB_NAME, DB_VERSION, {upgrade}));
  }

  constructor(db) {
    this.db = db;
  }

  read() {
    return new ReadTransaction(this.db.transaction(['messages','meta']));
  }
  write() {
    return new WriteTransaction(this.db.transaction(['messages','meta'],'readwrite'));
  }
}

class ReadTransaction {
  constructor(tx) {
    this.tx = tx;
    this.done = tx.done;
  }

  tables() {
    return {
      meta: this.tx.objectStore('meta'),
      messages: this.tx.objectStore('messages'),
    };
  }

  async meta() {
    let result = {};
    let cursor = await this.tx.objectStore('meta').openCursor();
    while (cursor) {
      result[cursor.key] = cursor.value;
      cursor = await cursor.continue();
    }
    result.clock = [result.next_client_id, result.next_server_id];
    return result;
  }

  async id() {
    return this.tx.objectStore('meta').get('client_id');
  }

  async all() {
    let [clock, all] = Promise.all([
        this.clock(),
        this.tx.objectStore('messages').getAll(),
    ]);

    return {
      clock,
      values: all.map(messages.map(m=>m.value)),
    };
  }

  async since([local_index,remote_index]) {
    let meta = await this.meta();
    let id = meta.client_id;

    let client_range = IDBKeyRange.bound([id,local_index], [id,Infinity]);
    let server_range = IDBKeyRange.lowerBound(remote_index);
    let messages = this.tx.objectStore('messages');
    let local = messages.index('by_client').getAll(client_range);
    let remote = messages.index('by_server').getAll(server_range);

    [local,remote] = await Promise.all([local,remote]);
    return {
      clock: meta.clock,
      values: local.concat(remote).map(d=>d.value),
    };
  }
}

class WriteTransaction extends ReadTransaction {
  async saveLocalValue(value) {
    return this.saveLocalValues([value]);
  }

  async saveLocalValues(values) {
    let meta = await this.meta();
    let index = meta.next_client_id;
    let items = values.map(v => {
      return {
        value: v,
        client: meta.client_id,
        client_index: index++,
      };
    });

    let messages = this.tx.objectStore('messages');
    for (let item of items) {
      messages.add(item);
    }
    this.tx.objectStore('meta').put(index, 'next_client_id');
    return this.tx.done;
  }
}

export default Service.extend({
  _storep: null,
  _items: [],
  _clock: [0,0],

  async init() {
    navigator.serviceWorker.addEventListener('message', (event) => {
      console.log('update?', event);
      if (event.data.kind === 'update') {
        this._update.perform();
      }
    });


    this._storep = DataStore.open();
    this._clock = [0,0];
    this._items = [];
    this._update.perform();
  },

  _update: task(function* () {
    let store = yield this._storep;
    let {values, clock} = yield store.read().since(this._clock);
    this.set('_clock', clock);
    this.set('_items', this._items.concat(values));
    console.log(this._items);
  }).keepLatest(),

  _save: task(function* (message) {
    let store = yield this._storep;
    yield store.write().saveLocalValue(message);
    this._update.perform();
  }).enqueue(),

  messages: computed('_items', function() {
    return this._items.sort((a,b) => a.time - b.time);
  }),

  async save(message) {
    this._save.perform(message);

    navigator.serviceWorker.controller.postMessage({
      kind: 'update'
    });
  },
});


window.resetDB = async function() {
  let db = await openDB('messages', 3);
  let tx = db.transaction(['meta', 'messages'], 'readwrite');
  tx.objectStore('messages').clear();

  let meta = tx.objectStore('meta');
  meta.put(0, 'next_server_id');
  meta.put(0, 'next_client_id');
  meta.put(0, 'next_client_id_to_sync');

  await tx.done;
  location.reload();
}
