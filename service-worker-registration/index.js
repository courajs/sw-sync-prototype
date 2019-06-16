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
}
