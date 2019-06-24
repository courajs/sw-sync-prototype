import Controller from '@ember/controller';
import {computed} from '@ember/object';
import {inject} from '@ember/service';

export default Controller.extend({
  data: inject(),
  thing: '',

  async init() {
    this._super(...arguments);
    this.collection = await this.data.collection('index');
    this.collection.onUpdate = () => this.notifyPropertyChange('collection');
  },

  items: computed('collection', 'collection.items', function() {
    if (!this.collection) { return []; }
    return this.collection.items.sort((a,b) => a.time - b.time);
  }),
  messages: computed('items', function() {
    return this.items.map(m => {
      let time = new Date(m.time).toLocaleTimeString();
      return time + ': ' + m.text;
    });
  }),

  async doThing(e) {
    e.preventDefault();
    this.collection.save([{
      text: this.thing,
      time: new Date().valueOf(),
    }]);
    this.set('thing', '');
  }
});
