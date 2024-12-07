# `class` Fcgi

[Documentation Index](../README.md)

```ts
import {Fcgi} from "https://deno.land/x/fcgi@v2.0.8/mod.ts"
```

If the default instance of this class ([fcgi](../variable.fcgi/README.md)) is not enough, you can create another `Fcgi` instance with it's own connection pool and maybe with different configuration.

## This class has

- [constructor](#-constructor)
- 12 methods:
[listen](#-listenaddr_or_listener-fcgiaddr--listener-path_pattern-pathpattern-callback-callback-listener),
[unlisten](#-unlistenaddr-fcgiaddr-void),
[onError](#-onerrorcallback-error-error--unknown-promisevoid),
[onEnd](#-onendcallback---unknown-promisevoid),
[offError](#-offerrorcallback-error-error--unknown-void),
[offEnd](#-offendcallback---unknown-void),
[options](#-optionsoptions-serveroptions--clientoptions-serveroptions--clientoptions),
[fetch](#-fetchrequest_options-requestoptions-input-request--url--string-init-requestinit-promiseresponsewithcookies),
[fetchCapabilities](#-fetchcapabilitiesaddr-fcgiaddr--conn-promisefcgi_max_conns-number-fcgi_max_reqs-number-fcgi_mpxs_conns-number),
[canFetch](#-canfetch-boolean),
[waitCanFetch](#-waitcanfetch-promisevoid),
[closeIdle](#-closeidle-void)


#### 🔧 `constructor`()



#### ⚙ listen(addr\_or\_listener: [FcgiAddr](../type.FcgiAddr/README.md) | [Listener](../interface.Listener/README.md), path\_pattern: [PathPattern](../type.PathPattern/README.md), callback: [Callback](../type.Callback/README.md)): [Listener](../interface.Listener/README.md)

> Registers a FastCGI server on specified network address.
> 
> The address can be given as:
> 
> - a port number (`8000`),
> - a hostname with optional port (`localhost:8000`, `0.0.0.0:8000`, `[::1]:8000`, `::1`),
> - a unix-domain socket file name (`/run/deno-fcgi-server.sock`),
> - a `Deno.Addr` (`{transport: 'tcp', hostname: '127.0.0.1', port: 8000}`),
> - or a ready `Deno.Listener` object can also be given.
> 
> This function can be called multiple times with the same or different addresses.
> Calling with the same address adds another handler callback that will be tried to handle matching requests.
> Calling with different address creates another FastCGI server.
> 
> Second argument allows to filter arriving requests.
> It uses [x/path\_to\_regexp](https://deno.land/x/path_to_regexp) library, just like [x/oak](https://deno.land/x/oak) does.
> 
> Third argument is callback function with signature `(request: ServerRequest, params: any) => Promise<unknown>` that will be called for incoming requests that match filters.
> `params` contains regexp groups from the path filter.
> 
> "callback" can handle the request and call it's `req.respond()` method (not returning from the callback till this happens), or it can decide not to handle this request,
> and return without awaiting, so other handlers (registered with `listen()`) will take chance to handle this request. If none handled, 404 response will be returned.
> 
> Example:
> 
> ```ts
> fcgi.listen
> (	8989,
> 	'/page-1.html',
> 	async req =>
> 	{	await req.respond({body: 'Hello world'});
> 	}
> );
> 
> fcgi.listen
> (	8989,
> 	'/catalog/:item',
> 	async (req, params) =>
> 	{	await req.respond({body: `Item ${params.item}`});
> 	}
> );
> 
> fcgi.listen
> (	8989,
> 	'', // match all paths
> 	async req =>
> 	{	await req.respond({body: 'Something else'});
> 	}
> );
> ```



#### ⚙ unlisten(addr?: [FcgiAddr](../type.FcgiAddr/README.md)): `void`

> Stop serving requests on specified address, or on all addresses (if the `addr` parameter was `undefined`).
> Removing all listeners will trigger `end` event.



#### ⚙ onError(callback?: (error: Error) => `unknown`): Promise\<`void`>

> Catch FastCGI server errors. Multiple event handlers can be added.



#### ⚙ onEnd(callback?: () => `unknown`): Promise\<`void`>

> Catch the moment when FastCGI server stops accepting connections (when all listeners removed, and ongoing requests completed).
> 
> ```ts
> fcgi.onEnd(callback);
> // or
> await fcgi.onEnd();
> ```



#### ⚙ offError(callback?: (error: Error) => `unknown`): `void`

> `offError(callback)` - remove this callback that was added through `onError(callback)`.
> `offError()` - remove all callbacks.



#### ⚙ offEnd(callback?: () => `unknown`): `void`

> `offEnd(callback)` - remove this callback that was added through `onEnd(callback)`.
> `offEnd()` - remove all callbacks.



#### ⚙ options(options?: [ServerOptions](../interface.ServerOptions/README.md) \& [ClientOptions](../interface.ClientOptions/README.md)): ServerOptions \& ClientOptions

> Allows to modify `Server` and/or `Client` options. Not specified options will retain their previous values.
> This function can be called at any time, even after server started running, and new option values will take effect when possible.
> This function returns all the options after modification.
> 
> ```ts
> console.log(`maxConns=${fcgi.options().maxConns}`);
> fcgi.options({maxConns: 123});
> console.log(`Now maxConns=${fcgi.options().maxConns}`);
> ```



#### ⚙ fetch(request\_options: [RequestOptions](../interface.RequestOptions/README.md), input: Request | URL | `string`, init?: RequestInit): Promise\<[ResponseWithCookies](../class.ResponseWithCookies/README.md)>

> Send request to a FastCGI service, such as PHP, just like Apache and Nginx do.
> 
> First argument (`request_options`) specifies how to connect to the service, and what parameters to send to it.
> 2 most important parameters are `request_options.addr` (service socket address), and `request_options.scriptFilename` (path to script file that the service must execute).
> 
> Second (`input`) and 3rd (`init`) arguments are the same as in built-in `fetch()` function.
> 
> Returned response object extends built-in `Response` (that regular `fetch()` returns) by adding `cookies` property, that contains all `Set-Cookie` headers.
> Also `response.body` object extends regular `ReadableStream<Uint8Array>` by adding `Deno.Reader` implementation.
> 
> The response body must be explicitly read, before specified `request_options.timeout` period elapses. After this period, the connection will be forced to close.
> Each not closed connection counts towards [ClientOptions.maxConns](../interface.ClientOptions/README.md#-maxconns-number). After `response.body` read to the end, the connection returns to pool, and can be reused
> (except the case where existing `Deno.Conn` was given to `request_options.addr` - in this case the creator of this object decides what to do with this object then).
> 
> Idle connections will be closed after `request_options.keepAliveTimeout` milliseconds, and after `request_options.keepAliveMax` times used.



#### ⚙ fetchCapabilities(addr: [FcgiAddr](../type.FcgiAddr/README.md) | [Conn](../interface.Conn/README.md)): Promise\<\{FCGI\_MAX\_CONNS?: `number`, FCGI\_MAX\_REQS?: `number`, FCGI\_MPXS\_CONNS?: `number`}>

> Ask a FastCGI service (like PHP) for it's protocol capabilities. This is not so useful information. Only for those who curious. As i know, Apache and Nginx don't even ask for this during protocol usage.



#### ⚙ canFetch(): `boolean`

> [fetch()](../class.Fcgi/README.md#-fetchrequest_options-requestoptions-input-request--url--string-init-requestinit-promiseresponsewithcookies) and [fetchCapabilities()](../class.Fcgi/README.md#-fetchcapabilitiesaddr-fcgiaddr--conn-promisefcgi_max_conns-number-fcgi_max_reqs-number-fcgi_mpxs_conns-number) throw Error if number of ongoing requests is more than the configured value ([maxConns](../interface.ClientOptions/README.md#-maxconns-number)).
> `canFetch()` checks whether there are free slots, and returns true if so.
> It's recommended not to call `fetch()` untill `canFetch()` grants a green light.
> 
> Example:
> 
> ```ts
> if (!fcgi.canFetch())
> {	await fcgi.waitCanFetch();
> }
> await fcgi.fetch(...);
> ```



#### ⚙ waitCanFetch(): Promise\<`void`>



#### ⚙ closeIdle(): `void`

> If `keepAliveTimeout` option was > 0, `fcgi.fetch()` will reuse connections. After each fetch, connection will wait for specified number of milliseconds for next fetch. Idle connections don't let Deno application from exiting naturally.
> You can call `fcgi.closeIdle()` to close all idle connections.



