import Service from '@ember/service';
import {computed} from '@ember/object';
import {openDB, unwrap} from 'idb';
import {timeout} from 'ember-concurrency';

const DB_VERSION = 2;
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
}

export default Service.extend({
  _items: null, // item Map
  _tab_local_items: null, // local items (don't have client_index)

  async init() {
    this._items = new Map();
    this._tab_local_items = [];

    navigator.serviceWorker.addEventListener('message', (event) => {
      console.log('update?', event);
      if (event.data.kind === 'update') {
        this._update(event.data.value);
      }
    });

    this._items = new Map();
    this._tab_local_items = [];

    // await timeout(4000);
    let db = await openDB('messages', DB_VERSION, {upgrade});
    let messages = await db.getAll('messages');

    for (let m of messages) {
      this._items.set(m.client+':'+m.client_index, m);
    }
    this.notifyPropertyChange('_items');
  },

  messages: computed('_items', '_tab_local_items', function() {
    return Array.from(this._items, ([k,v]) => v.value).concat(this._tab_local_items).sort(function(a, b) {
      return a.time - b.time;
    });
  }),

  save(messages) {
    if (!messages) { return; }
    if (!Array.isArray(messages)) {
      messages = [messages];
    } else if (!messages.length) { return; }

    navigator.serviceWorker.controller.postMessage({
      kind: 'save',
      value: messages,
    });
    this.set('_tab_local_items', this._tab_local_items.concat(messages));
  },

  _update(notified) {
    let dirty = false;
    for (let item of notified) {
      if (!this._items.has(item.client+':'+item.client_index)) {
        dirty = true;
        this._items.set(item.client+':'+item.client_index, item);
      }
    }
    if (dirty) {
      this.notifyPropertyChange('_items');
    }
  },
});


function allowDuplicate(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

window.pushThing = async function() {
  let db = await openDB('messages', 2);
  let tx = db.transaction(['messages'], 'readwrite');
  let messages = unwrap(tx.objectStore('messages'));
  let indices = [3, 8, 14];
  for (let index of indices) {
    messages.add({client:'phil', client_index: index}).onerror = allowDuplicate;
  }

  // try {
  await tx.done;
  // } catch (e) {
  //   debugger;
  //   console.log('awww', e);
  // }
  console.log('eyy :)');
}

window.resetDB = async function() {
  let db = await openDB('messages', 2);
  let tx = db.transaction(['meta', 'messages'], 'readwrite');
  tx.objectStore('messages').clear();

  let meta = tx.objectStore('meta');
  meta.put(0, 'next_server_id');
  meta.put(0, 'next_client_id');
  meta.put(0, 'next_client_id_to_sync');

  await tx.done;
  navigator.serviceWorker.controller.postMessage('reset');
}
