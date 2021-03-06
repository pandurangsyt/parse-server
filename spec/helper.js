"use strict"
// Sets up a Parse API server for testing.

jasmine.DEFAULT_TIMEOUT_INTERVAL = process.env.PARSE_SERVER_TEST_TIMEOUT || 5000;

global.on_db = (db, callback, elseCallback) => {
  if (process.env.PARSE_SERVER_TEST_DB == db) {
    return callback();
  } else if (!process.env.PARSE_SERVER_TEST_DB && db == 'mongo') {
    return callback();
  }
  if (elseCallback) {
    elseCallback();
  }
}

var cache = require('../src/cache').default;
var express = require('express');
var facebook = require('../src/authDataManager/facebook');
var ParseServer = require('../src/index').ParseServer;
var path = require('path');
var TestUtils = require('../src/TestUtils');
var MongoStorageAdapter = require('../src/Adapters/Storage/Mongo/MongoStorageAdapter');
const GridStoreAdapter = require('../src/Adapters/Files/GridStoreAdapter').GridStoreAdapter;
const FSAdapter = require('parse-server-fs-adapter');
const PostgresStorageAdapter = require('../src/Adapters/Storage/Postgres/PostgresStorageAdapter');

const mongoURI = 'mongodb://localhost:27017/parseServerMongoAdapterTestDatabase';
const postgresURI = 'postgres://localhost:5432/parse_server_postgres_adapter_test_database';
let databaseAdapter;
// need to bind for mocking mocha

let startDB = () => {};
let stopDB = () => {};

if (process.env.PARSE_SERVER_TEST_DB === 'postgres') {
  databaseAdapter = new PostgresStorageAdapter({
    uri: postgresURI,
    collectionPrefix: 'test_',
  });
} else {
  startDB = require('mongodb-runner/mocha/before').bind({
    timeout: () => {},
    slow: () => {}
  });
  stopDB = require('mongodb-runner/mocha/after');;
  databaseAdapter = new MongoStorageAdapter({
    uri: mongoURI,
    collectionPrefix: 'test_',
  });
}

var port = 8378;

let filesAdapter;

on_db('mongo', () => {
  filesAdapter = new GridStoreAdapter(mongoURI);
}, () => {
  filesAdapter = new FSAdapter();
});

let logLevel;
let silent = true;
if (process.env.VERBOSE) {
  silent = false;
  logLevel = 'verbose';
}
if (process.env.PARSE_SERVER_LOG_LEVEL) {
  silent = false;
  logLevel = process.env.PARSE_SERVER_LOG_LEVEL;
}
// Default server configuration for tests.
var defaultConfiguration = {
  filesAdapter,
  serverURL: 'http://localhost:' + port + '/1',
  databaseAdapter,
  appId: 'test',
  javascriptKey: 'test',
  dotNetKey: 'windows',
  clientKey: 'client',
  restAPIKey: 'rest',
  webhookKey: 'hook',
  masterKey: 'test',
  fileKey: 'test',
  silent,
  logLevel,
  push: {
    'ios': {
      cert: 'prodCert.pem',
      key: 'prodKey.pem',
      production: true,
      bundleId: 'bundleId',
    }
  },
  oauth: { // Override the facebook provider
    facebook: mockFacebook(),
    myoauth: {
      module: path.resolve(__dirname, "myoauth") // relative path as it's run from src
    }
  }
};

let openConnections = {};

// Set up a default API server for testing with default configuration.
var app = express();
var api = new ParseServer(defaultConfiguration);
app.use('/1', api);
var server = app.listen(port);
server.on('connection', connection => {
  let key = `${connection.remoteAddress}:${connection.remotePort}`;
  openConnections[key] = connection;
  connection.on('close', () => { delete openConnections[key] });
});
// Allows testing specific configurations of Parse Server
const reconfigureServer = changedConfiguration => {
  return new Promise((resolve, reject) => {
    server.close(() => {
      try {
        let newConfiguration = Object.assign({}, defaultConfiguration, changedConfiguration, {
          __indexBuildCompletionCallbackForTests: indexBuildPromise => indexBuildPromise.then(resolve, reject)
        });
        cache.clear();
        app = express();
        api = new ParseServer(newConfiguration);
        api.use(require('./testing-routes').router);
        app.use('/1', api);

        server = app.listen(port);
        server.on('connection', connection => {
          let key = `${connection.remoteAddress}:${connection.remotePort}`;
          openConnections[key] = connection;
          connection.on('close', () => { delete openConnections[key] });
        });
      } catch(error) {
        reject(error);
      }
    });
  });
}

// Set up a Parse client to talk to our test API server
var Parse = require('parse/node');
Parse.serverURL = 'http://localhost:' + port + '/1';

// This is needed because we ported a bunch of tests from the non-A+ way.
// TODO: update tests to work in an A+ way
Parse.Promise.disableAPlusCompliant();

// 10 minutes timeout
beforeAll(startDB, 10*60*1000);

afterAll(stopDB);

beforeEach(done => {
  try {
    Parse.User.enableUnsafeCurrentUser();
  } catch (error) {
    if (error !== 'You need to call Parse.initialize before using Parse.') {
      throw error;
    }
  }
  TestUtils.destroyAllDataPermanently()
  .catch(error => {
    // For tests that connect to their own mongo, there won't be any data to delete.
    if (error.message === 'ns not found' || error.message.startsWith('connect ECONNREFUSED')) {
      return;
    } else {
      fail(error);
      return;
    }
  })
  .then(reconfigureServer)
  .then(() => {
    Parse.initialize('test', 'test', 'test');
    Parse.serverURL = 'http://localhost:' + port + '/1';
    done();
  }, error => {
    Parse.initialize('test', 'test', 'test');
    Parse.serverURL = 'http://localhost:' + port + '/1';
    // fail(JSON.stringify(error));
    done();
  })
});

afterEach(function(done) {
  let afterLogOut = () => {
    if (Object.keys(openConnections).length > 0) {
      fail('There were open connections to the server left after the test finished');
    }
    on_db('postgres', () => {
      TestUtils.destroyAllDataPermanently().then(done, done);
    }, done);
  };
  Parse.Cloud._removeAllHooks();
  databaseAdapter.getAllClasses()
  .then(allSchemas => {
    allSchemas.forEach((schema) => {
      var className = schema.className;
      expect(className).toEqual({ asymmetricMatch: className => {
        if (!className.startsWith('_')) {
          return true;
        } else {
          // Other system classes will break Parse.com, so make sure that we don't save anything to _SCHEMA that will
          // break it.
          return ['_User', '_Installation', '_Role', '_Session', '_Product'].includes(className);
        }
      }});
    });
  })
  .then(() => Parse.User.logOut())
  .then(afterLogOut, afterLogOut)
});

var TestObject = Parse.Object.extend({
  className: "TestObject"
});
var Item = Parse.Object.extend({
  className: "Item"
});
var Container = Parse.Object.extend({
  className: "Container"
});

// Convenience method to create a new TestObject with a callback
function create(options, callback) {
  var t = new TestObject(options);
  t.save(null, { success: callback });
}

function createTestUser(success, error) {
  var user = new Parse.User();
  user.set('username', 'test');
  user.set('password', 'moon-y');
  var promise = user.signUp();
  if (success || error) {
    promise.then(function(user) {
      if (success) {
        success(user);
      }
    }, function(err) {
      if (error) {
        error(err);
      }
    });
  } else {
    return promise;
  }
}

// Shims for compatibility with the old qunit tests.
function ok(bool, message) {
  expect(bool).toBeTruthy(message);
}
function equal(a, b, message) {
  expect(a).toEqual(b, message);
}
function strictEqual(a, b, message) {
  expect(a).toBe(b, message);
}
function notEqual(a, b, message) {
  expect(a).not.toEqual(b, message);
}
function expectSuccess(params, done) {
  return {
    success: params.success,
    error: function(e) {
      fail('failure happened in expectSuccess');
      done ? done() : null;
    },
  }
}
function expectError(errorCode, callback) {
  return {
    success: function(result) {
      console.log('got result', result);
      fail('expected error but got success');
    },
    error: function(obj, e) {
      // Some methods provide 2 parameters.
      e = e || obj;
      if (!e) {
        fail('expected a specific error but got a blank error');
        return;
      }
      expect(e.code).toEqual(errorCode, e.message);
      if (callback) {
        callback(e);
      }
    },
  }
}

// Because node doesn't have Parse._.contains
function arrayContains(arr, item) {
  return -1 != arr.indexOf(item);
}

// Normalizes a JSON object.
function normalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (obj instanceof Array) {
    return '[' + obj.map(normalize).join(', ') + ']';
  }
  var answer = '{';
  for (var key of Object.keys(obj).sort()) {
    answer += key + ': ';
    answer += normalize(obj[key]);
    answer += ', ';
  }
  answer += '}';
  return answer;
}

// Asserts two json structures are equal.
function jequal(o1, o2) {
  expect(normalize(o1)).toEqual(normalize(o2));
}

function range(n) {
  var answer = [];
  for (var i = 0; i < n; i++) {
    answer.push(i);
  }
  return answer;
}

function mockFacebookAuthenticator(id, token) {
  var facebook = {};
  facebook.validateAuthData = function(authData) {
    if (authData.id === id && authData.access_token.startsWith(token)) {
      return Promise.resolve();
    } else {
      throw undefined;
    }
  };
  facebook.validateAppId = function(appId, authData) {
    if (authData.access_token.startsWith(token)) {
      return Promise.resolve();
    } else {
      throw undefined;
    }
  };
  return facebook;
}

function mockFacebook() {
  return mockFacebookAuthenticator('8675309', 'jenny');
}



// This is polluting, but, it makes it way easier to directly port old tests.
global.Parse = Parse;
global.TestObject = TestObject;
global.Item = Item;
global.Container = Container;
global.create = create;
global.createTestUser = createTestUser;
global.ok = ok;
global.equal = equal;
global.strictEqual = strictEqual;
global.notEqual = notEqual;
global.expectSuccess = expectSuccess;
global.expectError = expectError;
global.arrayContains = arrayContains;
global.jequal = jequal;
global.range = range;
global.reconfigureServer = reconfigureServer;
global.defaultConfiguration = defaultConfiguration;
global.mockFacebookAuthenticator = mockFacebookAuthenticator;
global.jfail = function(err) {
  fail(JSON.stringify(err));
}

global.it_exclude_dbs = excluded => {
  if (excluded.includes(process.env.PARSE_SERVER_TEST_DB)) {
    return xit;
  } else {
    return it;
  }
}

global.fit_exclude_dbs = excluded => {
  if (excluded.includes(process.env.PARSE_SERVER_TEST_DB)) {
    return xit;
  } else {
    return fit;
  }
}

global.describe_only_db = db => {
  if (process.env.PARSE_SERVER_TEST_DB == db) {
    return describe;
  } else if (!process.env.PARSE_SERVER_TEST_DB && db == 'mongo') {
    return describe;
  } else {
    return () => {};
  }
}


var libraryCache = {};
jasmine.mockLibrary = function(library, name, mock) {
  var original = require(library)[name];
  if (!libraryCache[library]) {
    libraryCache[library] = {};
  }
  require(library)[name] = mock;
  libraryCache[library][name] = original;
}

jasmine.restoreLibrary = function(library, name) {
  if (!libraryCache[library] || !libraryCache[library][name]) {
    throw 'Can not find library ' + library + ' ' + name;
  }
  require(library)[name] = libraryCache[library][name];
}
