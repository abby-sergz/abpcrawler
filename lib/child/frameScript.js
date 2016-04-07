/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the "License"). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 */
"use strict";

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

/**
 * Waits for finishing of the page loading, calls `gatherPageInfo` and sends
 * gahter information using "abpcrawler:pageInfoGathered" message.
 * https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIWebProgressListener
 */
let webProgressListener =
{
  onStateChange: function(webProgress, request, flags, status)
  {
    // use isTopLevel to filter beacon requests out
    if (webProgress.isTopLevel &&
        (flags & Ci.nsIWebProgressListener.STATE_STOP) &&
        (flags & Ci.nsIWebProgressListener.STATE_IS_WINDOW))
    {
      if (request instanceof Ci.nsIHttpChannel)
      {
        let pageInfo = {headers: []};
        try
        {
          pageInfo.headers.push("HTTP/x.x " + request.responseStatus + " " + request.responseStatusText);
          request.visitResponseHeaders((header, value) =>pageInfo.headers.push(header + ": " + value));
        }
        catch (e)
        {
          reportException(e);
        }
        Object.assign(pageInfo, gatherPageInfo(content));
        sendAsyncMessage("abpcrawler:pageInfoGathered", pageInfo);
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

let filter = Cc["@mozilla.org/appshell/component/browser-status-filter;1"]
             .createInstance(Ci.nsIWebProgress);
filter.addProgressListener(webProgressListener, Ci.nsIWebProgress.NOTIFY_ALL);

let webProgress = docShell.QueryInterface(Ci.nsIInterfaceRequestor)
                          .getInterface(Ci.nsIWebProgress);
webProgress.addProgressListener(filter, Ci.nsIWebProgress.NOTIFY_ALL);

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
