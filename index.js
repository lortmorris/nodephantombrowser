/* eslint-disable semi */

var phantom = require('phantom');
var utils = require('util');
var EventEmitter = require('events').EventEmitter;
var debug = require("debug");
var fs = require("fs");


var events = [
  'onResourceRequested',
  'onResourceReceived',
  'onInitialized',
  'onLoadStarted',
  'onLoadFinished',
  'onUrlChanged',
  'onNavigationRequested',
  'onRepaintRequested',
  'onClosing',
  'onConsoleMessage',
  'onAlert',
  'onConfirm',
  'onPrompt',
  'onPageCreated'
];

function BindedReciver (self, name) {
  function emit () {
    self.emit(name, arguments);
  }

  return emit.bind(self);
};


/**
 * Create a instance of Browser (phantomjs wrapper).
 * Important, the screenshot method can upload to S3 the images. In S3 the browser will create a folder instance name. All screenshot
 * of this instance will save into the instanceId folder.
 * @param string instanceID - the instanceId (identification). Isn't passed the library will create automatic
 * @constructor
 */
function Browser () {
  var self = this;

  self.isLoaded = false;
  self.tabs = [];

  self.debug("browser init...");

  self.screenshotFolder = process.cwd()+"/screenshots";
  
  phantom.create(function (ph) {
    self.debug('phantom craeted: ', self.instanceID);

    self.ph = ph;

    ph.createPage(function (page) {
      self.debug('page craeted');
      self.page = page;

      for (var i = 0; i < events.length; i++) {
        page.set(events[i], new BindedReciver(self, events[i]));
      }

      self.emit('ready', page);

      self.on('onLoadStarted', function(){
        self.isLoaded = false;
      });

      self.on('onLoadFinished', function(){
        self.isLoaded = true;
      });

      self.on('onPageCreated', function(tab){
        self.tabs.push(tab[0]);
        self.page = tab[0];
        self.debug("new tab opened");
          for (var i = 0; i < events.length; i++) {
            tab[0].set(events[i], new BindedReciver(self, events[i]));
          }
      });

      page.set('onConsoleMessage', function(){

        var args = arguments;
        if(!self.processConsoleCMD(args)){

          var toString = function(){
            var out = "";
            for(var k in args) out+=args[k];
            return out;
          };
          self.debug('FROM BROWSER CONSOLE > '+toString(args));
        }
      });


    });
  });

  self.on('ready', function () {
      self.debug('Browser ready ');
  });


};


utils.inherits(Browser, EventEmitter);

/**
 * is a internal method, is called by onConsoleMessage.
 * This method catch the console.log emit by evaluate expression, split the string and process for internal browser libreary commands.
 */
Browser.prototype.processConsoleCMD = function(data){
  var browser = this;
  var input = data[0];

  var res = false;

  var parts = input.split(";;||;;");
  parts.forEach(function(v,i){
    parts[i]= v.trim();
  });

  switch(parts[0]){
    case '__PHANTOMJS_EVENT__AJAX_STARTED':
          browser.emit('__PHANTOMJS_EVENT__AJAX_STARTED');
          res = true;
          break;

    case '__PHANTOMJS_EVENT__AJAX_COMPLETE':
        browser.emit('__PHANTOMJS_EVENT__AJAX_COMPLETE', parts[1], parts[2]);
        res = true;
          break;
  }

  return res;

};


/**
 * wait for ajax request is complete
 * @returns {Promise}
 */
Browser.prototype.waitAjaxComplete = function(){
    var browser  =this;
  return new Promise(function(resolve, reject){
    browser.once('__PHANTOMJS_EVENT__AJAX_COMPLETE', function(){
        resolve();
    });
  });
};

/**
 * return cookies (actual web page)
 * @returns {*}
 */
Browser.prototype.getCookies = function(){
  return this.get('cookies');
};

/**
 * fire event then Browser instance is ready
 * @returns {Promise}
 */
Browser.prototype.whenReady = function () {
  var browser = this;

  return new Promise(function (resolve, reject) {
    if (browser.closed) return reject('Browser already closed');
    if (browser.page) return resolve();

    browser.once('ready', function () {
      resolve();
    });
  });
};


Browser.prototype.ready = Browser.prototype.whenReady;
/**
 * Close the Browser instance
 * @returns {Promise}
 */
Browser.prototype.close = function () {
  var browser = this;


  return new Promise(function (resolve) {
    browser.whenReady().then(function () {

      browser.ph.process.on('exit', function(code){
        browser.closed = true;
        browser.debug('closed');
        resolve(code);
      });
      browser.ph.exit();

    }, function () {
      // whenReady error: already closed

      resolve();
    });
  });
};

/**
 * open a website (page)
 * @param url
 * @param method (get, post, etc)
 * @param data (object with data to passed to request)
 * @returns {Promise}
 */
  Browser.prototype.open = function (url, method, data) {
  var self = this;

  return new Promise(function (resolve, reject) {
    if (!url) return reject('Missing URL');
    if (!method) return reject('Missing method');

    self.whenReady().then(
      function () {
        self.page.open(url, method, data, function (status) {
          self.debug('opened '+url);
          resolve();
        });
      },
      reject
     );
  });
};


/**
 * run javascript into website scope. All aditionals arguments passed will are arguments by evaluate function.
 * @param fn (function)
 * @returns {Promise}
 */
Browser.prototype.evaluate = function (fn) {
  var browser = this;
  var args = Array.prototype.slice.call(arguments, 1);

  browser.debug('evaluate args '+ args);

  return new Promise(function (resolve, reject) {
    var evalArgs = [fn, resolve].concat(args);
    browser.whenReady().then(
      function () {
        browser.debug("EVALUATE OK "+args);
        browser.page.evaluate.apply(browser.page, evalArgs);
      },
      function(err){
        browser.debug('ERORR EVALUATE: '+ err)
        reject(err);
      });
  });
};


/**
 * Go to url (open webpage)
 * @param url
 * @returns {Promise}
 */
Browser.prototype.browseTo = function (url) {
  var browser = this;

  return new Promise(function (resolve, reject) {
    browser.open(url, 'GET', '')
      .then(function (status) {
        browser.debug('browseTo '+ url);
        resolve();
      }, function(){
            browser.debug('Error open website: '+ url);
            reject();
       });
  });
};



/**
 * Click into bottom
 * @param selector (path dom)
 * @param position (is the queyr resturn more that 1 element, you can set the elements array position. By default is 0
 * @returns {Promise}
 */
Browser.prototype.click = function (selector, position) {
  var browser = this;

  var position = position || 0;
  return new Promise(function (resolve, reject) {
    browser
    .evaluate(
      function (selector, position) {
        var target = document.querySelectorAll(selector);

        console.log(target);
        if (target) {
          var ev = document.createEvent('MouseEvents');
          ev.initEvent('click', true, true);
          target[position].dispatchEvent(ev);
        };

        return target ? target[position].innerHTML : target;
      },
      selector, position)
    .then(
      function (result) {
        if (result === null) return reject(result);
        browser.debug('clicked '+ selector);
        resolve();
      }, function(err){
             browser.debug("error click method: "+err);
            reject();
        }
    );
  });
};

Browser.prototype.check = function(selector, is){
  var browser = this;
  return new Promise(function(resolve, reject){
    if(!is) {
      browser.debug('no click for check, is false or zero');
      resolve();
    } else{
      browser.click(selector, 0)
          .then(function(){
            browser.debug('check '+ selector);
            resolve();
          });
    }
  });
};


/**
 * inject JS into website (after onload) and catch all ajax request. Dont remove console.log, is the core off internal EVENTS!
 * @returns {Promise}
 */
Browser.prototype.ajaxLoad = function(){
  var browser = this;

  return new Promise(function(resolve, reject){
    browser.evaluate(function(content){

      (function() {
        console.log('Adding external JS');
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function() {

          console.log('__PHANTOMJS_EVENT__AJAX_STARTED;;||;;',  this.readyState, ';;||;;');
          this.addEventListener('load', function() {

            if(this.readyState==4){
              console.log('__PHANTOMJS_EVENT__AJAX_COMPLETE ;;||;;', this.readyState, ';;||;;',this.responseText);
            }

          });
          origOpen.apply(this, arguments);
        };
      })();


    },"")
        .then(function(){
          resolve();
        }, function(err){
          browser.debug('Error 2992837');
          reject(err);
        });
  });


};


/**
 * Wait the page is loaded (onload).
 * @returns {Promise}
 */
Browser.prototype.waitLoadFinish = function () {
  var browser = this;

  return new Promise(function (resolve, reject) {
  browser.debug("listen loaded");
    if(browser.isLoaded){
      resolve();
    }else{
        browser.on('onLoadFinished', function () {
          browser.page.get('url', function (currentURL) {

            browser.ajaxLoad()
                .then(function(){
                  browser.debug('LoadFINISH : '+ currentURL);
                  resolve(currentURL);
                  browser.removeAllListeners('onLoadFinished');
                });
          });
        });
    }//end else
  });
};

Browser.prototype.loaded = Browser.prototype.waitLoadFinish;

/**
 * wait for url chage, fire a event (internal)
 * @param url (the url for wait)
 * @returns {Promise}
 */
Browser.prototype.waitForUrl = function (url) {
  var browser = this;

  return new Promise(function (resolve, reject) {
    browser.page.get('url', function (actualUrl) {
      if ((typeof (url) === 'string' && url === actualUrl) ||
          (url instanceof RegExp && url.test(actualUrl))) {
        browser.debug('waitForUrl matched (first) ' + actualUrl);
        return resolve();
      }

      var listener = function () {
        browser.debug('waitForUrl init...');
        browser.page.get('url', function (actualUrl) {
          if ((typeof (url) === 'string' && url === actualUrl) ||
             (url instanceof RegExp && url.test(actualUrl))) {
            browser.removeListener('onUrlChanged', listener);
            browser.debug('waitForUrl matched '+ actualUrl);

            resolve();
          } else {
            browser.debug('waitForUrl NOT matched '+actualUrl+' with ' + url);
          }
        });
      };

      browser.once('onUrlChanged', listener);
    });
  });
};

/**
 * complete a field (input, for example) with value.
 * @param selector (dom path to element)
 * @param value (the string value for value property)
 * @returns {Promise}
 */
Browser.prototype.fillField = function (selector, value, position) {
  var browser = this;

  var position = position || 0;
  return new Promise(function (resolve, reject) {
    browser
    .evaluate(
      function (selector, value, position) {
        var element = document.querySelectorAll(selector);

        if (!element) return 'Invalid selector';

        element[position].value = value;
      },
      selector,
      value,
      position)
    .then(
      function (error) {
          if (error) {
            browser.debug('fillField '+selector+' with '+value+' error: '+error);
            return reject(error);
          }else{
            browser.debug('fillField succeded for '+selector+' with value '+value);

            resolve();
          }//end else


      }//end function
    );
  });
};


/**
 * Find text aparition into textContent property element
 * @param selector (dom path)
 * @param text (string to find, is partial text, not literal).
 * @returns {Promise}
 */
Browser.prototype.findText = function (selector, text, literal) {
  var browser = this;

  var literal = literal || false;

  return new Promise(function (resolve, reject) {
    browser.evaluate(function (selector, text, literal) {
      var element = document.querySelector(selector);
      if (!element) return false;

          if(literal){
            if (element.textContent == text) {return true;}
            else {return false;}
          }else{
            if (element.textContent.indexOf(text) > -1) {return true;}
            else {return false;}
          }//end else

    },
    selector,
    text,
    literal)
    .then(function (result) {
      if (result)  {
        browser.debug('findText '+text+' in '+selector);
        resolve(result);
      }else{
        browser.debug('findText '+text+' in '+selector+' result: ' + result);
        reject(result);
      }

    })
  });
};

/**
 * fill all fields passed to argument.
 * @param fields (is a object, the key is the dom path, the value of key is value of value property)
 * @returns {Promise}
 */
Browser.prototype.fillFields = function (fields) {
  var browser = this;

  function FillFunction (browser, selector, value) {
    return function () {
      return browser.fillField(selector, value);
    }
  };

  return new Promise(function (resolve, reject) {
    var pending = [];

    for (var k in fields) {
      pending.push(new FillFunction(browser, k, fields[k]));
    }

    var checkPending = function () {
      var current = pending.shift();
      if (!current) return resolve();
      current().then(checkPending, reject);
    };

    checkPending();
  });
};

/**
 * get a screenshot of actualy page
 * @param file (is optional, the the filename, isnt passed, the filename is the actual timestamp)
 */
Browser.prototype.screenshot = function (file) {
  var browser = this;
  var folder = browser.instanceID+"/";
  var path = browser.screenshotFolder;
  file = file || (new Date().getTime() + '.png');

if(!fs.existsSync(path+"/"+folder)){
  fs.mkdirSync(path+"/"+folder);
}
  var fpath = path+"/"+folder+file;


  return new Promise(function(resolve, reject){
    browser.page.render(fpath, function () {
      browser.debug('__SCREENSHOT__: '+fpath);
      resolve(fpath);
    });
  });

};

/**
 * Enabled a disabled dom element
 * @param selector (is dom path)
 * @returns {Promise}
 */
Browser.prototype.enabled = function(selector){
  var browser  =  this;

  return new Promise(function(resolve, reject){
      browser.evaluate(function(selector){
        var el = document.querySelector(selector);
        if(el) el.disabled = null;
        else return null;
      }, selector)
          .then(function(r){
            if(r){
              browser.debug('Enabling '+selector+ ' is '+r);
              resolve();
            }else{
              browser.debug('No found '+selector+ ' is '+r);
              reject("enabled: Not found: "+selector);
            }

          });
  });
};


/**
 * Get the textContent form dom element
 * @param selector (dom path)
 * @returns {Promise}
 */
Browser.prototype.getText = function(selector){
    var browser = this;

  return new Promise(function(resolve, reject){
      browser.evaluate(function(selector){
        var el = document.querySelector(selector);
        if(el) return el.textContent;
        else return null;
      }, selector)
          .then(function(text){
            if(text) {
              resolve(text);
            }else{
              reject("getText : not found: "+selector);
            }

          });
  });
};


/**
 * set value for option and fire "onchange" event
 * @param selector: query selector element
 * @param value: the value for select tag
 * @returns {Promise}
 */
Browser.prototype.select = function(selector, value){
  var browser = this;
  return new Promise(function(resolve, reject){
      browser.evaluate(function(selector, value){
        var el = document.querySelector(selector);
        if(!el) return false;
        else{
            var evt = document.createEvent("HTMLEvents");
            evt.initEvent("change", false, true);
            el.value = value;
            el.dispatchEvent(evt);

          return true;
          }

      }, selector, value)
          .then(function(r){
               if(r){
                  browser.debug('select ok '+selector+' '+value);
                  resolve()
                }else{
                  browser.debug('select with error'+selector+' '+value+' '+r );
                  reject('cant select '+value);
                }
          });
  });
};


Browser.prototype.selectAndFill = function(sel1, val1, sel2, val2){
  var browser = this;
  return new Promise(function(resolve, reject){
    if(!val1){
      resolve();
    }else{
      browser.select(sel1, val1)
          .then(function(){
            browser.fillField(sel2, val2)
          })
          .then(function(){
            browser.debug('selectAndFill finish without errors');
            resolve();
          }, function(err){
            browser.debug('selectAndFill finish WITH ERRORS');
            reject(err);
          })
    }
  });
};

module.exports = Browser;
