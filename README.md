# deno_fcgi
FastCGI implementation for Deno.

## Example

```ts
import {fcgi} from 'https://deno.land/x/fcgi/mod.ts';

console.log(`Started on 8080`);
fcgi.listen
(	8080,
	'',
	async req =>
	{	await req.post.parse();
		console.log(`URL=${req.url}  GET=${[...req.get.entries()]}  POST=${[...req.post.entries()]}`);
		req.responseHeaders.set('Content-Type', 'text/html');
		await req.respond({body: 'Hello'});
	}
);
```

## Example of low-level usage

```ts
import {Server} from 'https://deno.land/x/fcgi/mod.ts';

const listener = Deno.listen({hostname: "0.0.0.0", port: 8080});
const server = new Server(listener);
console.log(`Started on ${(listener.addr as Deno.NetAddr).port}`);

for await (let req of server)
{	req.post.parse().then
	(	async () =>
		{	console.log(`URL=${req.url}  GET=${[...req.get.entries()]}  POST=${[...req.post.entries()]}`);
			req.responseHeaders.set('Content-Type', 'text/html');
			await req.respond({body: 'Hello'});
		}
	);
}
```

## Usage

First need to proxy HTTP requests from a FastCGI-capable web server, like Apache or Nginx. I'll show a simplest setup example for Apache, to be used as starting point.

```apache
<VirtualHost *:80>
	ServerName deno-server.loc
	DocumentRoot /var/www/deno-server-root
    DirectoryIndex index.html

	SetHandler "proxy:fcgi://localhost:8080"
</VirtualHost>
```
For FastCGI to work, enable apache module called "proxy_fcgi" (`sudo a2enmod proxy_fcgi`).

DocumentRoot directory must exist.

To use fake domain name `deno-server.loc` from localhost, add it to `/etc/hosts`:

```
127.0.0.1	deno-server.loc
```

Run Deno application like this:

```bash
deno run --unstable --allow-net main.ts
```
Now requests to `http://deno-server.loc/` will be forwarded to our Deno application.

### Using unix-domain socket
```ts
import {fcgi} from 'https://deno.land/x/fcgi/mod.ts';

console.log(`Started on /run/deno-server/main.sock`);
fcgi.listen
(	'/run/deno-server/main.sock',
	'',
	async req =>
	{	await req.post.parse();
		console.log(`URL=${req.url}  GET=${[...req.get.entries()]}  POST=${[...req.post.entries()]}`);
		req.responseHeaders.set('Content-Type', 'text/html');
		await req.respond({body: 'Hello'});
	}
);
```
```apache
<VirtualHost *:80>
	ServerName deno-server.loc
	DocumentRoot /var/www/deno-server-root
	DirectoryIndex index.html

	SetHandler "proxy:unix:/run/deno-server/main.sock|fcgi://localhost"
</VirtualHost>
```
We want to use a socket file, and both Apache and our application must have access permission to it.

```bash
sudo mkdir /run/deno-server
sudo chown "$USER:" /run/deno-server
```
In this directory our application will create socket file `main.sock`, so it must have write permission to the directory. It will create the file with aplication's owner, so Apache will have no write access to it. Therefore it's necessary to change file owner after creating it (after our application executed `Deno.listen()`). We could do so in the application itself, but for this to be possible we need to give to our application root privileges. Instead i suggest to use a starter script that will first start our application, and then will change the ownership of the created file.

```bash
APACHE_USER=www-data
deno run --unstable --allow-read --allow-write main.ts & sleep 3 && sudo chown "$APACHE_USER:$USER" /run/deno-server/main.sock; fg
```

## Using the API

Let's take a look again to the simplest example.

```ts
import {fcgi} from 'https://deno.land/x/fcgi/mod.ts';

console.log(`Started on 8080`);
fcgi.listen
(	8080,
	'',
	async req =>
	{	await req.post.parse();
		console.log(`URL=${req.url}  GET=${[...req.get.entries()]}  POST=${[...req.post.entries()]}`);
		req.responseHeaders.set('Content-Type', 'text/html');
		await req.respond({body: 'Hello'});
	}
);
```

The main interface is the `fcgi` object. It has the following methods:

  - `listen(addr, pathPattern, callback)` - creates FastCGI listener on specified network address. It can be called multiple times with the same or different addresses. Requests that arrive can be optionally handled by calling `req.respond()` and awaiting for the result. If the handler function doesn't want to handle such request, it can return without actions taken, and other added handlers will take their chance to handle this request. If no handler took care of the request, a 404 response will be sent.
  - `unlisten()` - stop listening to specified address, or to all addresses.
  - `on()` - allows to register event handlers for errors (`on('error', callback)`) and for server termination (`on('end', callback)`). The server will be terminated after you remove all listeners.

Arguments of `listen(addr, pathPattern, callback)` are:
  - Network address for the listener. It can be a port number, a string that represents unix-domain socket node, a string like `hostname:8080` or `[::1]:8080`, a `Deno.Addr` object, or a `Deno.Listener`.
  - Request path filter. It uses [path-to-regexp](https://github.com/pillarjs/path-to-regexp) library, like `x/oak`.
  - Callback that gets 2 arguments: the request, and parameters extracted from path according to `pathPattern`.

## Using the low-level API

Low-level API is similar to `std/http`. First thing to do is to create a `Server` object.

```ts
const listener = Deno.listen({hostname: "0.0.0.0", port: 8080});
const options =
{	maxConns: 128,
	structuredParams: true,
};
const server = new Server(listener, options);
```
`listener` can be any `Deno.Listener` object.

There are the following options that modify server behavior:
- `maxConns` - Maximum number of simultaneous connections to accept (default is 128).
- `structuredParams` - Parse GET and POST parameters like PHP does. Query strings like `items[]=a&items[]=b` or `items[a][b]=c` will be parsed to `Map` objects, so `req.get.get('item')` will be of type `Map<string, ...>`.

## The `ServerRequest` object

Asynchronous iteration over `Server` object yields incoming HTTP requests. Each request is a `ServerRequest` object, that contains the request information sent from FastCGI server.

  - `url` (string) - Like `/index.html`.
  - `method` (string) - Like `GET`.
  - `proto` (string) - Like `HTTP/1.1` or `HTTP/2`.
  - `protoMinor` (number)
  - `protoMajor` (number)
  - `params` (Headers) - Environment parameters that usually include `DOCUMENT_ROOT`, and can include `CONTEXT_DOCUMENT_ROOT` if using apache MultiViews.
  - `headers` (Headers) - Request HTTP headers.
  - `get` (Map) - Lazy-parsed query string.
  - `post` (Map) - Lazy-parsed POST body, that can contain uploaded files.
  - `cookies` (Map) - Lazy-parsed request cookies. Adding and deleting them adds corresponding response HTTP headers.
  - `body` (Deno.Reader) - Allows to read raw POST body before accessing `post`. The body can be also read from the `ServerRequest` object itself, as it implements `Deno.Reader` (`req.body == req`).
  - `responseStatus` (number) - Set this to HTTP status code before calling `respond()`. However status given to `respond()` (if given) overrides this one.
  - `responseHeaders` (Headers) - Set response HTTP headers here, before calling `respond()`, or pass them to `respond()` (the latter have precedence).
  - `headersSent` (boolean) - Indicates that response headers are already sent. They will be sent by `respond()` or earlier if you write data to the `ServerRequest` object (it implements `Deno.Writer`).

It's your responsibility to call `respond()` when you're finished with this request. `respond()` sends all the pending data to the FastCGI server, and terminates the request, freeing all the resources, and deleting all the uploaded files (you need to move them to different location to keep them). The object will be not usable after calling `respond()`.

Response headers and data can be set before calling `respond()`, or they can be given to the `response()`.

```ts
import {Server} from 'https://deno.land/x/fcgi/mod.ts';
import {readAll} from 'https://deno.land/std@0.97.0/io/util.ts';

const listener = Deno.listen({hostname: "0.0.0.0", port: 8080});
const server = new Server(listener);
console.log(`Started on ${(listener.addr as Deno.NetAddr).port}`);

for await (let req of server)
{	readAll(req.body).then
	(	async postData =>
		{	let postStr = new TextDecoder().decode(postData);
			console.log(`URL=${req.url}  GET=${[...req.get.entries()]}  POST=${postStr}`);
			await req.respond({body: 'Hello', headers: new Headers([['Content-Type', 'text/html']])});
		}
	);
}
```
Or:

```ts
import {Server} from 'https://deno.land/x/fcgi/mod.ts';
import {writeAll, readAll} from 'https://deno.land/std@0.97.0/io/util.ts';

const listener = Deno.listen({hostname: "0.0.0.0", port: 8080});
const server = new Server(listener);
console.log(`Started on ${(listener.addr as Deno.NetAddr).port}`);

for await (let req of server)
{	readAll(req.body).then
	(	async postData =>
		{	let postStr = new TextDecoder().decode(postData);
			console.log(`URL=${req.url}  GET=${[...req.get.entries()]}  POST=${postStr}`);
			req.responseHeaders.set('Content-Type', 'text/html');
			await writeAll(req, new TextEncoder().encode('Hello'));
			await req.respond();
		}
	);
}
```
