/*

  Copyright (C) 2011 Chad Weider

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.

*/

var fs = require('fs');
var urlutil = require('url');
var pathutil = require('path');
var requestURL = require('./request').requestURL;

function hasOwnProperty(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function toJSLiteral(object) {
  // Remember, JSON is not a subset of JavaScript. Some line terminators must
  // be escaped manually.
  var result = JSON.stringify(object);
  result = result.replace('\u2028', '\\u2028').replace('\u2029', '\\u2029');
  return result;
}

function mixin(object1, object2, objectN) {
  var object = {};
  for (var i = 0, ii = arguments.length; i < ii; i++) {
    var o = arguments[i];
    for (var key in o) {
      if (hasOwnProperty(o, key)) {
        object[key] = o[key];
      }
    }
  }
  return object;
}

function selectProperties(o, keys) {
  var object = {};
  for (var i = 0, ii = keys.length; i < ii; i++) {
    var key = keys[i];
    if (hasOwnProperty(o, key)) {
      object[key] = o[key];
    }
  }
  return object;
}

function validateURI(uri) {
  var parsed = urlutil.parse(uri);
  if (parsed.protocol != 'file:'
      && parsed.protocol != 'http:'
      && parsed.protocol != 'https:') {
    throw "Invalid URI: " + JSON.stringify(uri) + ".";
  }
}

/*
  I implement a JavaScript module server.
*/
function Server(options) {
  function trailingSlash(path) {
    if (path.charAt(path.length) != '/') {
      return path + '/';
    } else {
      return path;
    }
  }
  function leadingSlash(path) {
    if (path.charAt(0) != '/') {
      return '/' + path;
    } else {
      return path;
    }
  }

  if (options.rootURI) {
    this._rootURI = trailingSlash(options.rootURI);
    validateURI(this._rootURI);
    if (options['rootPath'] || options['rootPath'] == '') {
      this._rootPath = trailingSlash(options.rootPath.toString());
    } else {
      this._rootPath = 'root/';
    }
  }

  if (options.libraryURI) {
    this._libraryURI = trailingSlash(options.libraryURI)
    validateURI(this._rootURI);
    if (options['libraryPath'] || options['libraryPath'] == '') {
      this._libraryPath = trailingSlash(options.libraryPath.toString());
    } else {
      this._libraryPath = 'library/';
    }
  }

  if (this._rootPath && this._libraryPath
      && (this._rootPath.indexOf(this._libraryPath) == 0
        || this._libraryPath.indexOf(this._rootPath) == 0)) {
    throw "The paths " + JSON.stringify(this._rootPath) + " and " +
        JSON.stringify(this._libraryPath) + " are ambiguous.";
  }
}
Server.prototype = new function () {
  function handle(request, response) {
    var url = require('url').parse(request.url, true);
    var path = pathutil.normalize(url.pathname);

    var resourceURI;
    var isLibraryResource;
    if (path.indexOf(this._rootPath) == 0) {
      path = path.slice(this._rootPath.length);
      resourceURI = this._rootURI + path;
      isLibraryResource = false;
    } else if (this._libraryURI && path.indexOf(this._libraryPath) == 0) {
      path = path.slice(this._libraryPath.length);
      resourceURI = this._libraryURI + path;
      isLibraryResource = true;
    } else {
      // Something has gone wrong.
    }

    var requestHeaders = mixin({
          'user-agent': 'yajsml'
        , 'accept': '*/*'
        }
      , selectProperties(
          request.headers
        , ['if-modified-since', 'Cache-Control']
        )
      );

    if (request.method != 'HEAD' && request.method != 'GET') {
      // I don't know how to do this.
      response.writeHead(405, {
        'allow': 'HEAD, GET'
      , 'content-type': 'text/plain; charset=utf-8'
      });
      response.write("405: Only the HEAD or GET methods are allowed.")
      response.end();
    } else if (!resourceURI) {
      response.writeHead(400, {
        'content-type': 'text/plain; charset=utf-8'
      });
      response.write("400: The requested resource could not be found.")
      response.end();
    } else if (!('callback' in url.query)) {
      // I respond with a straight-forward proxy.
      requestURL(resourceURI, 'GET', requestHeaders,
        function (status, headers, content) {
          var responseHeaders = selectProperties(
              headers
            , ['date', 'last-modified', 'cache-control', 'content-type']
            );
          if (status == 200 && ('content-type' in responseHeaders)) {
            responseHeaders['content-type'] =
                'application/javascript; charset=utf-8'
          }
          response.writeHead(status, responseHeaders);
          if (request.method == 'GET') {
            content && response.write(content);
          }
          response.end();
        }
      );
    } else {
      var JSONPCallback = url.query['callback'];
      if (JSONPCallback.length == 0) {
        response.writeHead(400, {
          'content-type': 'text/plain; charset=utf-8'
        });
        response.write("400: The parameter `callback` must be non-empty.")
        response.end();
        return;
      }

      var modulePath;
      if (isLibraryResource) {
        modulePath = path.replace(/^\//, '');
      } else {
        modulePath = path.charAt(0) == '/' ? path : '/' + path;
      }

      var respond = function (status, headers, content) {
        var responseHeaders = mixin(
            selectProperties(
              headers
            , ['date', 'last-modified', 'cache-control', 'content-type']
            )
          , {
              'tontent-type': 'application/javascript; charset=utf-8'
            }
          );

        if (status == 304) {
          response.writeHead(status, responseHeaders);
          response.end();
        } else {
          if (request.method == 'GET') {
            var definition;
            if (status == 200) {
              definition =
                'function (require, exports, module) {\n' + content + '\n}';
            } else {
              definition = 'null';
            }

            content =
                JSONPCallback + '({\n'
                + toJSLiteral(modulePath) + ': ' + definition
                + '\n});\n'
                ;
          }


          response.writeHead(200, responseHeaders);
          if (request.method == 'GET') {
            content && response.write(content);
          }
          response.end();
        }
      };

      requestURL(resourceURI, 'HEAD', requestHeaders,
        function (status, headers, content) {
          if (status == 304) { // Skip the content, since it didn't change.
            respond(status, headers);
          } else if (request.method == 'HEAD' && status != 405) {
            respond(status, headers);
          } else {
            requestURL(resourceURI, 'GET', requestHeaders,
              function (status, headers, content) {
                if (request.method == 'HEAD') {
                  respond(status, headers);
                } else if (request.method == 'GET') {
                  respond(status, headers, content);
                }
              }
            );
          }
        }
      );
    }
  }

  this.handle = handle;
}();

exports.Server = Server;
