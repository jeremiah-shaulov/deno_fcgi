# fcgi
FastCGI protocol implementation for Deno.

This library allows the following:

1. To create Deno backend application behind a FastCGI-capable web server (like Apache or Nginx).
2. To make queries to a FastCGI service, such as PHP (as web server does).
3. To create 2 Deno applications, and communicate between them through FastCGI protocol.

FastCGI is a simple protocol designed to forward HTTP requests.
Usually it's used to forward different HTTP requests to different applications from one HTTP server that listens on single host/port.
Having master HTTP server is convenient. It allows to have confuguration that controls all the WWW actions in one place.

## Backend application example (FastCGI server)

```ts
// File: backend.ts

import {fcgi} from 'https://deno.land/x/fcgi@v1.0.6/mod.ts';

const listener = fcgi.listen
(	'localhost:9988', // FastCGI service will listen on this address
	'', // Handle all URL paths
	async req =>
	{	// Handle the request
		console.log(req.url);
		req.responseHeaders.set('Content-Type', 'text/html');
		await req.respond({body: 'Hello world!'});
	}
);

console.log(`Started on ${listener.addr.transport=='tcp' ? listener.addr.hostname+':'+listener.addr.port : listener.addr.transport}`);
```

And you can set up your web server to forward HTTP requests to `localhost:9988`, and the application will get them.

## Frontend application example (FastCGI client)

Or you can create a web server with Deno, and make requests to some FastCGI server. This can be PHP-FPM, or this can be our Deno backend application shown above.

In the following example i'll use [x/oak](https://deno.land/x/oak) to create HTTP server in Deno:

```ts
// File: frontend.ts

import {Application} from 'https://deno.land/x/oak@v9.0.1/mod.ts';
import {fcgi} from 'https://deno.land/x/fcgi@v1.0.6/mod.ts';

const app = new Application;

app.use
(	async ctx =>
	{	const resp = await fcgi.fetch
		(	{	addr: 'localhost:9988',
				scriptFilename: '', // PHP requires this parameter to be set to path of an existing *.php file
			},
			new Request
			(	ctx.request.url.href,
				{	method: ctx.request.method,
					headers: ctx.request.headers,
					body: ctx.request.hasBody ? ctx.request.body({type: 'stream'}).value : undefined,
				}
			)
		);
		ctx.response.status = resp.status;
		ctx.response.headers = resp.headers;
		ctx.response.body = resp.body;
	}
);

app.listen('localhost:8123');
console.log(`Started on http://localhost:8123`);
```

Here's how to run the previous 2 examples:

```bash
deno run --allow-net backend.ts &
deno run --allow-net frontend.ts
```

Now HTTP requests on `http://localhost:8123` will be forwarded to `fcgi://localhost:9988` and handled by the backend application.

## Setup examples:

- [Nginx → Deno](./examples/Nginx%20→%20Deno): how to set up Nginx HTTP server.
- [Apache → Deno](./examples/Apache%20→%20Deno): how to set up Apache HTTP server.
- [Deno → PHP](./examples/Deno%20→%20PHP): how to set up PHP-FPM and forward requests to it.

## Using the API

This library provides first-class object through which you can do all the supported FastCGI operations: starting FastCGI server, and making queries to FastCGI services.

This object is called [fcgi](https://doc.deno.land/https/deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi).

```ts
import {fcgi} from 'https://deno.land/x/fcgi@v1.0.6/mod.ts';
```

Methods:

1. `fcgi.`[listen](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#listen)`(addrOrListener: `[FcgiAddr](https://doc.deno.land/https/deno.land/x/fcgi@v1.0.6/mod.ts/~/FcgiAddr)` | `[Deno.Listener](https://doc.deno.land/deno/stable/~/Deno.Listener)`, pathPattern: PathPattern, callback: Callback)`

Registers a FastCGI server on specified network address. The address can be given as:
* a port number (`8000`),
* a hostname with optional port (`localhost:8000`, `0.0.0.0:8000`, `[::1]:8000`, `::1`),
* a unix-domain socket file name (`/run/deno-fcgi-server.sock`),
* a [Deno.Addr](https://doc.deno.land/deno/stable/~/Deno.Addr) (`{transport: 'tcp', hostname: '127.0.0.1', port: 8000}`),
* or a ready [Deno.Listener](https://doc.deno.land/deno/stable/~/Deno.Listener) object can also be given.

This function can be called multiple times with the same or different addresses.
Calling with the same address adds another handler callback that will be tried to handle matching requests.
Calling with different address creates another FastCGI server.

Second argument allows to filter arriving requests.
It uses [x/path_to_regexp](https://deno.land/x/path_to_regexp) library, just like [x/oak](https://deno.land/x/oak) does.

Third argument is callback function with signature `(request: `[ServerRequest](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/ServerRequest)`, params: any) => Promise<unknown>` that will be called for incoming requests that match filters.
`params` contains regexp groups from the path filter.

"callback" can handle the request and call it's `req.respond()` method (awaiting for it's result), or it can decide not to handle this request,
and return without calling `req.respond()`, so other handlers (registered with `fcgi.listen()`) will take chance to handle this request. If none handled, 404 response will be returned.

Example:

```ts
fcgi.listen
(	9988,
	'/page-1.html',
	async req =>
	{	await req.respond({body: 'Hello world'});
	}
);

fcgi.listen
(	9988,
	'/catalog/:item',
	async (req, params) =>
	{	await req.respond({body: `Item ${params.item}`});
	}
);

fcgi.listen
(	9988,
	'', // match all paths
	async req =>
	{	await req.respond({body: 'Something else'});
	}
);
```

2. `fcgi.`[unlisten](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#unlisten)`(addr?: `[FcgiAddr](https://doc.deno.land/https/deno.land/x/fcgi@v1.0.6/mod.ts/~/FcgiAddr)`)`

Stop serving requests on specified address, or on all addresses (if the addr parameter was undefined). Removing all listeners will trigger "end" event.

3. `fcgi.`[onError](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#onError)`(callback)` - catch FastCGI server errors. Multiple event handlers can be added.

4. `fcgi.`[onEnd](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#onEnd)`(callback)` or `await onEnd()` - catch the moment when FastCGI server stops accepting connections (when all listeners removed, and ongoing requests completed).

5. `fcgi.`[offError](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#offError)`(callback)` - remove this callback that was added through `onError(callback)`.

`fcgi.offError()` - remove all callbacks.

6. `fcgi.`[offEnd](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#offEnd)`(callback)` - remove this callback that was added through `onEnd(callback)`.

`fcgi.offEnd()` - remove all callbacks.

7. `fcgi.`[options](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#options)`(options?: `[ServerOptions](https://doc.deno.land/https/deno.land/x/fcgi@v1.0.6/mod.ts/~/ServerOptions)` & `[ClientOptions](https://doc.deno.land/https/deno.land/x/fcgi@v1.0.6/mod.ts/~/ClientOptions)`): ServerOptions & ClientOptions`

Allows to modify `Server` and/or `Client` options. Not specified options will retain their previous values.
This function can be called at any time, even after server started running, and new option values will take effect when possible.
This function returns all the options after modification.

```ts
console.log(`maxConns=${fcgi.options().maxConns}`);
fcgi.options({maxConns: 123});
console.log(`Now maxConns=${fcgi.options().maxConns}`);
```

8. `fcgi.`[fetch](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#fetch)`(request_options: `[RequestOptions](https://doc.deno.land/https/deno.land/x/fcgi@v1.0.6/mod.ts/~/RequestOptions)`, input: `[Request](https://doc.deno.land/deno/stable/~/Request)` | `[URL](https://doc.deno.land/deno/stable/~/URL)` | string, init?: RequestInit & { bodyIter: AsyncIterable<Uint8Array> }): Promise<`[ResponseWithCookies](https://doc.deno.land/https/deno.land/x/fcgi@v1.0.6/mod.ts/~/ResponseWithCookies)`>`

Send request to a FastCGI service, such as PHP, just like Apache and Nginx do.

First argument (`request_options`) specifies how to connect to the service, and what parameters to send to it.
2 most important parameters are `request_options.addr` (service socket address), and `request_options.scriptFilename` (path to script file that the service must execute).

Second (`input`) and 3rd (`init`) arguments are the same as in built-in `fetch()` function, except that `init` allows to read request body from an `AsyncIterable<Uint8Array>` (`init.bodyIter`).

Returned response object extends built-in `Response` (that regular `fetch()` returns) by adding `cookies` property, that contains all `Set-Cookie` headers.
Also `response.body` object extends regular `ReadableStream<Uint8Array>` by adding `Deno.Reader` implementation.

The response body must be explicitly read, before specified `request_options.timeout` period elapses. After this period, the connection will be forced to close.
Each not closed connection counts towards `ClientOptions.maxConns`. After `response.body` read to the end, the connection returns to pool, and can be reused
(except the case where existing `Deno.Conn` was given to `request_options.addr` - in this case the creator of this object decides what to do with this object then).

Idle connections will be closed after `request_options.keepAliveTimeout` milliseconds, and after `request_options.keepAliveMax` times used.

9. `fcgi.`[fetchCapabilities](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#fetchCapabilities)`(addr: `[FcgiAddr](https://doc.deno.land/https/deno.land/x/fcgi@v1.0.6/mod.ts/~/FcgiAddr)` | Deno.Conn): Promise<{ FCGI_MAX_CONNS: number, FCGI_MAX_REQS: number, FCGI_MPXS_CONNS: number }>`

Ask a FastCGI service (like PHP) for it's protocol capabilities. This is not so useful information. Only for those who curious. As i know, Apache and Nginx don't even ask for this during protocol usage.

10. `fcgi.`[canFetch](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#canFetch)`(): boolean`

When number of ongoing requests is more than the configured value (`maxConns`), `fetch()` and `fetchCapabilities()` will wait.
`canFetch()` checks whether there are free slots, and returns true if so.
It's recommended not to call `fetch()` untill `canFetch()` grants a green light.
Example:

```ts
if (!fcgi.canFetch())
{	await fcgi.waitCanFetch();
}
await fcgi.fetch(...);
```

11. `fcgi.`[waitCanFetch](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#waitCanFetch)`(): Promise<void>`

12. `fcgi.`[closeIdle](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#closeIdle)`()`

If `keepAliveTimeout` option was > 0, `fcgi.fetch()` will reuse connections. After each fetch, connection will wait for specified number of milliseconds for next fetch. Idle connections don't let Deno application from exiting naturally.
You can call `fcgi.closeIdle()` to close all idle connections.

## Using low-level API

The mentioned `fcgi` object is just a wrapper around low-level functions and classes. It's possible to use them directly.

```ts
import {Server} from 'https://deno.land/x/fcgi@v1.0.6/mod.ts';

const listener = Deno.listen({hostname: "::1", port: 9988});
const server = new Server(listener);
console.log(`Started on ${listener.addr.transport=='tcp' ? listener.addr.hostname+':'+listener.addr.port : listener.addr}`);

for await (let req of server)
{	queueMicrotask
	(	async () =>
		{	console.log(req.url);
			req.responseHeaders.set('Content-Type', 'text/html');
			await req.respond({body: 'Your cookies: '+JSON.stringify([...req.cookies.entries()])});
		}
	);
}
```

## `ServerRequest` object

Callback given to `fcgi.`[listen](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/Fcgi#listen) receives incoming request as [ServerRequest](https://doc.deno.land/https://deno.land/x/fcgi@v1.0.6/mod.ts/~/ServerRequest) object. Also asynchronous iteration over `Server` yields such objects. `ServerRequest` contains information sent from FastCGI server.

- `url` (string) - REQUEST_URI of the request, like '/path/index.html?a=1'
- `method` (string) - Like `GET`.
- `proto` (string) - Like `HTTP/1.1` or `HTTP/2`.
- `protoMinor` (number)
- `protoMajor` (number)
- `params` (Headers) - Environment params sent from FastCGI frontend. This usually includes 'REQUEST_URI', 'SCRIPT_URI', 'SCRIPT_FILENAME', 'DOCUMENT_ROOT', can contain 'CONTEXT_DOCUMENT_ROOT' (if using Apache MultiViews), etc.
- `headers` (Headers) - Request HTTP headers.
- `get` (Map) - Query string parameters.
- `post` (Map) - POST parameters, that can contain uploaded files. To initialize this property, call `await req.post.parse()`.
- `cookies` (Map) - Request cookies. Adding and deleting them adds corresponding response HTTP headers.
- `body` (Deno.Reader) - Allows to read raw POST body if `req.post.parse()` was not called. The body can be also read from `ServerRequest` object itself, as it implements `Deno.Reader` (`req.body == req`).
- `responseStatus` (number) - Set this to HTTP status code before calling `respond()`. However status given to `respond()` (if given) overrides this one.
- `responseHeaders` (Headers) - Set response HTTP headers here, before calling `respond()`, and/or pass them to `respond()` (the latter has precedence).
- `headersSent` (boolean) - Indicates that response headers are already sent. They will be sent by `respond()` or earlier if you write data to the `ServerRequest` object (it implements `Deno.Writer`).

To respond to the request, you need to call `req.respond()` method, that sends all pending data to FastCGI server, and terminates the request, freeing all the resources, and deleting all the uploaded files (you need to move them to different location to keep them). The object will be not usable after calling `respond()`.

If using `Server` object, it's your responsibility to call `respond()` when you're finished with this request. `fcgi.listen()` API will call `respond()` automatically with 404 status, if you don't call it in any of registered request handlers.

Response headers and data can be set before calling `respond()`, or they can be given to the `response()`.
Response body can be given to `respond()`, or it can be written to `ServerRequest` object.

```ts
// test like this: curl --data 'INPUT DATA' http://deno-server.loc/test.ts

import {fcgi} from 'https://deno.land/x/fcgi@v1.0.6/mod.ts';
import {readAll, writeAll} from 'https://deno.land/std@0.135.0/streams/conversion.ts';

console.log(`Started on [::1]:9988`);
fcgi.listen
(	'[::1]:9988',
	'',
	async req =>
	{	console.log(req.url);
		// read raw POST input
		let raw_input = await readAll(req.body);
		// write response
		req.responseHeaders.set('Content-Type', 'text/plain');
		await writeAll(req, new TextEncoder().encode('The POST input was:\n'));
		await writeAll(req, raw_input);
		await req.respond();
	}
);
```
