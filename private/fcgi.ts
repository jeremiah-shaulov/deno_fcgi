import {Conn, Listener} from './deno_ifaces.ts';
import {Server, ServerOptions} from './server.ts';
import {faddr_to_addr, addr_to_string} from './addr.ts';
import type {FcgiAddr} from './addr.ts';
import {Routes} from './routes.ts';
import type {Callback, PathPattern} from './routes.ts';
import {Client} from './client.ts';
import type {ClientOptions, RequestOptions} from './client.ts';
import {EventPromises} from './event_promises.ts';

const DEFAULT_404_PAGE = 'Resource not found';

/**	If the default instance of this class (`fcgi`) is not enough, you can create another `Fcgi` instance with it's own connection pool and maybe with different configuration.
 **/
export class Fcgi
{	private server = new Server;
	private is_serving = false;
	private routes = new Routes;
	private onerror = new EventPromises<Error>();
	private onend = new EventPromises<void>();
	private client = new Client;

	constructor()
	{	this.server.onError(e => {this.onerror.trigger(e)});
		this.client.onError(e => {this.onerror.trigger(e)});
	}

	/**	Registers a FastCGI server on specified network address.
		The address can be given as:
		- a port number (`8000`),
		- a hostname with optional port (`localhost:8000`, `0.0.0.0:8000`, `[::1]:8000`, `::1`),
		- a unix-domain socket file name (`/run/deno-fcgi-server.sock`),
		- a `Deno.Addr` (`{transport: 'tcp', hostname: '127.0.0.1', port: 8000}`),
		- or a ready `Deno.Listener` object can also be given.
		This function can be called multiple times with the same or different addresses.
		Calling with the same address adds another handler callback that will be tried to handle matching requests.
		Calling with different address creates another FastCGI server.
		Second argument allows to filter arriving requests.
		It uses [x/path_to_regexp](https://deno.land/x/path_to_regexp) library, just like [x/oak](https://deno.land/x/oak) does.
		Third argument is callback function with signature `(request: ServerRequest, params: any) => Promise<unknown>` that will be called for incoming requests that match filters.
		`params` contains regexp groups from the path filter.
		"callback" can handle the request and call it's `req.respond()` method (not returning from the callback till this happens), or it can decide not to handle this request,
		and return without awaiting, so other handlers (registered with `listen()`) will take chance to handle this request. If none handled, 404 response will be returned.
		Example:

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
	 **/
	listen(addr_or_listener: FcgiAddr | Listener, path_pattern: PathPattern, callback: Callback)
	{	const {server} = this;
		if (typeof(addr_or_listener)=='object' && 'addr' in addr_or_listener)
		{	// deno-lint-ignore no-inner-declarations  no-var
			var listener = addr_or_listener;
		}
		else
		{	const addr = faddr_to_addr(addr_or_listener);
			const found_listener = server.getListener(addr);
			if (found_listener)
			{	listener = found_listener;
			}
			else if (addr.transport == 'tcp')
			{	listener = Deno.listen({transport: 'tcp', port: addr.port, hostname: addr.hostname});
			}
			else if (addr.transport == 'unix')
			{	listener = Deno.listen({transport: 'unix', path: addr.path} as any); // "as any" in order to avoid requireing --unstable
			}
			else
			{	throw new Error('Can only listen to tcp/unix');
			}
		}
		const {addr} = listener;
		this.routes.add_route(addr_to_string(addr), path_pattern, callback);
		server.addListener(listener);
		if (!this.is_serving)
		{	this.is_serving = true;
			(	async () =>
				{	try
					{	for await (const request of server)
						{	queueMicrotask
							(	async () =>
								{	let path = request.params.get('REQUEST_URI') || '';
									const pos = path.indexOf('?');
									if (pos != -1)
									{	path = path.slice(0, pos);
									}
									for (const {callback, params} of this.routes.get_callback_and_params(addr_to_string(request.localAddr), path))
									{	try
										{	await callback(request, params);
										}
										catch (e)
										{	this.onerror.trigger(e);
											if (!request.isTerminated())
											{	try
												{	await request.respond({status: 500, body: ''});
												}
												catch (e2)
												{	this.onerror.trigger(e2);
												}
											}
										}
										if (request.isTerminated())
										{	return;
										}
									}
									request.respond({status: 404, body: DEFAULT_404_PAGE});
								}
							);
						}
					}
					catch (e)
					{	this.onerror.trigger(e);
					}
					server.removeListeners();
					this.routes.clear();
					this.is_serving = false;
					this.onend.trigger();
				}
			)();
		}
		return listener;
	}

	/**	Stop serving requests on specified address, or on all addresses (if the `addr` parameter was `undefined`).
		Removing all listeners will trigger `end` event.
	 **/
	unlisten(addr?: FcgiAddr)
	{	if (addr == undefined)
		{	this.server.removeListeners();
		}
		else
		{	addr = faddr_to_addr(addr);
			this.server.removeListener(addr);
			this.routes.remove_addr(addr_to_string(addr));
		}
	}

	/**	Catch FastCGI server errors. Multiple event handlers can be added.
	 **/
	onError(callback?: (error: Error) => unknown)
	{	return this.onerror.add(callback);
	}

	/**	Catch the moment when FastCGI server stops accepting connections (when all listeners removed, and ongoing requests completed).

		fcgi.onEnd(callback);
		// or
		await fcgi.onEnd();
	 **/
	onEnd(callback?: () => unknown)
	{	const promise = this.onend.add(callback);
		if (!this.is_serving)
		{	this.onend.trigger();
		}
		return promise;
	}

	/**	`offError(callback)` - remove this callback that was added through `onError(callback)`.
		`offError()` - remove all callbacks.
	 **/
	offError(callback?: (error: Error) => unknown)
	{	if (callback)
		{	this.onerror.remove(callback);
		}
		else
		{	this.onerror.clear();
		}
	}

	/**	`offEnd(callback)` - remove this callback that was added through `onEnd(callback)`.
		`offEnd()` - remove all callbacks.
	 **/
	offEnd(callback?: () => unknown)
	{	if (callback)
		{	this.onend.remove(callback);
		}
		else
		{	this.onend.clear();
		}
	}

	/**	Allows to modify `Server` and/or `Client` options. Not specified options will retain their previous values.
		This function can be called at any time, even after server started running, and new option values will take effect when possible.
		This function returns all the options after modification.

		console.log(`maxConns=${fcgi.options().maxConns}`);
		fcgi.options({maxConns: 123});
		console.log(`Now maxConns=${fcgi.options().maxConns}`);
	 **/
	options(options?: ServerOptions & ClientOptions): ServerOptions & ClientOptions
	{	const server_options = this.server.options(options);
		const client_options = this.client.options(options);
		return {...server_options, ...client_options};
	}

	/**	Send request to a FastCGI service, such as PHP, just like Apache and Nginx do.
		First argument (`request_options`) specifies how to connect to the service, and what parameters to send to it.
		2 most important parameters are `request_options.addr` (service socket address), and `request_options.scriptFilename` (path to script file that the service must execute).
		Second (`input`) and 3rd (`init`) arguments are the same as in built-in `fetch()` function.
		Returned response object extends built-in `Response` (that regular `fetch()` returns) by adding `cookies` property, that contains all `Set-Cookie` headers.
		Also `response.body` object extends regular `ReadableStream<Uint8Array>` by adding `Deno.Reader` implementation.
		The response body must be explicitly read, before specified `request_options.timeout` period elapses. After this period, the connection will be forced to close.
		Each not closed connection counts towards `ClientOptions.maxConns`. After `response.body` read to the end, the connection returns to pool, and can be reused
		(except the case where existing `Deno.Conn` was given to `request_options.addr` - in this case the creator of this object decides what to do with this object then).
		Idle connections will be closed after `request_options.keepAliveTimeout` milliseconds, and after `request_options.keepAliveMax` times used.
	 **/
	fetch(request_options: RequestOptions, input: Request|URL|string, init?: RequestInit)
	{	return this.client.fetch(request_options, input, init);
	}

	/**	Ask a FastCGI service (like PHP) for it's protocol capabilities. This is not so useful information. Only for those who curious. As i know, Apache and Nginx don't even ask for this during protocol usage.
	 **/
	fetchCapabilities(addr: FcgiAddr | Conn)
	{	return this.client.fetchCapabilities(addr);
	}

	/**	`fetch()` and `fetchCapabilities()` throw Error if number of ongoing requests is more than the configured value (`maxConns`).
		`canFetch()` checks whether there are free slots, and returns true if so.
		It's recommended not to call `fetch()` untill `canFetch()` grants a green light.
		Example:

		if (!fcgi.canFetch())
		{	await fcgi.waitCanFetch();
		}
		await fcgi.fetch(...);
	 **/
	canFetch()
	{	return this.client.canFetch();
	}

	waitCanFetch()
	{	return this.client.waitCanFetch();
	}

	/**	If `keepAliveTimeout` option was > 0, `fcgi.fetch()` will reuse connections. After each fetch, connection will wait for specified number of milliseconds for next fetch. Idle connections don't let Deno application from exiting naturally.
		You can call `fcgi.closeIdle()` to close all idle connections.
	 **/
	closeIdle()
	{	this.client.closeIdle();
	}
}

/**	`Fcgi` class provides top-level API, above `Server` and `Client`, and `fcgi` is the default instance of `Fcgi` to be used most of the time.

	// Create FastCGI backend server (another HTTP server will send requests to us)

	fcgi.listen
	(	8989,
		'/page-1.html',
		async req =>
		{	await req.respond({body: 'Hello world'});
		}
	);


	// ANOTHER EXAMPLE:


	// Create FastCGI client for PHP.
	// Stop your existing PHP-FPM service, setup `PHP_POOL_CONFIG_FILE` and `DOCUMENT_ROOT` variables, and run this code.
	// This code creates PHP-FPM capable HTTP server.

	import {listenAndServe} from 'https://deno.land/std@0.135.0/http/server.ts';

	const PHP_POOL_CONFIG_FILE = '/etc/php/7.4/fpm/pool.d/www.conf';
	const DOCUMENT_ROOT = '/var/www/deno-server-root';

	// Read PHP service address from it's configuration file
	const HTTTP_LISTEN = ':8081';
	const CONF = Deno.readTextFileSync(PHP_POOL_CONFIG_FILE);
	const PHP_LISTEN = CONF.match(/(?:^|\r|\n)\s{0,}listen\s{0,}=\s{0,}(\S+)/)?.[1];

	if (PHP_LISTEN)
	{	listenAndServe
		(	HTTTP_LISTEN,
			async (request) =>
			{	console.log(`Request: ${request.url}`);
				let url = new URL(request.url);
				if (url.pathname.endsWith('.php'))
				{	try
					{	// Fetch from PHP
						let response = await fcgi.fetch
						(	{	addr: PHP_LISTEN,
								params: new Map
								(	Object.entries
									(	{	DOCUMENT_ROOT,
											SCRIPT_FILENAME: DOCUMENT_ROOT+url.pathname, // response will be successful if such file exists
										}
									)
								),
							},
							url, // URL of the request that PHP will see
							{	method: request.method,
								body: request.body,
							}
						);
						console.log(response);

						// Pass the response to deno server
						return new Response
						(	response.body,
							{	status: response.status,
								headers: response.headers,
							}
						);
					}
					catch (e)
					{	console.error(e);
						return new Response('', {status: 500});
					}
				}
				else
				{	return new Response('Resource not found', {status: 404});
				}
			}
		);
	}
 **/
export const fcgi = new Fcgi;
