import Service from '@ember/service';
import {computed} from '@ember/object';
import {openDB, unwrap} from 'idb';
import {timeout} from 'ember-concurrency';

let local_index = 0;

export default Service.extend({
  _items: null, // item Map
  _locals: null, // local items (don't have client_index)
  async init() {
    navigator.serviceWorker.addEventListener('message', (event) => {
      console.log('update?', event);
      if (event.data.kind === 'update') {
        this._update(event.data.value);
      }
    });

    this._items = new Map();
    this._locals = [];

    // await timeout(4000);
    let db = await openDB('messages', 2);
    let messages = await db.getAll('messages');

    for (let m of messages) {
      this._items.set(m.client+':'+m.client_index, m);
    }
    this.notifyPropertyChange('_items');
  },

  messages: computed('_items', '_locals', function() {
    return Array.from(this._items, ([k,v]) => v.value).concat(this._locals).sort();
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
    this.set('_locals', this._locals.concat(messages));
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
