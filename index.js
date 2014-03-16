'use strict';

var pouchCollate = require('pouchdb-collate');
var Promise = typeof global.Promise === 'function' ? global.Promise : require('lie');
var collate = pouchCollate.collate;
var toIndexableString = pouchCollate.toIndexableString;
var normalizeKey = pouchCollate.normalizeKey;
var evalFunc = require('./evalfunc');
var log = (typeof console !== 'undefined') ?
  Function.prototype.bind.call(console.log, console) : function () {};

var INDEX_TYPE_SEQ = 0;
var INDEX_TYPE_KEYVALUE = 1;
var INDEX_TYPE_OUT_OF_BOUNDS = 2;

var processKey = function (key) {
  // Stringify keys since we want them as map keys (see #35)
  return JSON.stringify(normalizeKey(key));
};

// similar to java's hashCode function, converted to a hex string, adapted from:
// http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
function hexHashCode(str) {
  var hash = 0;
  for (var i = 0, len = str.length; i < len; i++) {
    var char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
  }
  return (hash & 0xfffffff).toString(16);
}

// This is the first implementation of a basic plugin, we register the
// plugin object with pouch and it is mixin'd to each database created
// (regardless of adapter), adapters can override plugins by providing
// their own implementation. functions on the plugin object that start
// with _ are reserved function that are called by pouchdb for special
// notifications.

// If we wanted to store incremental views we can do it here by listening
// to the changes feed (keeping track of our last update_seq between page loads)
// and storing the result of the map function (possibly using the upcoming
// extracted adapter functions)


function createKeysLookup(keys) {
  // creates a lookup map for the given keys, so that doing
  // query() with keys doesn't become an O(n * m) operation
  // lookup values are typically integer indexes, but may
  // map to a list of integers, since keys can be duplicated
  var lookup = {};

  for (var i = 0, len = keys.length; i < len; i++) {
    var key = processKey(keys[i]);
    var val = lookup[key];
    if (typeof val === 'undefined') {
      lookup[key] = i;
    } else if (typeof val === 'number') {
      lookup[key] = [val, i];
    } else { // array
      val.push(i);
    }
  }

  return lookup;
}

// standard sorting for emitted key/values
function sortByKeyIdValue(a, b) {
  var keyCompare = collate(a.key, b.key);
  if (keyCompare !== 0) {
    return keyCompare;
  }
  var idCompare = collate(a.id, b.id);
  return idCompare !== 0 ? idCompare : collate(a.value, b.value);
}
function addAtIndex(idx, result, prelimResults) {
  var val = prelimResults[idx];
  if (typeof val === 'undefined') {
    prelimResults[idx] = result;
  } else if (!Array.isArray(val)) {
    // same key for multiple docs, need to preserve document order, so create array
    prelimResults[idx] = [val, result];
  } else { // existing array
    val.push(result);
  }
}

function sum(values) {
  return values.reduce(function (a, b) {
    return a + b;
  }, 0);
}

var builtInReduce = {
  "_sum": function (keys, values) {
    return sum(values);
  },

  "_count": function (keys, values, rereduce) {
    return values.length;
  },

  "_stats": function (keys, values) {
    return {
      'sum': sum(values),
      'min': Math.min.apply(null, values),
      'max': Math.max.apply(null, values),
      'count': values.length,
      'sumsqr': (function () {
        var _sumsqr = 0;
        var error;
        for (var idx in values) {
          if (typeof values[idx] === 'number') {
            _sumsqr += values[idx] * values[idx];
          } else {
            error =  new Error('builtin _stats function requires map values to be numbers');
            error.name = 'invalid_value';
            error.status = 500;
            return error;
          }
        }
        return _sumsqr;
      })()
    };
  }
};

function addHttpParam(paramName, opts, params, asJson) {
  // add an http param from opts to params, optionally json-encoded
  var val = opts[paramName];
  if (typeof val !== 'undefined') {
    if (asJson) {
      val = encodeURIComponent(JSON.stringify(val));
    }
    params.push(paramName + '=' + val);
  }
}

function mapUsingKeys(inputResults, keys, keysLookup) {
  // create a new results array from the given array,
  // ensuring that the following conditions are respected:
  // 1. docs are ordered by key, then doc id
  // 2. docs can appear >1 time in the list, if their key is specified >1 time
  // 3. keys can be unknown, in which case there's just a hole in the returned array

  var prelimResults = new Array(keys.length);

  inputResults.forEach(function (result) {
    var idx = keysLookup[processKey(result.key)];
    if (typeof idx === 'number') {
      addAtIndex(idx, result, prelimResults);
    } else { // array of indices
      idx.forEach(function (subIdx) {
        addAtIndex(subIdx, result, prelimResults);
      });
    }
  });

  // flatten the array, remove nulls, sort by doc ids
  var outputResults = [];
  prelimResults.forEach(function (result) {
    if (Array.isArray(result)) {
      outputResults = outputResults.concat(result.sort(sortByKeyIdValue));
    } else { // single result
      outputResults.push(result);
    }
  });

  return outputResults;
}

function viewQuery(db, fun, options) {
  var origMap;
  if (!options.skip) {
    options.skip = 0;
  }

  if (!fun.reduce) {
    options.reduce = false;
  }

  var startkeyName = options.descending ? 'endkey' : 'startkey';
  var endkeyName = options.descending ? 'startkey' : 'endkey';

  if (typeof options[startkeyName] !== 'undefined' &&
    typeof options[endkeyName] !== 'undefined' &&
    collate(options[startkeyName], options[endkeyName]) > 0) {
    return options.complete({
      status : 400,
      name : 'query_parse_error',
      message : 'No rows can match your key range, reverse your ' +
        'start_key and end_key or set {descending : true}'
    });
  }

  var results = [];
  var current;
  var num_started = 0;
  var completed = false;
  var keysLookup;

  var totalRows = 0;

  function emit(key, val) {

    totalRows++;

    var viewRow = {
      id: current.doc._id,
      key: pouchCollate.normalizeKey(key),
      value: pouchCollate.normalizeKey(val)
    };

    if (typeof options[startkeyName] !== 'undefined' && collate(key, options[startkeyName]) < 0) {
      return;
    }
    if (typeof options[endkeyName] !== 'undefined' && collate(key, options[endkeyName]) > 0) {
      return;
    }
    if (typeof options.key !== 'undefined' && collate(key, options.key) !== 0) {
      return;
    }
    if (typeof options.keys !== 'undefined') {
      keysLookup = keysLookup || createKeysLookup(options.keys);
      if (typeof keysLookup[processKey(key)] === 'undefined') {
        return;
      }
    }

    num_started++;
    if (options.include_docs) {
      //in this special case, join on _id (issue #106)
      if (val && typeof val === 'object' && val._id) {
        db.get(val._id,
          function (_, joined_doc) {
            if (joined_doc) {
              viewRow.doc = joined_doc;
            }
            results.push(viewRow);
            checkComplete();
          });
        return;
      } else {
        viewRow.doc = current.doc;
      }
    }
    results.push(viewRow);
  }
  if (typeof fun.map === "function" && fun.map.length === 2) {
    //save a reference to it
    origMap = fun.map;
    fun.map = function (doc) {
      //call it with the emit as the second argument
      return origMap(doc, emit);
    };
  } else {
    // ugly way to make sure references to 'emit' in map/reduce bind to the
    // above emit
    fun.map = evalFunc(fun.map.toString(), emit, sum, log, Array.isArray, JSON.parse);
  }
  if (fun.reduce) {
    if (builtInReduce[fun.reduce]) {
      fun.reduce = builtInReduce[fun.reduce];
    } else {
      fun.reduce = evalFunc(fun.reduce.toString(), emit, sum, log, Array.isArray, JSON.parse);
    }
  }

  //only proceed once all documents are mapped and joined
  function checkComplete() {
    var error;
    if (completed && results.length === num_started) {

      if (typeof options.keys !== 'undefined' && results.length) {
        // user supplied a keys param, sort by keys
        results = mapUsingKeys(results, options.keys, keysLookup);
      } else { // normal sorting
        results.sort(sortByKeyIdValue);
      }
      if (options.descending) {
        results.reverse();
      }
      if (options.reduce === false) {
        return options.complete(null, {
          total_rows: totalRows,
          offset: options.skip,
          rows: ('limit' in options) ? results.slice(options.skip, options.limit + options.skip) :
            (options.skip > 0) ? results.slice(options.skip) : results
        });
      }

      var groups = [];
      results.forEach(function (e) {
        var last = groups[groups.length - 1];
        if (last && collate(last.key[0][0], e.key) === 0) {
          last.key.push([e.key, e.id]);
          last.value.push(e.value);
          return;
        }
        groups.push({key: [
          [e.key, e.id]
        ], value: [e.value]});
      });
      groups.forEach(function (e) {
        e.value = fun.reduce.call(null, e.key, e.value);
        if (e.value.sumsqr && e.value.sumsqr instanceof Error) {
          error = e.value;
          return;
        }
        e.key = e.key[0][0];
      });
      if (error) {
        options.complete(error);
        return;
      }
      options.complete(null, {
        total_rows: totalRows,
        offset: options.skip,
        rows: ('limit' in options) ? groups.slice(options.skip, options.limit + options.skip) :
          (options.skip > 0) ? groups.slice(options.skip) : groups
      });
    }
  }

  db.changes({
    conflicts: true,
    include_docs: true,
    onChange: function (doc) {
      if (!('deleted' in doc) && doc.id[0] !== "_") {
        current = {doc: doc.doc};
        fun.map.call(null, doc.doc);
      }
    },
    complete: function () {
      completed = true;
      checkComplete();
    }
  });
}

function httpQuery(db, fun, opts) {
  var callback = opts.complete;

  // List of parameters to add to the PUT request
  var params = [];
  var body;
  var method = 'GET';

  // If opts.reduce exists and is defined, then add it to the list
  // of parameters.
  // If reduce=false then the results are that of only the map function
  // not the final result of map and reduce.
  addHttpParam('reduce', opts, params);
  addHttpParam('include_docs', opts, params);
  addHttpParam('limit', opts, params);
  addHttpParam('descending', opts, params);
  addHttpParam('group', opts, params);
  addHttpParam('group_level', opts, params);
  addHttpParam('skip', opts, params);
  addHttpParam('startkey', opts, params, true);
  addHttpParam('endkey', opts, params, true);
  addHttpParam('key', opts, params, true);

  // If keys are supplied, issue a POST request to circumvent GET query string limits
  // see http://wiki.apache.org/couchdb/HTTP_view_API#Querying_Options
  if (typeof opts.keys !== 'undefined') {
    method = 'POST';
    if (typeof fun === 'string') {
      body = JSON.stringify({keys: opts.keys});
    } else { // fun is {map : mapfun}, so append to this
      fun.keys = opts.keys;
    }
  }

  // Format the list of parameters into a valid URI query string
  params = params.join('&');
  params = params === '' ? '' : '?' + params;

  // We are referencing a query defined in the design doc
  if (typeof fun === 'string') {
    var parts = fun.split('/');
    db.request({
      method: method,
      url: '_design/' + parts[0] + '/_view/' + parts[1] + params,
      body: body
    }, callback);
    return;
  }

  // We are using a temporary view, terrible for performance but good for testing
  var queryObject = JSON.parse(JSON.stringify(fun, function (key, val) {
    if (typeof val === 'function') {
      return val + ''; // implicitly `toString` it
    }
    return val;
  }));

  db.request({
    method: 'POST',
    url: '_temp_view' + params,
    body: queryObject
  }, callback);
}

function updateIndexSeq(index, seq, cb) {
  var seqKey = toIndexableString([INDEX_TYPE_SEQ, 'seq']);
  var keyValues = {};
  keyValues[seqKey] = seq;
  index.dbIndex.put('_local/seq', keyValues, function (err) {
    if (err) {
      return cb(err);
    }
    index.seq = seq;
    cb(null);
  });
}

function getIndex(db, mapFun, reduceFun, cb) {
  var index = new Index(db, mapFun, reduceFun);
  var seqKey = toIndexableString([INDEX_TYPE_SEQ, 'seq']);
  index.dbIndex.get(seqKey, function (err, res) {
    if (err) {
      return cb(err);
    }
    index.seq = res[0] ? res[0].value : 0;
    cb(null, index);
  });
}

function updateIndex(index, cb) {

  function callMapFun(doc, cb) {

    var docId = doc.doc._id;

    var indexableKeysToKeyValues = {};

    var i = 0;
    var emit = function (key, value) {
      var indexableStringKey = toIndexableString([INDEX_TYPE_KEYVALUE, key, docId, value, i++]);
      indexableKeysToKeyValues[indexableStringKey] = {
        id  : docId,
        key : normalizeKey(key),
        value : normalizeKey(value)
      };
    };

    var mapFun = evalFunc(index.mapFun.toString(), emit, sum, log, Array.isArray, JSON.parse);

    var reduceFun;
    if (index.reduceFun) {
      if (builtInReduce[index.reduceFun]) {
        reduceFun = builtInReduce[index.reduceFun];
      } else {
        reduceFun = evalFunc(index.reduceFun.toString(), emit, sum, log, Array.isArray, JSON.parse);
      }
    }

    mapFun.call(null, doc.doc);

    var keyValues = {};

    Object.keys(indexableKeysToKeyValues).forEach(function (indexableKey) {
      var keyValue = indexableKeysToKeyValues[indexableKey];
      if (reduceFun) {
        keyValue.reduceOutput = reduceFun.call(null, [keyValue.key], [keyValue.value], false);
      }
      keyValues[indexableKey] = keyValue;
    });

    index.dbIndex.put(docId, keyValues, function (err) {
      if (err) {
        return cb(err);
      }
      cb(null);
    });
  }

  function removeMappings(docId, cb) {
    index.dbIndex.put(docId, {}, function (err) {
      if (err) {
        return cb(err);
      }
      cb(null);
    });
  }

  var lastSeq = index.seq;
  var gotError;
  var reportedError;
  var complete;
  var numStarted = 0;
  var numFinished = 0;
  var checkComplete = function () {
    if (gotError) {
      if (!reportedError) {
        reportedError = true;
        cb(gotError);
      }
    } else if (complete && numStarted === numFinished) {
      updateIndexSeq(index, lastSeq, function (err) {
        if (err) {
          return cb(err);
        }
        cb(null);
      });
    }
  };

  index.db.changes({
    conflicts: true,
    include_docs: true,
    since : index.seq,
    onChange: function (doc) {
      if (gotError) {
        return;
      }
      if (doc.id[0] === '_') {
        return;
      }
      numStarted++;
      var myCB = function (err) {
        if (err) {
          gotError = err;
        } else {
          lastSeq = Math.max(lastSeq, doc.seq);
          numFinished++;
          checkComplete();
        }
      };
      if ('deleted' in doc) {
        removeMappings(doc.id, myCB);
      } else {
        callMapFun(doc, myCB);
      }
    },
    complete: function () {
      complete = true;
      checkComplete();
    }
  });
}

function reduceIndex(index, results, options) {
  // TODO: we already have the reduced output persisted in the database,
  // so we only need to rereduce

  var reduceFun;
  if (builtInReduce[index.reduceFun]) {
    reduceFun = builtInReduce[index.reduceFun];
  } else {
    reduceFun = evalFunc(index.reduceFun.toString(), null, sum, log, Array.isArray, JSON.parse);
  }

  var groups = [];
  var error;
  results.forEach(function (e) {
    var last = groups[groups.length - 1];
    if (last && collate(last.key[0][0], e.key) === 0) {
      last.key.push([e.key, e.id]);
      last.value.push(e.value);
      return;
    }
    groups.push({key: [
      [e.key, e.id]
    ], value: [e.value]});
  });
  groups.forEach(function (e) {
    e.value = reduceFun.call(null, e.key, e.value);
    if (e.value.sumsqr && e.value.sumsqr instanceof Error) {
      error = e.value;
      return;
    }
    e.key = e.key[0][0];
  });
  if (error) {
    options.complete(error);
    return;
  }
  var skip = options.skip || 0;
  options.complete(null, {
    total_rows: results.length,
    offset: skip,
    rows: ('limit' in options) ? groups.slice(skip, options.limit + skip) :
      (skip > 0) ? groups.slice(skip) : groups
  });
}

function queryIndex(index, opts) {

  index.dbIndex.count(function (err, totalRows) {
    if (err) {
      return opts.complete(err);
    }

    var shouldReduce = index.reduceFun && opts.reduce !== false;

    var skip = opts.skip || 0;

    function fetchFromIndex(indexOpts, cb) {
      index.dbIndex.get(indexOpts, function (err, results) {
        results = results.map(function (result) {
          return result.value;
        });
        if (err) {
          return cb(err);
        }
        cb(null, results);
      });
    }

    function onMapResultsReady(results) {
      if (shouldReduce) {
        return reduceIndex(index, results, opts);
      } else if (opts.include_docs && results.length) {
        // fetch and attach documents
        var numDocsFetched = 0;
        var checkComplete = function () {
          if (++numDocsFetched === results.length) {
            opts.complete(null, {
              total_rows : totalRows,
              offset : skip,
              rows : results
            });
          }
        };
        results.forEach(function (viewRow) {
          var val = viewRow.value;
          if (val && typeof val === 'object' && val._id) {
            //in this special case, join on _id (issue #106)
            index.db.get(val._id, function (_, joined_doc) {
              if (joined_doc) {
                viewRow.doc = joined_doc;
              }
              checkComplete();
            });
          } else {
            // TODO: store the rev and only fetch that particular revision?
            index.db.get(viewRow.id, function (_, doc) {
              if (doc) {
                viewRow.doc = doc;
              }
              checkComplete();
            });
          }
        });
      } else { // don't need the docs
        opts.complete(null, {
          total_rows : totalRows,
          offset : skip,
          rows : results
        });
      }
    }

    if ('keys' in opts) {
      if (!opts.keys.length) {
        return opts.complete(null, {
          total_rows : totalRows,
          offset : skip,
          rows : []
        });
      }
      var keysLookup = createKeysLookup(opts.keys);
      var trueNumKeys = Object.keys(keysLookup).length;
      var results = new Array(opts.keys.length);
      var numKeysFetched = 0;
      var keysError;
      Object.keys(keysLookup).forEach(function (key) {
        var keysLookupIndices = keysLookup[key];
        var trueKey = JSON.parse(key);
        var indexOpts = {};
        indexOpts.startkey = toIndexableString([INDEX_TYPE_KEYVALUE, trueKey]);
        indexOpts.endkey = toIndexableString([INDEX_TYPE_KEYVALUE, trueKey, {}]);
        fetchFromIndex(indexOpts, function (err, subResults) {
          if (err) {
            keysError = true;
            return opts.complete(err);
          } else if (keysError) {
            return;
          } else if (typeof keysLookupIndices === 'number') {
            results[keysLookupIndices] = subResults;
          } else { // array of indices
            keysLookupIndices.forEach(function (i) {
              results[i] = subResults;
            });
          }
          if (++numKeysFetched === trueNumKeys) {
            // combine results
            var combinedResults = [];
            results.forEach(function (result) {
              combinedResults = combinedResults.concat(result);
            });

            if (!shouldReduce) {
              // since we couldn't skip/limit before, do so now
              combinedResults = ('limit' in opts) ?
                combinedResults.slice(skip, opts.limit + skip) :
                (skip > 0) ? combinedResults.slice(skip) : combinedResults;
            }
            onMapResultsReady(combinedResults);
          }
        });
      });
    } else { // normal query, no 'keys'

      var indexOpts = {};

      // don't include the seq, which we stored alongside these
      var absoluteStart = toIndexableString([INDEX_TYPE_KEYVALUE]);
      var absoluteEnd = toIndexableString([INDEX_TYPE_OUT_OF_BOUNDS]);

      if ('descending' in opts) {
        indexOpts.descending = opts.descending;
      }
      if ('startkey' in opts) {
        indexOpts.startkey = opts.descending ?
          toIndexableString([INDEX_TYPE_KEYVALUE, opts.startkey, {}]) :
          toIndexableString([INDEX_TYPE_KEYVALUE, opts.startkey]);
      } else {
        indexOpts.startkey = opts.descending ? absoluteEnd : absoluteStart;
      }
      if ('endkey' in opts) {
        indexOpts.endkey = opts.descending ?
          toIndexableString([INDEX_TYPE_KEYVALUE, opts.endkey]) :
          toIndexableString([INDEX_TYPE_KEYVALUE, opts.endkey, {}]);
      } else {
        indexOpts.endkey = opts.descending ? absoluteStart : absoluteEnd;
      }
      if ('key' in opts) {
        indexOpts.startkey = toIndexableString([INDEX_TYPE_KEYVALUE, opts.key]);
        indexOpts.endkey = toIndexableString([INDEX_TYPE_KEYVALUE, opts.key, {}]);
      }

      if (!shouldReduce) {
        if ('limit' in opts) {
          indexOpts.limit = opts.limit;
        }
        indexOpts.skip = skip;
      }

      fetchFromIndex(indexOpts, function (err, results) {
        if (err) {
          return opts.complete(err);
        }
        onMapResultsReady(results);
      });
    }
  });
}

exports.query = function (fun, opts, callback) {
  var db = this;
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  opts = opts || {};
  if (callback) {
    opts.complete = callback;
  }
  var tempCB = opts.complete;
  var realCB;
  if (opts.complete) {
    realCB = function (err, resp) {
      process.nextTick(function () {
        tempCB(err, resp);
      });
    };
  } 
  var promise = new Promise(function (resolve, reject) {
    opts.complete = function (err, data) {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    };

    if (db.type() === 'http') {
      if (typeof fun === 'function') {
        return httpQuery(db, {map: fun}, opts);
      }
      return httpQuery(db, fun, opts);
    }

    if (typeof fun === 'object') {
      return viewQuery(db, fun, opts);
    }

    if (typeof fun === 'function') {
      return viewQuery(db, {map: fun}, opts);
    }

    var parts = fun.split('/');
    var designDocName = parts[0];
    var viewName = parts[1];
    db.get('_design/' + designDocName, function (err, doc) {
      if (err) {
        opts.complete(err);
        return;
      }

      if (!doc.views[viewName]) {
        opts.complete({ name: 'not_found', message: 'missing_named_view' });
        return;
      }

      var mapFun = doc.views[viewName].map;
      var reduceFun = doc.views[viewName].reduce;

      getIndex(db, mapFun, reduceFun, function (err, index) {
        if (err) {
          return opts.complete(err);
        } else if (opts.stale === 'ok' || opts.stale === 'update_after') {
          if (opts.stale === 'update_after') {
            updateIndex(index, function (err) {
              console.log(err);
            });
          }
          return queryIndex(index, opts);
        } else { // stale not ok
          return updateIndex(index, function (err) {
            if (err) {
              return opts.complete(err);
            }
            queryIndex(index, opts);
          });
        }
      });
    });
  });
  if (realCB) {
    promise.then(function (resp) {
      realCB(null, resp);
    }, realCB);
  }
  return promise;
};

function Index(db, mapFun, reduceFun) {
  this.db = db;
  this.dbIndex = db.index('mrview-' + hexHashCode(
    mapFun.toString() + (reduceFun && reduceFun.toString())));
  this.mapFun = mapFun;
  this.reduceFun = reduceFun;
}