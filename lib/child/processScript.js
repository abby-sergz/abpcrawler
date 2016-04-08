"use strict";
/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the "License"). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 */

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

/**
 * @param e exception
 */
function reportException(e)
{
  let stack = "";
  if (e && typeof e == "object" && "stack" in e)
    stack = e.stack + "\n";

  Cu.reportError(e);
  dump(e + "\n" + stack + "\n");
}

let {Services} = Cu.import("resource://gre/modules/Services.jsm", {});
let {XPCOMUtils} = Cu.import("resource://gre/modules/XPCOMUtils.jsm", {});
let {console} = Cu.import("resource://gre/modules/devtools/Console.jsm", {});

let getRequestWindow = function(/**nsIChannel*/ channel) /**nsIDOMWindow*/
  {
    try
    {
      if (channel.notificationCallbacks)
        return channel.notificationCallbacks.getInterface(Ci.nsILoadContext).associatedWindow;
    } catch(e) {}

    try
    {
      if (channel.loadGroup && channel.loadGroup.notificationCallbacks)
        return channel.loadGroup.notificationCallbacks.getInterface(Ci.nsILoadContext).associatedWindow;
    } catch(e) {}

    return null;
  };
/**
   * Retrieves the top-level chrome window for a content window.
   */
let getChromeWindow = function(/**Window*/ window) /**Window*/
  {
    return window.QueryInterface(Ci.nsIInterfaceRequestor)
                 .getInterface(Ci.nsIWebNavigation)
                 .QueryInterface(Ci.nsIDocShellTreeItem)
                 .rootTreeItem
                 .QueryInterface(Ci.nsIInterfaceRequestor)
                 .getInterface(Ci.nsIDOMWindow);
  };

// https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIWebProgressListener
let webProgressListener =
{
  onStateChange: function(webProgress, request, flags, status)
  {
    console.log("onStateChange");
    // use isTopLevel to filter beacon requests out
    if (webProgress.isTopLevel &&
        (flags & Ci.nsIWebProgressListener.STATE_STOP) &&
        (flags & Ci.nsIWebProgressListener.STATE_IS_WINDOW))
    {
      if (request instanceof Ci.nsIHttpChannel)
      {
        let win = webProgress.DOMWindow;
        let outerWindowID = win.QueryInterface(Ci.nsIInterfaceRequestor)
                            .getInterface(Ci.nsIDOMWindowUtils)
                            .outerWindowID;
        let pageInfo = {headers: []};
        try
        {
          pageInfo.headers.push("HTTP/x.x " + request.responseStatus + " " + request.responseStatusText);
          request.visitResponseHeaders((header, value) => pageInfo.headers.push(header + ": " + value));
        }
        catch (e)
        {
          reportException(e);
        }
        Object.assign(pageInfo, gatherPageInfo(win));
        sendAsyncMessage("abpcrawler:pageInfoGathered", {outerWindowID, pageInfo});
      }
    }
  },

  // definitions of the remaining functions see related documentation
  onLocationChange: function(webProgress, request, URI, flag) {},
  onProgressChange: function(aWebProgress, aRequest, curSelf, maxSelf, curTot, maxTot) {},
  onStatusChange: function(aWebProgress, aRequest, aStatus, aMessage) {},
  onSecurityChange: function(aWebProgress, aRequest, aState) {},
 
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener, Ci.nsISupportsWeakReference])
};

/**
 * The class observes "content-document-global-created" and attaches "load"
 * event listener to newly created nsIDOMWindow object. When "load" event occurs
 * it gathers required information and sends it to chrome process using
 * "abpcrawler:windowLoaded" message.
 *
 */

let docShellCache = new WeakMap();

let documentObserver =
{
  observe: function(subject, topic, data)
  {
    console.log("observe");
    let window = subject.QueryInterface(Ci.nsIInterfaceRequestor)
                        .getInterface(Ci.nsIDOMWindow);
    if (!window)
      return;
/*
    let filter = Cc["@mozilla.org/appshell/component/browser-status-filter;1"]
                 .createInstance(Ci.nsIWebProgress);
    filter.addProgressListener(webProgressListener, Ci.nsIWebProgress.NOTIFY_ALL);

//    let docShell = window.QueryInterface(Ci.nsIInterfaceRequestor)
//                   .getInterface(Ci.nsIDocShell);
    let tree = window.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDocShellTreeItem);
    let top = tree.sameTypeRootTreeItem;
    let iface = QueryInterface(Ci.nsIDocShell).QueryInterface(Ci.nsIInterfaceRequestor);
    let docShell = iface.getInterface(Ci.nsIContentFrameMessageManager).docShell;

    if (!docShell)
      return;

    let storedValue = docShellCache.get(docShell);
    if (storedValue)
      return;
    docShellCache.set(docShell, 10);
    let webProgress = docShell.QueryInterface(Ci.nsIInterfaceRequestor)
                          .getInterface(Ci.nsIWebProgress);
    webProgress.addProgressListener(filter, Ci.nsIWebProgress.NOTIFY_ALL);
/*/
    // this approach does work, however screenshots are made when the page is not fully loaded yet
    window.addEventListener("load", function onLoad()
    {
      window.removeEventListener("load", onLoad, false);
      let windowUtils = getChromeWindow(window).QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                       .getInterface(Components.interfaces.nsIDOMWindowUtils);
      let outerWindowID = windowUtils.outerWindowID;
      console.log("window loaded", outerWindowID);
      let wnd = Services.wm.getOuterWindowWithId(outerWindowID)
      let pageInfo = gatherPageInfo(wnd);
      sendAsyncMessage("abpcrawler:pageInfoGathered", {outerWindowID, pageInfo});
    }, false);
//*/
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference])

};
Services.obs.addObserver(documentObserver, "content-document-global-created", true)

function onShutdown()
{
  removeMessageListener("abpcrawler:shutdown", onShutdown);
  Services.obs.removeObserver(documentObserver, "content-document-global-created");
  console.log("child process srcipt onShutdown finished");
}
addMessageListener("abpcrawler:shutdown", onShutdown);

/**
 * Gathers information about page using DOM window.
 * Currently
 *  - creates a screenshot of the page
 *  - serializes the page source code
 * @param {nsIDOMWindow} wnd window to process
 * @return {Object} the object containing "screenshot" and "source" properties.
 */
function gatherPageInfo(wnd)
{
  let document = wnd.document;
  let result = {};
  if (document.documentElement)
  {
    try
    {
      let canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = document.documentElement.scrollWidth;
      canvas.height = document.documentElement.scrollHeight;
      if (canvas.width > 0 && canvas.height > 0)
      {
        let context = canvas.getContext("2d");
        context.drawWindow(wnd, 0, 0, canvas.width, canvas.height, "rgb(255, 255, 255)");
        result.screenshot = canvas.toDataURL("image/jpeg", 0.8);
      }
      // TODO: Capture frames as well?
      let serializer = new wnd.XMLSerializer();
      result.source = serializer.serializeToString(document.documentElement);
    }
    catch (e)
    {
      reportException(e);
      result.error = "Cannot gather page info";
    }
  }
  return result;
}

console.log("child process script intialized");
