/*
import {addSuccessHandler} from 'ember-service-worker/service-worker-registration';

addSuccessHandler(function(reg) {
  debugger;
});
*/

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(function(reg) {
    navigator.serviceWorker.addEventListener('message', function(e) {
      console.log('hey from worker:', e.data);
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', function() {
    console.log('controller change');
  });

  window.send = function(evt, val) {
    navigator.serviceWorker.controller.postMessage({kind: evt, value: val});
  }

  // firefox shuts down service worker after 30 seconds of idle,
  // let's ping it frequently to prevent that
  setInterval(function() {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({kind:'keepawake'});
    }
  }, 25000);
}

window.addEventListener('online', function() {
  console.log.bind(console, 'normal online');
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({kind: 'online'});
  }
});
window.addEventListener('offline', function() {
  console.log.bind(console, 'normal offline');
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({kind: 'offline'});
  }
});


