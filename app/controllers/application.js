import Controller from '@ember/controller';
import {computed} from '@ember/object';
import {inject} from '@ember/service';

export default Controller.extend({
  data: inject(),
  messages: computed('data.messages', function() {
    return this.data.messages.map(m => {
      let time = new Date(m.time).toLocaleTimeString();
      return time + ': ' + m.text;
    });
  }),
  thing: '',
  async doThing(e) {
    e.preventDefault();
    this.data.save({
      text: this.thing,
      time: new Date().valueOf(),
    });
    this.set('thing', '');
  }
});
