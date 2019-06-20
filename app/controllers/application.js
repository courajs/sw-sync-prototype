import Controller from '@ember/controller';
import {computed} from '@ember/object';
import {inject} from '@ember/service';

export default Controller.extend({
  data: inject(),
  thing: '',
  async doThing(e) {
    e.preventDefault();
    this.data.save(this.thing);
    this.set('thing', '');
  }
});
