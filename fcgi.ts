import {Server, ServerOptions} from './server.ts';
import {faddr_to_addr, addr_to_string} from './addr.ts';
import type {FcgiAddr} from './addr.ts';
import {Routes} from './routes.ts';
import type {Callback, PathPattern} from './routes.ts';
import {Client, ResponseWithCookies} from './client.ts';
import type {ClientOptions, RequestOptions} from './client.ts';
import {EventPromises} from './event_promises.ts';

const DEFAULT_404_PAGE = 'Resource not found';

/**	If the default instance of this class (`fcgi`) is not enough, you can create another `Fcgi` instance with it's own connections pool and maybe with different configuration.
 **/
export class Fcgi
{	private server = new Server;
	private is_serving = false;
	private routes = new Routes;
	private onerror = new EventPromises<Error>();
	private onend = new EventPromises<void>();
	private client = new Client;

	constructor()
	{	this.server.on('error', e => {this.onerror.trigger(e)});
		this.client.on('error', e => {this.onerror.trigger(e)});
	}

	/**	Register a FastCGI `Server` on specified network address.
		This function can be called multiple times with the same or different addresses.
	 **/
	listen(addr_or_listener: FcgiAddr | Deno.Listener, path_pattern: PathPattern, callback: Callback)
	{	let {server} = this;
		if (typeof(addr_or_listener)=='object' && (addr_or_listener as Deno.Listener).addr)
		{	var listener = addr_or_listener as Deno.Listener;
		}
		else
		{	let addr = faddr_to_addr(addr_or_listener as FcgiAddr);
			let found_listener = server.getListener(addr);
			if (found_listener)
			{	listener = found_listener;
			}
			else if (addr.transport == 'tcp')
			{	listener = Deno.listen({transport: 'tcp', port: addr.port, hostname: addr.hostname});
			}
			else if (addr.transport == 'unix')
			{	listener = Deno.listen({transport: 'unix', path: addr.path});
			}
			else
			{	throw new Error('Can only listen to tcp/unix');
			}
		}
		let {addr} = listener;
		this.routes.add_route(addr_to_string(addr), path_pattern, callback);
		server.addListener(listener);
		if (!this.is_serving)
		{	this.is_serving = true;
			(	async () =>
				{	try
					{	for await (let request of server)
						{	queueMicrotask
							(	async () =>
								{	let path = request.params.get('REQUEST_URI') || '';
									let pos = path.indexOf('?');
									if (pos != -1)
									{	path = path.slice(0, pos);
									}
									for (let {callback, params} of this.routes.get_callback_and_params(addr_to_string(request.localAddr), path))
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

	/**	Stop serving requests on specified network address, or on all addresses.
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

	/**	Multiple event handlers can be added to each event type.

		`on('error', callback)` - catch FastCGI `Server` errors.
		`on('end', callback)` or `await on('end')` - catch that moment when FastCGI `Server` stops accepting connections (when all listeners removed, and ongoing requests completed).
	 **/
	on(event_name: string, callback?: any)
	{	let q = event_name=='error' ? this.onerror : event_name=='end' ? this.onend : undefined;
		return q?.add(callback);
	}

	/**	`off('error' | 'end', callback)` - remove this callback from specified event handler.
		`off('error' | 'end')` - remove all callbacks from specified event handler.
	 **/
	off(event_name: string, callback?: any)
	{	let q = event_name=='error' ? this.onerror : event_name=='end' ? this.onend : undefined;
		if (callback)
		{	q?.remove(callback);
		}
		else
		{	q?.clear();
		}
	}

	/**	Set and/or get FastCGI `Server` and/or `Client` options. You can call it at any time, but new options can take effect later, on new connections.
		It returns current options.
	 **/
	options(options?: ServerOptions & ClientOptions): ServerOptions & ClientOptions
	{	let server_options = this.server.options(options);
		let client_options = this.client.options(options);
		return {...server_options, ...client_options};
	}

	/**	Send request to a FastCGI service, like PHP, just like Apache and Nginx do.
		First argument (`server_options`) specifies how to connect to the service, and what parameters to send to it.
		2 most important parameters are `server_options.addr` (service socket address), and `server_options.scriptFilename` (path to script file that the service must execute).
		Second (`input`) and 3rd (`init`) arguments are the same as in built-in `fetch()` function, except that `init` allows to read request body from an `AsyncIterable<Uint8Array>` (`init.bodyIter`).
		Returned response object extends built-in `Response` (that regular `fetch()` returns) by adding `cookies` property, that contains all `Set-Cookie` headers.
		Also `response.body` object extends regular `ReadableStream<Uint8Array>` by adding `Deno.Reader` implementation.
		The response body must be explicitly read, before specified `server_options.timeout` period elapses. After this period, the connection will be forced to close.
		Each not closed connection counts towards `ClientOptions.maxConns`. After `response.body` read to the end, the connection returns to pool, and can be reused.
		Idle connections will be closed after `server_options.keepAliveTimeout` microseconds, and after `server_options.keepAliveMax` times used.
	 **/
	fetch(server_options: RequestOptions, input: Request|URL|string, init?: RequestInit & {bodyIter?: AsyncIterable<Uint8Array>}): Promise<ResponseWithCookies>
	{	return this.client.fetch(server_options, input, init);
	}

	fetchCapabilities(addr: FcgiAddr | Deno.Conn): Promise<{FCGI_MAX_CONNS?: number, FCGI_MAX_REQS?: number, FCGI_MPXS_CONNS?: number}>
	{	return this.client.fetchCapabilities(addr);
	}

	/**	`fetch()` and `fetchCapabilities()` throw Error if number of ongoing requests is more than the configured value (`maxConns`).
		`canFetch()` checks whether there are free slots, and returns true if so.
		It's recommended not to call `fetch()` untill `canFetch()` grants a green light.
		Example:

		while (!fcgi.canFetch())
		{	await fcgi.pollCanFetch();
		}
		await fcgi.fetch(...);
	 **/
	canFetch(): boolean
	{	return this.client.canFetch();
	}

	pollCanFetch(): Promise<void>
	{	return this.client.pollCanFetch();
	}
}

/**	`Fcgi` class provides top-level API, above `Server` and `Client`, and `fcgi` is default instance of `Fcgi`.

	// Create FastCGI backend server (another HTTP server will send requests to us)

	fcgi.listen
	(	8989,
		'/page-1.html',
		async req =>
		{	await req.respond({body: 'Hello world'});
		}
	);


	// Create FastCGI client for PHP

	import {serve} from "https://deno.land/std@0.92.0/http/server.ts";
	import {iter} from 'https://deno.land/std@0.95.0/io/util.ts';

	const PHP_POOL_CONFIG_FILE = '/etc/php/7.4/fpm/pool.d/www.conf';
	const DOCUMENT_ROOT = '/var/www/deno-server-root';

	// Read PHP service address from it's configuration file
	const CONF = Deno.readTextFileSync(PHP_POOL_CONFIG_FILE);
	const PHP_LISTEN = CONF.match(/(?:^|\r|\n)\s*listen\s*=\s*(\S+)/)?.[1];

	if (PHP_LISTEN)
	{	for await (let request of serve({hostname: "0.0.0.0", port: 8000}))
		{	queueMicrotask
			(	async () =>
				{	let url = new URL('http://' + request.headers.get('host') + request.url);
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
									bodyIter: iter(request.body), // request body as Uint8Array iterator
								}
							);
							console.log(response);

							// Pass the response to deno server
							await request.respond
							(	{	status: response.status,
									headers: response.headers,
									body: response.body ?? undefined, // response body as Deno.Reader
								}
							);
						}
						catch (e)
						{	console.error(e);
							await request.respond({status: 500, body: ''});
						}
					}
					else
					{	await request.respond({status: 404, body: 'Resource not found'});
					}
				}
			);
		}
	}
 **/
export const fcgi = new Fcgi;
