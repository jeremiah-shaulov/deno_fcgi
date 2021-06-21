# deno_fcgi
FastCGI implementation for Deno.

This library allows the following:

1. To create Deno backend application behind FastCGI-capable web server (like Apache or Nginx).
2. To make queries to a FastCGI service, like PHP.
3. To create 2 applications, and communicate between them through FastCGI protocol.

FastCGI is simple protocol designed to forward HTTP requests.
Usually it's used to forward different HTTP requests to different applications from HTTP server that listens on single host/port.
Having master HTTP server is convenient. It allows to have confuguration in single place, that controls all the WWW actions.

## Backend application example

```ts
import {fcgi} from 'https://deno.land/x/fcgi@v0.0.21/mod.ts';

console.log(`Started on [::1]:8989`);
fcgi.listen
(	'[::1]:8989',
	'',
	async req =>
	{	console.log(req.url);
		req.responseHeaders.set('Content-Type', 'text/html');
		await req.respond({body: 'Your cookies: '+JSON.stringify([...req.cookies.entries()])});
	}
);
```

## Apache backend configuration

For Deno backend behind Apache, need to enable FastCGI module, and configure Apache to forward requests.
There're many approaches. I'll show one of them.

1. Use "SetHandler" directive to forward requests. You can wrap "SetHandler" in "Location" ("LocationMatch") or "Files" ("FilesMatch") to forward only certain requests.

```apache
<VirtualHost *:80>
	ServerName deno-server.loc
	DocumentRoot /var/www/deno-server-root
    DirectoryIndex index.html

	<LocationMatch "\.ts$">
		SetHandler "proxy:fcgi://[::1]:8989"
	</LocationMatch>
</VirtualHost>
```

If "DocumentRoot" directive is present, the specified directory must exist.

2. Enable module called "proxy_fcgi":

```bash
sudo a2enmod proxy_fcgi`
sudo systemctl reload apache2
```

3. To use fake domain name `deno-server.loc` from localhost, add it to `/etc/hosts`:

```
127.0.0.1	deno-server.loc
```

4. Run Deno application like this:

```bash
deno run --unstable --allow-net main.ts
```

Now requests to `http://deno-server.loc/` will be forwarded to our Deno application.

If we want to listen on unix-domain socket, we can use such "SetHandler" directive:

```apache
	SetHandler "proxy:unix:/run/deno-server/main.sock|fcgi://localhost"
```

And use socket node path in `fcgi.listen()`.

```ts
// ...
fcgi.listen
(	'/run/deno-server/main.sock',
	'',
	async req =>
	{	// ...
	}
);
```

But there will be 1 problem. Deno script creates socket node and sets it's owner and group to the user from which you run Deno.
And Apache user will not be able to connect.
Changing socket group after starting Deno application can solve the problem.
You can use this script to start deno application:

```bash
APACHE_USER=www-data

sudo mkdir /run/deno-server
sudo chown "$USER:" /run/deno-server
deno run --unstable --allow-read --allow-write main.ts & sleep 3 && sudo chown "$USER:$APACHE_USER" /run/deno-server/main.sock; fg
```

## Nginx backend configuration

Example configuration:

```nginx
server
{	listen 127.0.0.1:8000;
	listen [::1]:8000;

	server_name deno-server.loc;

	root /var/www/deno-server-root;
	index index.html;

	location /
	{	try_files $uri $uri/ =404;
	}

	location ~ \.ts$
	{	fastcgi_split_path_info ^(.+?\.ts)(/.*)$;
		set $path_info $fastcgi_path_info;
		fastcgi_param PATH_INFO $path_info;
		fastcgi_index index.ts;
		include fastcgi.conf;

		fastcgi_pass [::1]:8989;
	}
}
```

## Using the API

This library provides first-class object through which you can do all the supported FastCGI operations: starting FastCGI server, and making queries to FastCGI services.

This object is called [fcgi](https://doc.deno.land/https/deno.land/x/fcgi@v0.0.21/mod.ts#Fcgi).

```ts
import {fcgi} from 'https://deno.land/x/fcgi@v0.0.21/mod.ts';
```

Methods:

1. `fcgi.listen(addr_or_listener: `[FcgiAddr](https://doc.deno.land/https/deno.land/x/fcgi@v0.0.21/mod.ts#FcgiAddr)` | `[Deno.Listener](https://doc.deno.land/builtin/stable#Deno.Listener)`, path_pattern: PathPattern, callback: Callback)`

Registers a FastCGI server on specified network address. The address can be given as:
* a port number (`8000`),
* a hostname with optional port (`localhost:8000`, `0.0.0.0:8000`, `[::1]:8000`, `::1`),
* a unix-domain socket file name (`/run/deno-fcgi-server.sock`),
* a `Deno.Addr` (`{transport: 'tcp', hostname: '127.0.0.1', port: 8000}`),
* or a ready `Deno.Listener` object can also be given.

This function can be called multiple times with the same or different addresses.
Calling with the same address adds another handler callback that will be tried to handle matching requests.
Calling with different address creates another FastCGI server.

Second argument allows to filter arriving requests.
It uses [x/path_to_regexp](https://deno.land/x/path_to_regexp) library, just like [x/oak](https://deno.land/x/oak) does.

Third argument is callback function with signature `(request: ServerRequest, params: any) => Promise<unknown>` that will be called for incoming requests that match filters.
`params` contains regexp groups from the path filter.

"callback" can handle the request and call it's `req.respond()` method (not returning from the callback till this happens), or it can decide not to handle this request,
and return without awaiting, so other handlers (registered with `fcgi.listen()`) will take chance to handle this request. If none handled, 404 response will be returned.

Example:

```ts
fcgi.listen
(	8989,
	'/page-1.html',
	async req =>
	{	await req.respond({body: 'Hello world'});
	}
);

fcgi.listen
(	8989,
	'/catalog/:item',
	async (req, params) =>
	{	await req.respond({body: `Item ${params.item}`});
	}
);

fcgi.listen
(	8989,
	'', // match all paths
	async req =>
	{	await req.respond({body: 'Something else'});
	}
);
```

2. `fcgi.unlisten(addr?: `[FcgiAddr](https://doc.deno.land/https/deno.land/x/fcgi@v0.0.21/mod.ts#FcgiAddr)`)`

Stop serving requests on specified address, or on all addresses (if the addr parameter was undefined). Removing all listeners will trigger "end" event.

3. `fcgi.onError(callback)` - catch FastCGI server errors. Multiple event handlers can be added.

4. `fcgi.onEnd(callback)` or `await onEnd()` - catch the moment when FastCGI server stops accepting connections (when all listeners removed, and ongoing requests completed).

5. `fcgi.offError(callback)` - remove this callback that was added through `onError(callback)`.

`fcgi.offError()` - remove all callbacks.

6. `fcgi.offEnd(callback)` - remove this callback that was added through `onEnd(callback)`.

`fcgi.offEnd()` - remove all callbacks.

7. `options(options?: `[ServerOptions](https://doc.deno.land/https/deno.land/x/fcgi@v0.0.21/mod.ts#ServerOptions)` & `[ClientOptions](https://doc.deno.land/https/deno.land/x/fcgi@v0.0.21/mod.ts#ClientOptions)`): ServerOptions & ClientOptions`

Allows to modify `Server` and/or `Client` options. Not specified options will retain their previous values.
This function can be called at any time, even after server started running, and new option values will take effect when possible.
This function returns all the options after modification.

```ts
console.log(`maxConns=${fcgi.options().maxConns}`);
fcgi.options({maxConns: 123});
console.log(`Now maxConns=${fcgi.options().maxConns}`);
```

8. `fcgi.fetch(request_options: `[RequestOptions](https://doc.deno.land/https/deno.land/x/fcgi@v0.0.21/mod.ts#RequestOptions)`, input: `[Request](https://doc.deno.land/builtin/stable#Request)` | `[URL](https://doc.deno.land/builtin/stable#URL)` | string, init?: RequestInit & { bodyIter: AsyncIterable<Uint8Array> }): Promise<`[ResponseWithCookies](https://doc.deno.land/https/deno.land/x/fcgi@v0.0.21/mod.ts#ResponseWithCookies)`>`

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

9. `fcgi.fetchCapabilities(addr: FcgiAddr | Deno.Conn): Promise<{ FCGI_MAX_CONNS: number, FCGI_MAX_REQS: number, FCGI_MPXS_CONNS: number }>`

Ask a FastCGI service (like PHP) for it's protocol capabilities. This is not so useful information. Only for those who curious. As i know, Apache and Nginx don't even ask for this during protocol usage.

10. `fcgi.canFetch(): boolean`

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

11. `fcgi.waitCanFetch(): Promise<void>`

12. `fcgi.closeIdle()`

If `keepAliveTimeout` option was > 0, `fcgi.fetch()` will reuse connections. After each fetch, connection will wait for specified number of milliseconds for next fetch. Idle connections don't let Deno application from exiting naturally.
You can call `fcgi.closeIdle()` to close all idle connections.

## Using low-level API

The mentioned `fcgi` object is just a wrapper around low-level functions and classes. It's possible to use them directly.

```ts
import {Server} from 'https://deno.land/x/fcgi@v0.0.21/mod.ts';

const listener = Deno.listen({hostname: "::1", port: 8989});
const server = new Server(listener);
console.log(`Started on ${(listener.addr as Deno.NetAddr).port}`);

for await (let req of server)
{	console.log(req.url);
	req.responseHeaders.set('Content-Type', 'text/html');
	await req.respond({body: 'Your cookies: '+JSON.stringify([...req.cookies.entries()])});
}
```

## `ServerRequest` object

Callback given to `fcgi.listen()` receives incoming request as `ServerRequest` object. Also asynchronous iteration over `Server` yields such objects. `ServerRequest` contains information sent from FastCGI server.

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
- `responseHeaders` (Headers) - Set response HTTP headers here, before calling `respond()`, and/or pass them to `respond()` (the latter have precedence).
- `headersSent` (boolean) - Indicates that response headers are already sent. They will be sent by `respond()` or earlier if you write data to the `ServerRequest` object (it implements `Deno.Writer`).

To respond to the request, you need to call `req.respond()` method, that sends all pending data to FastCGI server, and terminates the request, freeing all the resources, and deleting all the uploaded files (you need to move them to different location to keep them). The object will be not usable after calling `respond()`.

If using `Server` object, it's your responsibility to call `respond()` when you're finished with this request. `fcgi.listen()` API will call `respond()` automatically with 404 status, if you don't call it in any of registered request handlers.

Response headers and data can be set before calling `respond()`, or they can be given to the `response()`.
Response body can be given to `respond()`, or it can be written to `ServerRequest` object.

```ts
// test like this: curl --data 'INPUT DATA' http://deno-server.loc/test.ts

import {fcgi} from 'https://deno.land/x/fcgi@v0.0.21/mod.ts';
import {readAll, writeAll} from 'https://deno.land/std@0.97.0/io/util.ts';

console.log(`Started on [::1]:8989`);
fcgi.listen
(	'[::1]:8989',
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
