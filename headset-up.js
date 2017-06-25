'use strict';

function getDeepValue(obj, pathArray, defaultValue)
{
	if(pathArray.length == 0)
		return obj;
	else if(!(obj instanceof Object) || obj[pathArray[0]] === undefined)
		return defaultValue;
	else
		return getDeepValue(obj[pathArray[0]], pathArray.slice(1), defaultValue);
}

function parseCategories(cats)
{
	return cats.split(';').map(function(cat){
		return cat.trim().split('.');
	});
}

function formatTime(ms)
{
	if(ms <= 0)
		return '00:00';

	var seconds = Math.ceil(ms/1000);
	var minutes = Math.floor(seconds / 60);
	seconds = seconds % 60;
	if(minutes < 10) minutes = '0'+minutes;
	if(seconds < 10) seconds = '0'+seconds;

	return minutes + ':' + seconds;
}

AFRAME.registerComponent('json', {
	schema: {type: 'selector'},
	init: function(){
		this.el.json = {};
	},
	update: function(){
		try {
			this.el.json = JSON.parse(this.data.data);
		}
		catch(e){
			console.error('Unable to parse', this.data.data);
		}
	}
});

AFRAME.registerComponent('clone-on', {
	schema: {
		on: {type: 'string'},
		mixins: {type: 'array', default: []}
	},
	init: function(){
		var self = this;
		this.el.addEventListener(this.data.on, function()
		{
			if(!self.clone){
				self.clone = document.createElement('a-entity');
				self.clone.setAttribute('class', self.el.className);
				self.clone.classList.add('clone');
				self.clone.setAttribute('mixin', self.data.mixins.join(' '));
				self.el.parentNode.appendChild(self.clone);
			}
			else {
				self.clone.parentElement.remove(self.clone);
				self.clone = null;
			}
		});
	}
});

AFRAME.registerComponent('timer', {
	multiple: true,
	dependencies: ['sync'],
	schema: {
		duration: {type: 'number', default: 30},
		on: {type: 'string', default: null},
		emit: {type: 'string', default: 'timerend'},
		label: {type: 'selector', default: null},
		autostart: {type: 'boolean', default: false}
	},
	init: function()
	{
		this.endTime = 0;
		this.lastUpdate = 0;

		if(this.data.on){
			this.el.addEventListener(this.data.on, this.start.bind(this));
		}

		this.sync = this.el.components.sync;
		if(this.sync.isConnected){
			this.syncStart();
		}
		else {
			this.el.addEventListener('connected', this.syncStart.bind(this));
		}
	},
	start: function(){
		if(this.sync.isMine && this.startTimeRef){
			this.startTimeRef.set(Firebase.ServerValue.TIMESTAMP);
		}
	},
	stop: function(){
		if(this.sync.isMine && this.startTimeRef){
			this.startTimeRef.set(0);
		}
	},
	running: function(){
		return this.endTime !== 0;
	},
	syncStart: function()
	{
		this.startTimeRef = this.sync.dataRef.child(this.name);
		this.startTimeRef.on('value', (function(snapshot)
		{
			var serverTime = snapshot.val();

			if(serverTime > 0){
				this.localTimeOffset = Date.now() - serverTime;
				this.endTime = serverTime + Math.floor(this.data.duration * 1000);
			}
			else {
				this.endTime = 0;
			}

		}).bind(this));

		if(this.data.autostart)
			this.start();
	},
	tick: function(time, deltaTime)
	{
		if(!this.endTime) return;

		var label = this.el.hasAttribute('n-text') ? this.el : this.data.label;
		var nowTime = performance.timing.navigationStart + performance.now() - this.localTimeOffset;

		if(label && nowTime - this.lastUpdate > 250){
			label.setAttribute('n-text', 'text', formatTime(this.endTime - nowTime));
			this.lastUpdate = nowTime;
		}

		if(this.endTime > 0 && nowTime > this.endTime){
			this.el.emit(this.data.emit);
			this.stop();
			if(label)
				label.setAttribute('n-text', 'text', '00:00');
		}
	}
});

AFRAME.registerComponent('display-phrase', {
	dependencies: ['json', 'n-text', 'sync'],
	schema: {type: 'array'},
	init: function()
	{
		this.sync = this.el.components.sync;
		if(this.sync.isConnected){
			this.start();
		}
		else {
			this.el.addEventListener('connected', this.start.bind(this));
		}

		this.el.addEventListener('timerend', (function(){
			this.el.setAttribute(this.name, []);
		}).bind(this));
	},
	update: function()
	{
		var phrase = getDeepValue(this.el.json, this.data, '');
		if(this.data.length > 0 && phrase){
			this.el.setAttribute('n-text', 'text', phrase);
		}
		else {
			this.el.setAttribute('n-text', 'text', 'Ready to play?');
		}

		if(this.sync.isMine)
		{
			if(this.dataRef){
				this.dataRef.set(this.data);
			}

			var target = document.querySelector('.mine[timer]');
			if(!target.components.timer.running())
				target.components.timer.start();
		}
	},
	start: function()
	{
		this.dataRef = this.sync.dataRef.child(this.name);
		this.dataRef.on('value', (function(snapshot){
			if(!this.sync.isMine || !this.data.length){
				this.el.setAttribute(this.name, snapshot.val());
			}
		}).bind(this));
	}
});

AFRAME.registerComponent('advance-phrase', {
	schema: {
		on: {type: 'string', default: 'click'}
	},
	init: function()
	{
		this.advanceQuestion = this._advanceQuestion.bind(this);
		this.el.addEventListener(this.data.on, this.advanceQuestion);
	},
	initCategories: function()
	{
		function sum(acc, val){
			return acc + val;
		}

		var userId = this.el.sceneEl.systems['sync-system'].userInfo.userId;
		this.target = document.querySelector('[display-phrase][data-creator-user-id="'+userId+'"]');
		var catString = this.el.sceneEl.dataset.categories;
		this.catPaths = parseCategories(catString);

		// pretend the categories are all in one long array
		// this array stores the first index of each category in that array
		this.catOffsets =
			this.catPaths
			.map(function(name){
				return getDeepValue(this.target.json, name, []).length;
			}, this)
			.map(function(length, i, array){
				return array.slice(0, i+1).reduce(sum, 0);
			});

		// the first item in the offsets list is always zero
		this.catOffsets.unshift(0);
	},
	remove: function(){
		this.el.removeEventListener(this.data.on, this.advanceQuestion);
	},
	_advanceQuestion: function()
	{
		if(!this.target || !this.catPaths || !this.catOffsets){
			this.initCategories();
		}

		var totalLength = this.catOffsets[this.catOffsets.length-1];
		var newQTotalIndex = Math.floor( Math.random() * totalLength );

		// find the category that the randomly chosen index falls in
		var catIndex = this.catOffsets.findIndex( function(el, i, array){
			return newQTotalIndex >= el && newQTotalIndex < array[i+1];
		});

		// create a copy of the category path
		var newQPath = this.catPaths[catIndex].slice();
		newQPath.push( newQTotalIndex - this.catOffsets[catIndex] );

		// update the question id with the new name
		this.target.setAttribute('display-phrase', newQPath);
	}
});
