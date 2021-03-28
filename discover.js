'use strict';

const request = require('request');
const os = require('os');
const _ = require('lodash');
const url = require('url');
const { exec } = require('child_process');

let LCManagerDiscover;
let LCManagerRegister;

const useCache = 0;
const serviceCache = [];

const GLBL = {
  hostname: null,
};

const debug = true;
function dbg (str, obj) {
  if (!debug) {
    return;
  }
  if (str) {
    console.log(str);
  }
  if (obj) {
    console.log(JSON.stringify(obj, null, 2));
  }
}

function getHostName (cb) {
  if (GLBL.hostname) {
    cb(GLBL.hostname);
    return;
  }
  exec('hostname -f', (err, stdout) => {
    let hname1 = '';
    if (!err) {
      hname1 = stdout.trim();
    }
    let hname = hname1;
    exec('hostname -A', (err2, stdout2) => {
      let hname2 = '';
      if (!err2) {
        hname2 = stdout2.trim().split(' ')[0];
      }
      if (hname2.length > hname.length) {
        hname = hname2;
      }
      GLBL.hostname = hname;
      console.log('hostname is ', GLBL.hostname);
      if (cb) {
        cb(GLBL.hostname);
      }
    });
  });
}

//This function receives JSON returned from a GET issued to the host, port and path defined in options
function options2URL(options) {
  let url =  `http://${options.host}`;
  if (options.port) {
    url += `:${options.port}`;
  }
  if (options.path) {
    url  += options.path;
  }
  return url;
}

function restQuickGet(url, cb) {
  //response is the whole response, body is the core part
  request.get(url, (err, httpResponse, body) => {
    if (!cb) {
      return;
    }
    if (err) {
      return cb(err);
    }

    let doc;
    try {
      doc = JSON.parse(body);
    }
    catch (e) {
      return cb(null, httpResponse, {msg: body});
    }

    if (doc && doc.kitVersion) {
      if (doc.status.toLowerCase() === 'failed') {
        return cb(new Error(doc.explanation));
      }
      return cb(null, doc, JSON.stringify(doc.result));
    }

    cb(null, httpResponse, body);
  });
}

function restQuickPost(url, data, cb) {
  request.post(url, data, (err, resp) => {
    if (!cb) {
      return;
    }
    if (err) {
      return cb(err);
    }

    if (resp && resp.kitVersion) {
      if (resp.status.toLowerCase() === 'failed') {
        return cb(new Error(resp.explanation));
      }
      resp.isRQ = true;
    }

    cb(null, resp);
  });
}

function getURL(options, onResult) {
  const url = options2URL(options);

  restQuickGet(url, (err, response, body) => {
    if (!err) {
      //400 or 500 error occurred, so this really should be treated as error
      if (response.statusCode >=400 && response.statusCode <=599) {
        if (response.body) {
          if (onResult) {
            onResult(response.body, null, response);
          }
        }
        else {
          if (onResult) {
            onResult({msg: `Status code ${response.statusCode}`}, null, response);
          }
        }
      }
      // Looks like we generated a non-erroneous response
      else {
        try {
          const bodyJSON = JSON.parse(body);
          if (onResult) {
            onResult(null, bodyJSON, response);
          }
        }
        catch (e) {
          let bodyJSON = null;
          if (body) {
            bodyJSON = {'nonJSONResponse': body};
          }
          if (onResult) {
            onResult({err: e}, bodyJSON, response);
          }
        }
      }
    }
    else {
      if (onResult) {
        onResult(err, null, response);
      }
    }
  });
}

function loadJSONSync(filename) {
  const fs = require('fs');
  try {
    let wdir = process.env.PWD;
    if (!wdir) {
      wdir = process.cwd();
    }
    console.log(`working dir: ${wdir}`);
    const data = fs.readFileSync(`${wdir}/${filename}`);
    dbg(`File ${filename} found.`);
    const json = JSON.parse(data);
    //console.log (json);
    return json;
  }
  catch (e) {
    if (e.code === 'ENOENT') {
      dbg(`File ${filename} not found.`);
    }
    else {
      throw e;
    }
    return null;
  }
}

// ------ FINDING an agent -----------

//This function calls the lifecycle manager to determine the host and port of an agent of a given service type.
function findAgent(serviceType, callback) {
  if (useCache) {
    if (serviceCache[serviceType]) {
      if (callback) {
        callback(null, serviceCache[serviceType]);
      }
      return;
    }
  }
  const options = LCManagerDiscover;
  options.path = `/query/?serviceType=${serviceType}&status=responsive`;
  getURL(options, (err, docs) => {
    if (!err && docs) {
      if (docs.length === 0) {
        const err2 = new Error(`ERROR: could not find agent matching criteria (serviceType = ${serviceType}).\n`);
        if (callback) {
          callback(err2, null);
        }
      }
      else {
        // Just pick the first matching agent for now -- should be more sophisticated later
        const doc = docs[0];
        const options2 = {
          'host': doc.host,
          'port': doc.port,
          'path': '',
        };
        if (callback) {
          callback(null, options2);
        }
        if (useCache) {
          serviceCache[serviceType] = options2;
        }
      }
    }
    else {
      const err2 = new Error('ERROR: Invalid response from lifecycle manager.');
      if (callback) {
        callback(err2, null);
      }
    }
  });
}

// --- checking required agents --

function checkRequiredAgents(requiredAgents, callback) {
  if (!requiredAgents || requiredAgents.length === 0) {
    callback(null, [], []);
    return;
  }
  const missingAgents = [];
  const foundAgents = [];
  requiredAgents.forEach((requiredAgent) => {
    findAgent(requiredAgent, (err) => {
      if (err) {
        missingAgents.push(requiredAgent);
      }
      else {
        foundAgents.push(requiredAgent);
      }
      if (missingAgents.length+foundAgents.length == requiredAgents.length) {
        callback(null, missingAgents, foundAgents);
      }
    });
  });
}


// ------ Registering myself -----------

//fname = 'package.json' or 'appSettings.json'
//obj_path = 'register' or 'null'
//fields = undefined or null or [] or ['a', 'b', ...]

function getFileDataFields (fname, objPath, fields) {
  let data = loadJSONSync(fname);
  //file does not exist
  if (!data) {
    return;
  }

  if (objPath) {
    data = data[objPath];
    // file exists but obj_path does not exist
    if (!data) {
      return {};
    }
  }

  // no fields to be picked
  if (!fields || fields.length === 0) {
    return data;
  }

  const res = _.pick(data, fields);
  return res;
}

function getStaticData () {
  let data = getFileDataFields('appSettings.json', 'register');
  if (data === undefined || _.isEmpty(data)) {
    data = getFileDataFields('package.json', 'register');
    if (data) {
      console.log('Getting registration information from package.json.');
    }
  }

  if (!data) {
    console.log('Need valid register data in either package.json or appSettings.json.');
    process.exit(1);
  }
  //Support .env file
  const envLoaded = require('dotenv').load({silent: true});

  if (!envLoaded) {
    console.log('warning:', __filename, '.env cannot be found');
  }
  else {
    if (process.env.lcManagerHost) {
      data.lcManager.host = process.env.lcManagerHost;
    }
    if (process.env.lcManagerDiscoverHost) {
      data.lcManagerDiscover.host = process.env.lcManagerDiscoverHost;
    }
    if (process.env.lcManagerRegisterHost) {
      data.lcManagerRegister.host = process.env.lcManagerRegisterHost;
    }
  }

  return data;
}


//obtain static data from package.json or appSettings.json
//merge with all runtimeData
function getRegisterData (runtimeData) {
  const staticData = getStaticData();

  if (!staticData.lcManagerDiscover) {
    if (staticData.lcManager) {
      _.extend(staticData, {
        lcManagerDiscover: staticData.lcManager,
      });
    }
    else {
      _.extend(staticData, {
        lcManagerDiscover: LCManagerDiscover,
      });
    }
  }

  if (!staticData.lcManagerRegister) {
    if (staticData.lcManager) {
      _.extend(staticData, {
        lcManagerRegister: staticData.lcManager,
      });
    }
    else {
      _.extend(staticData, {
        lcManagerRegister: LCManagerRegister,
      });
    }
  }

  const allData = {};
  _.extend(allData, staticData);
  _.extend(allData, runtimeData);

  let host;

  if (GLBL.hostname) {
    host = GLBL.hostname;
  }
  else {
    host = os.hostname();
  }

  _.extend(allData, {
    host: host,
    launchPath: process.env.DOCKER_PWD || process.env.PWD || process.cwd(),
    dockerized: process.env.DOCKER_PWD? true: false,
    pid: process.pid,
  });

  //merge fileData and auxData

  LCManagerDiscover = allData.lcManagerDiscover;
  LCManagerRegister = allData.lcManagerRegister;

  if (!LCManagerDiscover || !LCManagerRegister) {
    console.error('did not set lifecycle discover and/or register');
    process.exit(1);
  }
  console.log(`allData is now: ${JSON.stringify(allData, null, 2)}`);
  return allData;

}

function registerAction (registerString, runtimeData, cb) {
  const registerData = getRegisterData(runtimeData);
  dbg('registerData = ', registerData);
  dbg('registerString = ', registerString);

  //construct LM url

  //   LCManagerRegister = registerData.lcManagerRegister;
  const options = registerData.lcManagerRegister;
  options.path = `/${registerString}`;
  const url = options2URL(options);

  //post to url
  restQuickPost(url, {
    json: true,
    body: registerData,
  }, (err, result) => {
    dbg('post result = ', result);
    if (!err) {
      dbg(`success: post register_action : ${registerString}`);
      if (cb) {
        cb();
      }
    }
    else {
      dbg(`Error: post register_action: ${err.message}`);
      if (cb) {
        cb();
      }
    }
  });
}

// cache of runtime data passed in when registering
let _runtimeData;

function register (runtimeData, cb) {
  _runtimeData = runtimeData;
  registerAction('register', _runtimeData, cb);
}

function unregister (runtimeData, cb) {
  runtimeData = runtimeData || _runtimeData;
  registerAction('unregister', runtimeData, cb);
}

function notifyStopping (cb) {
  dbg('** now stopping ***');
  registerAction('stopping', _runtimeData, cb);
}

// ------------- POSTING Data to an agent -----------------

// post data to an agent with a known URL

function postDataToService(data, options, callback) {
  const url = options2URL(options);

  //    console.log('postDataToService: Posting to URL ' + url)
  restQuickPost(url, {json: true, body: data}, (err, response) => {
    if (!err) {
      if (response.statusCode < 400 || response.statusCode > 599) {
        let body = null;
        // compatible with node-request
        if (response && response.body) {
          body = response.body;
        }
        // compatible with rest-quick
        if (response && response.isRQ && response.result) {
          body = response.result;
        }
        // doc = actual data. response = full msg
        if (callback) {
          callback(null, body, response);
        }
      }
      else {
        if (callback) {
          callback(response.body, null, response);
        }
      }
    }
    else {
      if (callback) {
        callback(err, null, response);
      }
    }
  });
}

function deleteDataFromService(data, options, callback) {
  options.uri = options2URL(options);
  options.method = 'DELETE';
  options.json = true;
  options.body = data;

  request(
    options,
    (err, response, result) => {
      if (!err) {
        if (response.statusCode < 400 || response.statusCode > 599) {
          let body = null;
          // compatible with node-request
          if (result && result.body) {
            body = result.body;
          }
          // compatible with rest-quick
          if (result && result.isRQ && result.result) {
            body = result.result;
          }
          // body = actual data. result = full msg
          if (callback) {
            callback(null, body, result);
          }
        }
        else {
          if (callback) {
            callback(result.body, null, result);
          }
        }
      }
      else {
        if (callback) {
          callback(err, null, result);
        }
      }
    },
  );
}

function putDataToService(data, options, callback) {
  options.uri = options2URL(options);
  options.method = 'PUT';
  options.json = true;
  options.body = data;

  request(
    options,
    (err, response, result) => {
      if (!err) {
        if (response.statusCode < 400 || response.statusCode > 599) {
          let body = null;
          // compatible with node-request
          if (result && result.body) {
            body = result.body;
          }
          // compatible with rest-quick
          if (result && result.isRQ && result.result) {
            body = result.result;
          }
          // doc = actual data. result = full msg
          if (callback) {
            callback(null, body, result);
          }
        }
        else {
          if (callback) {
            callback(result.body, null, result);
          }
        }
      }
      else {
        if (callback) {
          callback(err, null, result);
        }
      }
    },
  );
}

//This function posts data to an agent of the given service type
function postDataToServiceType(data, serviceType, path, callback) {
  findAgent(serviceType, (err, options) => {
    if (!err) {
      options.path = path;
      options.method = 'POST';
      postDataToService(data, options, callback);
    }
    else {
      if (callback) {
        callback(err, null);
      }
    }
  });
}

function putDataToServiceType(data, serviceType, path, callback) {
  findAgent(serviceType, (err, options) => {
    if (!err) {
      options.path = path;
      options.method = 'PUT';
      putDataToService(data, options, callback);
    }
    else {
      if (callback) {
        callback(err, null);
      }
    }
  });
}

function deleteDataFromServiceType(data, serviceType, path, callback) {
  findAgent(serviceType, (err, options) => {
    if (!err) {
      options.path = path;
      options.method = 'DELETE';
      deleteDataFromService(data, options, callback);
    }
    else {
      if (callback) {
        callback(err, null);
      }
    }
  });
}

function getDataFromServiceType(serviceType, path, callback) {
  findAgent(serviceType, (err, options) => {
    if (!err) {
      options.path = path;
      options.method = 'GET';
      getURL(options, callback);
    }
    else {
      if (callback) {
        callback(err, null);
      }
    }
  });
}

function getRequiredAgents (runtimeData) {
  let requiredAgents = [];
  if (runtimeData && runtimeData.requiredAgents) {
    requiredAgents = runtimeData.requiredAgents;
  }
  else {
    let data = getFileDataFields('appSettings.json', 'register', ['requiredAgents']);
    if (!data || _.isEmpty(data)) {
      data = getFileDataFields('package.json', 'register', ['requiredAgents']);
    }
    requiredAgents = data.requiredAgents || [];
  }

  return requiredAgents;
}

// ------------- Initialization : check required agents, then register -----------------
function init (runtimeData) {
  getHostName(() => {
    runtimeData.hostname = GLBL.hostname || runtimeData.hostname;
    dbg('Initializing discovery ...');
    //    console.log("Inside init function with runtimeData = " + JSON.stringify(runtimeData,null,2));

    const requiredAgents = getRequiredAgents(runtimeData);
    dbg('reqAgents = ', requiredAgents);

    checkRequiredAgents(requiredAgents, (err, missingAgents) => {
      if (missingAgents.length > 0) {
        dbg("Can't init agent: missingAgents = ", missingAgents);
        process.exit(1);
      }

      register(runtimeData);
      //  LifecycleManagerURL = _runtimeData.lcManager; //JOK added so that we can override defaultLifecyleManager using
      //  commenting this out to avoid catching exception when app crashes
      //  installExitHandlers(); //notify lifecycle manager when the agent stops
    });
  });
}

function testRoute(req, res) {
  if (res) {
    const resp = {'response': 'AOK', 'error': null};
    res.json(resp);
  }
  return;
}

const defaultHardShutdownDuration = 4000;
const defaultSoftShutdownDuration = 2000;
function terminate(srvr, hardShutdownDuration, softShutdownDuration, cb) {
  hardShutdownDuration = hardShutdownDuration || defaultHardShutdownDuration;
  softShutdownDuration = softShutdownDuration || defaultSoftShutdownDuration;
  notifyStopping(() => {
    setTimeout(() => {
      srvr.close(() => {
        if (cb) {
          cb('Soft shutdown');
        }
      });
    }, softShutdownDuration);
    setTimeout(() => {
      if (cb) {
        cb('Forced shutdown');
      }
    }, hardShutdownDuration);
  });
}

/**
 *
 * @param {Express} app
 */
function installExpressRoutes (app) {
  if (!app) {
    return;
  }
  if (!app.get) {
    return;
  }

  app.get('/test', testRoute);

  app.get('/manualRegister', (req, res) => {
    const urlParts = url.parse(req.url, true);
    const query = urlParts.query;
    const registerParams = {port: _runtimeData.port};
    if (query.host && query.port) {
      _.extend(registerParams, {
        register: {
          lcManagerRegister: {
            'host': query.host,
            'port': query.port,
          },
        },
      });
    }
    register(registerParams);
    res.json('ok');
  });

  app.get('/manualUnregister', (req, res) => {
    const urlParts = url.parse(req.url, true);
    const query = urlParts.query;
    const registerParams = {port: _runtimeData.port};
    if (query.host && query.port) {
      _.extend(registerParams, {
        register: {
          lcManagerRegister: {
            'host': query.host,
            'port': query.port,
          },
        },
      });
    }
    unregister(registerParams);
    res.json('ok');
  });
}

function installExitHandlers() {
  dbg('*** installing exit handlers ***');
  process.on('beforeExit', notifyStopping);

  process.on('uncaughtException', (err) => {
    if (err !== undefined) {
      dbg('Threw exception:', err);
    }
    notifyStopping();
  });
}

function installTerminationRoutes(app, server) {
  dbg('*** installing termination routes ***');
  if (!app || !app.post) {
    return;
  }

  app.post('/terminate', (req, res) => {
    terminate(server, null, null, msg => {
      console.log(msg);
      res.json({msg: msg});
      process.exit(0);
    });
  });
}

function setLCManagerDiscover (coords) {
  LCManagerDiscover = coords;
  return;
}

function getLCManagerDiscover () {
  return LCManagerDiscover;
}

function setLCManagerRegister(coords) {
  LCManagerRegister = coords;
  return;
}

function getLCManagerRegister () {
  return LCManagerRegister;
}

const allModules = {
  getURL,
  // register does not check for required agents dependencies
  register,
  // if 'register' explicitly (not call 'init'), then must 'unregister' explicitly
  unregister,
  // check required agents are alive, install exit handlers, then register
  init,
  findAgent,
  getDataFromServiceType,
  postDataToService,
  postDataToServiceType,
  putDataToService,
  putDataToServiceType,
  deleteDataFromService,
  deleteDataFromServiceType,
  checkRequiredAgents,
  installExitHandlers,
  installExpressRoutes,
  installTerminationRoutes,
  testRoute,
  terminate,
  setLCManagerDiscover,
  setLCManagerRegister,
  getLCManagerDiscover,
  getLCManagerRegister,
};

function exportFn (runtimeData) {
  if (runtimeData) {
    init(runtimeData);
  }

  return allModules;
}

module.exports = exportFn;
