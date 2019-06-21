/*
import {addSuccessHandler} from 'ember-service-worker/service-worker-registration';

addSuccessHandler(function(reg) {
  debugger;
});
*/

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(function(reg) {
    let send = (evt) => navigator.serviceWorker.controller.postMessage({kind:evt});

    // we want to avoid opening websockets and such for not-yet-active
    // service workers. buuuut you can't actually tell from inside the
    // service worker whether you're active or not. you can listen to
    // the 'activate' event, but that only fires once, *ever*, per sw.
    // the sw can be shut down due to no open tabs, then run again later,
    // and have no way to tell that it's already been activated.
    // so, we just ping from every active tab when they first start up,
    // and that will trigger socket initialization in the sw if necessary.
    send('init');

    // these events aren't available within the service worker, but
    // they're useful for hinting about websocket reconnection attempts
    window.addEventListener('online', () => send('online'));
    window.addEventListener('offline', () => send('offline'));

    // firefox shuts down service workers after 30 seconds of idle.
    // but, we want it to keep the socket open in case of server events
    setInterval(() => send('keepawake'), 25000);
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => console.log('controller change'));
} else {
  console.error("serviceWorkers are kinda necessary for this app!");
}
