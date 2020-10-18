# Discover module

The discover npm module is a collection of utilities for discovering and registering services.

When a service is first launched, it can use the discover module to register itself to the service registry. As it runs, it can use the discover module to find instances of services that meet specified criteria, enabling it to call a service using a symbolic name rather than its host and port. This level of indirection can be very helpful in a dynamic system where services are created and modified and restarted frequently.

## Invoking the discover module

A node.js service can require the discover module as follows:

```json
const dc = require('@bishopcais/discover');
```

### Registration

If the node.js service wishes to register itself, it can invoke

```json
dc().init({"port": "port at which service is running"});
```

The registration information needed to allow discovery by other services must be provided under the `register` key in the `package.json` file. Here is an example:

```js
{
  "name": "<service-name>",
  // oter information...,
  "register": {
    "instanceName": "m2a2-orchestrator",
    "serviceType": "m2a2-orchestrator",
    "testRoute": "/test",
    "testInterval": 20,
    "launchInvocation": "nohup node m2a2-orchestrator.js -port 55535 -level 2 > orch001.log &",
    "lcManagerRegister": {
      "host": "disembodied-ai.sl.cloud9.ibm.com",
      "port": 1111
    },
    "lcManagerDiscover": {
      "host": "disembodied-ai.sl.cloud9.ibm.com",
      "port": 1111
    }
  }
}
```

In the example above, 

* `instanceName` is the name of the instance of the service that will be registered. This is typically not used.
* `serviceType` is the symbolic name that other services should use to refer to this service.
* `testRoute` is the name of a test route that the service registry can ping periodically to tell whether the service is responsive. By default, this route is called `test`, but it can be overridden by the user if desired.
* `testInterval` is the frequency (in seconds) with which the service should be tested for responsiveness.
* `launchInvocation` is a string that could be executed on the command line to invoke the service; it tends not to be used much.
* `lcManagerRegister` is an object that specifies the host and port of the service registry to which the service should register.
* `lcManagerDiscover` is an object that specifies the host and port of the service registry that this service wants to use to find other services.

### Installing the discover routes and functions

For services that use express, a common useful pattern is: 

```js
const app = express();
// other code
const server = http.createServer(app);
server.listen(app.get('port'), () => {
  logExpression('Express server listening on port ' + app.get('port'), 1);
  dc().init({
    port: myPort,
  });
  dc().installExpressRoutes(app);
});
```

where `myPort` is the port at which the service is running, and `dc().installExpressRoutes(app)` installs some routes that support pinging the service (which the service registry uses to check whether it is alive) and registration and de-registration.

When dc(init) runs, it installs several service discovery functions and makes them available to the service by exporting them. The next section describes these functions in detail.

## Service discovery functions

All service discovery functions are provided as callbacks, with the callback function denoted as `cb`. In all cases, the callback is of the form

`cb(err, resultJSON)`

where

* `err` is an error object if the function call fails, and
* `resultJSON` is a JSON structure returned by calling the specified host, port and path if the function call succeeds.

If you want the services to return promises instead of callbacks, then you can simply use promisify in the body of the service that is using the discover module, e.g. 

```
const getDataFromServiceTypePromise = promisify(dc().getDataFromServiceType);
```

An example of promisification can be found in the file `service-functions.js` of `m2a2-orchestrator`.


### getURL(options, cb)

Options is an object of the following form:

```js
{
  "host": "<host>",
  "port": 1234,
  "path": "<path>"
}
```

where `host`, `port`, and `path` together constitute a known specific address.

`resultJSON` is the JSON that would be returned by calling a `GET` of the host, port and path provided in the `options` object.


### findAgent(serviceType, cb)

`serviceType` is a string that provides the symbolic name of the service to be called.

`resultJSON` is an options object (in the format described under `getURL` above) that contains the host and port that is registered under the symbolic name specified by `serviceType`.

### getDataFromServiceType(serviceType, path, cb)

`serviceType` is a string that provides the symbolic name of the service to be called.

`path` is the path, which will be added to the host and port information once the service registry determines these from the serviceType.

`resultJSON` is the JSON that would be returned by calling a `GET` of the host, port and path derived from the input parameters.


### postDataToService(json, options, cb)

`json` is an object `POST`ed to the service specified in the `options` object.

`resultJSON` is the JSON that would be returned by `POST`ing to the host, port and path specified in `options`.


### postDataToServiceType(json, serviceType, path, cb)

`json` is an object `POST`ed to the service specified by the serviceType and path.

`resultJSON` is the JSON that would be returned by `POST`ing to the host, port and path derived from the input parameters `serviceType` and `path`.


### putDataToService(json, options, cb)

This function is exactly like `postDataToService`, except that it is designed for `PUT` operations rather than `POST`.

### putDataToServiceType(json, serviceType, path, cb)

This function is exactly like `postDataToServiceType`, except that it is designed for `PUT` operations rather than `POST`.


### deleteDataFromService(json, options, cb)

This function is exactly like `postDataToService`, except that it is designed for `DELETE` operations rather than `POST`.

### deleteDataFromServiceType(json, serviceType, path, cb)

This function is exactly like `postDataToServiceType`, except that it is designed for `DELETE` operations rather than `POST`.



