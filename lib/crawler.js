/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the "License"). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 */

/**
 * @module crawler
 */

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/Timer.jsm");

function abprequire(module)
{
  let result = {};
  result.wrappedJSObject = result;
  Services.obs.notifyObservers(result, "adblockplus-require", module);
  return result.exports;
}

let {RequestNotifier} = abprequire("requestNotifier");
let {FilterNotifier} = abprequire("filterNotifier");
let {FilterStorage} = abprequire("filterStorage");

/**
 * Allocates tabs on request but not more than maxtabs at the same time.
 *
 * @param {tabbrowser} browser
 *    The tabbed browser where tabs should be created
 * @param {int} maxtabs
 *    The maximum number of tabs to be allocated
 * @constructor
 */
function TabAllocator(browser, maxtabs)
{
  this._browser = browser;
  this._tabs = 0;
  this._maxtabs = maxtabs;
  // The queue containing resolve functions of promises waiting for a tab.
  this._resolvers = [];
  // Keep at least one tab alive to prevent browser from closing itself.
  let tabToRemove = this._browser.tabs[0];
  this._browser.removeAllTabsBut(tabToRemove);
  // this._tab is a keep alive tab
  this._tab = this._createTab().then(tab =>
  {
    // Starting from Firefox 48 (nightly) the sequence of calls addTab and
    // removeTab can cause a closing of the browser because a new tab is still
    // not here. Because of that we need to remove the previous tab only after
    // the new tab is ready.
    this._browser.removeTab(tabToRemove);
    return tab;
  });
}
TabAllocator.prototype = {
  /**
   * Creates a blank tab in this._browser.
   *
   * @return {Promise.<tab>} promise which resolves once the tab is fully initialized.
   */
  _createTab: function()
  {
    this._tabs++;
    let tab = this._browser.addTab("about:blank");
    if (tab.linkedBrowser.outerWindowID)
      return Promise.resolve(tab);
    return new Promise((resolve, reject) =>
    {
      let onBrowserInit = (msg) =>
      {
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1256602#c1
        tab.linkedBrowser.messageManager.removeMessageListener("Browser:Init", onBrowserInit);
        resolve(tab);
      };
      tab.linkedBrowser.messageManager.addMessageListener("Browser:Init", onBrowserInit);
    });
  },

  /**
   * Returns a promise that will resolve into a tab once a tab is allocated.
   * The tab cannot be used by other tasks until releaseTab() is called.
   *
   * @result {Promise.<tab>}
   */
  getTab: function()
  {
    if (this._tab)
    {
      let tab = this._tab;
      delete this._tab;
      return tab;
    }
    if (this._tabs < this._maxtabs)
      return this._createTab();
    return new Promise((resolve, reject) => this._resolvers.push(resolve));
  },

  /**
   * Adds a tab back to the pool so that it can be used by other tasks.
   *
   * @param {tab} tab
   */
  releaseTab: function(tab)
  {
    // If we are about to close last tab don't close it immediately rather
    // allocate a new blank tab and close the current one afterwards.
    if (this._tabs == 1)
    {
      this._tab = this._createTab().then((resultTab) =>
      {
        this.releaseTab(tab);
        return resultTab;
      });
      return;
    }

    this._browser.removeTab(tab);
    this._tabs--;
    if (this._resolvers.length)
    {
      if (this._tab)
      {
        this._resolvers.shift()(this._tab);
        delete this._tab;
      }
      else if (this._tabs < this._maxtabs)
      {
        this._resolvers.shift()(this._createTab());
      }
    }
  },
};

/**
 * The class provides the facility to wait for page info for particular
 * outerWindowID.
 *
 * To specify outerWindowID of interested page info one should use `expect`
 * method which returns a {Promise} which is resolved either when `setPageInfo`
 * with that outerWindowID is called or when timeout runs out.
 *
 * @param {int} timeout
 *    Load timeout in milliseconds
 * @constructor
 */
PageInfoListener = function(timeout)
{
  this._timeout = timeout;
  this._pageInfoSetters = new Map();
};
PageInfoListener.prototype =
{
  expect: function(outerWindowID)
  {
    console.log("expect PageInfo", outerWindowID);
    let pageInfoFuture = new Promise((resolve, reject) =>
    {
      let timerID;
      let onDone = (pageInfo) =>
      {
        this._pageInfoSetters.delete(outerWindowID);
        clearTimeout(timerID);
        resolve(pageInfo);
      }
      timerID = setTimeout(onDone.bind(this, {error: "timeout"}), this._timeout);
      this._pageInfoSetters.set(outerWindowID, onDone);
    });
    return pageInfoFuture;
  },
  setPageInfo: function(outerWindowID, pageInfo)
  {
    console.log("setPageInfo", outerWindowID);
    let pageInfoSetter = this._pageInfoSetters.get(outerWindowID);
    if (pageInfoSetter)
    {
      pageInfoSetter(pageInfo);
    }
  }
}; 
let pageInfoListener;

/**
 * Once created, this object will make sure all new windows are dismissed
 * immediately.
 *
 * @constructor
 */
function WindowCloser()
{
  Services.obs.addObserver(this, "xul-window-registered", true)
}
WindowCloser.prototype = {
  /**
   * Deactivates this object.
   */
  stop: function()
  {
    Services.obs.removeObserver(this, "xul-window-registered")
  },

  observe: function(subject, topic, data)
  {
    let window = subject.QueryInterface(Ci.nsIInterfaceRequestor)
                        .getInterface(Ci.nsIDOMWindow)
    window.addEventListener("load", function()
    {
      if (window.document.documentElement.localName == 'dialog')
        window.document.documentElement.acceptDialog();
      else
        window.close();
    }, false);
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference])
};

/**
 * Starts the crawling session. The crawler opens each URL in a tab and stores
 * the results.
 *
 * @param {Window} window
 *    The browser window we're operating in
 * @param {String[]} urls
 *    URLs to be crawled
 * @param {int} timeout
 *    Load timeout in milliseconds
 * @param {int} maxtabs
 *    Maximum number of tabs to be opened
 * @param {String} targetURL
 *    URL that should receive the results
 * @param {Function} onDone
 *    The callback which is called after finishing of crawling of all URLs.
 */
function run(window, urls, timeout, maxtabs, targetURL, onDone)
{
  new Promise((resolve, reject) =>
  {
    if (FilterStorage.subscriptions.length > 0)
    {
      resolve();
      return;
    }
    let onFiltersLoaded = (action, item, newValue, oldValue) =>
    {
      if (action == "load")
      {
        FilterNotifier.removeListener(onFiltersLoaded);
        resolve();
      }
    };
    FilterNotifier.addListener(onFiltersLoaded);
  }).then(() => crawl_urls(window, urls, timeout, maxtabs, targetURL, onDone))
  .catch(reportException);
}
exports.run = run;

/**
 * Spawns a {Task} task to crawl each url from urls argument and calls
 * onDone when all tasks are finished.
 * @param {Window} window
 *   The browser window we're operating in
 * @param {String[]} urls
 *   URLs to be crawled
 * @param {int} timeout
 *    Load timeout in milliseconds
 * @param {int} maxtabs
 *    Maximum number of tabs to be opened
 * @param {String} targetURL
 *    URL that should receive the results
 * @param {Function} onDone
 *    The callback which is called after finishing of all tasks.
 */
function crawl_urls(window, urls, timeout, maxtabs, targetURL, onDone)
{
  pageInfoListener = new PageInfoListener(timeout);
  let tabAllocator = new TabAllocator(window.getBrowser(), maxtabs);

  let running = 0;
  let windowCloser = new WindowCloser();
  let taskDone = function()
  {
    running--;
    if (running <= 0)
    {
      windowCloser.stop();
      onDone();
    }
  };

  for (let url of urls)
  {
    running++;
    Task.spawn(crawl_url.bind(null, url, tabAllocator, timeout)).then(function(result)
    {
      let request = new XMLHttpRequest();
      request.open("POST", targetURL);
      request.addEventListener("load", taskDone, false);
      request.addEventListener("error", taskDone, false);
      request.send(JSON.stringify(result));
    }, function(url, exception)
    {
      reportException(exception);

      let request = new XMLHttpRequest();
      request.open("POST", targetURL);
      request.addEventListener("load", taskDone, false);
      request.addEventListener("error", taskDone, false);
      request.send(JSON.stringify({
        url: url,
        startTime: Date.now(),
        error: String(exception)
      }));
    }.bind(null, url));
  }
}

/**
 * Crawls a URL. This is a generator meant to be used via a Task object.
 *
 * @param {String} url
 * @param {TabAllocator} tabAllocator
 * @param {int} timeout
 *    Load timeout in milliseconds
 * @result {Object}
 *    Crawling result
 */
function* crawl_url(url, tabAllocator, timeout)
{
  let tab = yield tabAllocator.getTab();
  let result = {url, requests: []};
  let requestNotifier;
  try
  {
    result.startTime = Date.now();
    requestNotifier = new RequestNotifier(tab.linkedBrowser.outerWindowID,
      function(entry, scanComplete)
    {
      if (!entry)
        return;
      let {type: contentType, location, filter} = entry;
      result.requests.push({location, contentType, filter});
    });

    let pageInfoFuture = pageInfoListener.expect(tab.linkedBrowser.outerWindowID);

    tab.linkedBrowser.loadURI(url, null, null);

    let pageInfo = yield pageInfoFuture;
    result.finalUrl = tab.linkedBrowser.currentURI.spec;
    Object.assign(result, pageInfo);
    result.endTime = Date.now();
  }
  finally
  {
    if (requestNotifier)
      requestNotifier.shutdown();
    tabAllocator.releaseTab(tab);
  }
  return result;
}

function reportException(e)
{
  let stack = "";
  if (e && typeof e == "object" && "stack" in e)
    stack = e.stack + "\n";

  Cu.reportError(e);
  dump(e + "\n" + stack + "\n");
}

let {addonRoot} = require("info");
let processScriptPath = addonRoot + "/lib/child/processScript.js";
Services.ppmm.loadProcessScript(processScriptPath, true);

function onWindowLoaded(msg)
{
  pageInfoListener.setPageInfo(msg.data.outerWindowID, msg.data.pageInfo);
}
Services.ppmm.addMessageListener("abpcrawler:pageInfoGathered", onWindowLoaded);

onShutdown.add(() =>
{
  Services.ppmm.removeMessageListener("abpcrawler:pageInfoGathered", onWindowLoaded);
  Services.ppmm.broadcastAsyncMessage("abpcrawler:shutdown");
  Services.ppmm.removeDelayedProcessScript(processScriptPath);
  console.log("zzz");
});
