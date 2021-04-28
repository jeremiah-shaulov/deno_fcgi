import {Server, ServerOptions} from './server.ts';
import {faddr_to_addr, addr_to_string} from './addr.ts';
import type {FcgiAddr} from './addr.ts';
import {Routes} from './routes.ts';
import type {Callback, PathPattern} from './routes.ts';
import {Client, ResponseWithCookies} from './client.ts';
import type {ClientOptions, RequestOptions} from './client.ts';
import {EventPromises} from './event_promises.ts';

const DEFAULT_404_PAGE = 'Resource not found';

export class Fcgi
{	private server = new Server;
	private is_serving = false;
	private routes = new Routes;
	private onerror = new EventPromises<Error>();
	private onend = new EventPromises<void>();
	private client = new Client;

	constructor()
	{	this.server.on('error', e => {this.onerror.trigger(e)});
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

	fetch(server_options: RequestOptions, input: Request|URL|string, init?: RequestInit): Promise<ResponseWithCookies>
	{	return this.client.fetch(server_options, input, init);
	}

	fetchCapabilities(addr: FcgiAddr | Deno.Conn): Promise<{FCGI_MAX_CONNS?: number, FCGI_MAX_REQS?: number, FCGI_MPXS_CONNS?: number}>
	{	return this.client.fetchCapabilities(addr);
	}

	/**	`fetch()` and `fetchCapabilities()` throw Error if number of ongoing requests is more than the configured value (`maxConns`).
		`canFetch()` checks whether there are free slots, and returns true if so.
		It's recommended not to call `fetch()` untill `canFetch()` grants a green light.
		Example:
		```
		while (!fcgi.canFetch())
		{	await fcgi.pollCanFetch();
		}
		await fcgi.fetch(...);
		```
	 **/
	canFetch(): boolean
	{	return this.client.canFetch();
	}

	pollCanFetch(): Promise<void>
	{	return this.client.pollCanFetch();
	}
}

export const fcgi = new Fcgi;
