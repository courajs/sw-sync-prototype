import Service from '@ember/service';
import {computed} from '@ember/object';
import {openDB, unwrap} from 'idb';

export default Service.extend({
  messages: [],
  async init() {
    navigator.serviceWorker.addEventListener('message', (event) => {
      console.log('update?', event);
      if (event.data.kind === 'update') {
        this.set('messages', this.messages.concat(event.data.value));
      }
    });

    let db = await openDB('messages', 2, {
      async upgrade(db, oldVersion, newVersion, tx) {
        if (oldVersion < 1) {
          let meta = db.createObjectStore('meta');
          meta.add(Math.random().toString(), 'client_id');
          meta.add(0, 'next_server_id');
          meta.add(0, 'next_client_id');
          meta.add(0, 'next_client_id_to_sync');

          let msg = db.createObjectStore('messages', {keyPath: ['client', 'client_index']});
        }
        if (oldVersion < 2) {
          tx.objectStore('messages').createIndex('uniq', ['client', 'client_index'], {unique: true});
        }
    }});
    let msgs = await db.getAll('messages');

    this.set('messages', msgs.map(m=>m.value));
  },

  save(messages) {
    navigator.serviceWorker.controller.postMessage({
      kind: 'save',
      value: messages,
    });
    this.set('messages', this.messages.concat(messages));
  }
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
}

setTimeout(window.pushThing, 1000);
