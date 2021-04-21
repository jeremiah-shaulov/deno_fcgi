import {Server, ServerOptions} from './server.ts';
import {faddr_to_addr, addr_to_string} from './addr.ts';
import type {FcgiAddr} from './addr.ts';
import {Routes} from './routes.ts';
import type {Callback, PathPattern} from './routes.ts';
import {Client, RequestOptions, ResponseWithCookies} from './client.ts';
import {EventPromises} from './event_promises.ts';

class Fcgi
{	private init_options: ServerOptions = {};
	private server: Server | undefined;
	private routes = new Routes;
	private onerror = new EventPromises<Error>();
	private onend = new EventPromises<void>();
	private client = new Client;

	/**	Register a FastCGI `Server` on specified network address.
		This function can be called multiple times with the same or different addresses.
	 **/
	listen(addr_or_listener: FcgiAddr | Deno.Listener, path_pattern: PathPattern, callback: Callback)
	{	if (typeof(addr_or_listener)=='object' && (addr_or_listener as Deno.Listener).addr)
		{	var listener = addr_or_listener as Deno.Listener;
		}
		else
		{	let addr = faddr_to_addr(addr_or_listener as FcgiAddr);
			let found_listener = this.server?.getListener(addr);
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
		if (this.server)
		{	this.server.addListener(listener);
		}
		else
		{	let server = new Server(listener, this.init_options);
			server.on('error', e => {this.onerror.trigger(e)});
			this.server = server;
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
											try
											{	await request.respond({status: 500, body: ''});
											}
											catch (e2)
											{	this.onerror.trigger(e2);
											}
										}
										if (request.isTerminated())
										{	return;
										}
									}
									request.respond({status: 404, body: 'Resource not found'});
								}
							);
						}
					}
					catch (e)
					{	this.onerror.trigger(e);
					}
					server.removeListeners();
					this.routes.clear();
					this.server = undefined;
					this.onend.trigger();
					this.onend.clear();
				}
			)();
		}
		return listener;
	}

	/**	Stop serving requests on specified network address.
	 **/
	unlisten(addr?: FcgiAddr)
	{	if (this.server)
		{	if (addr == undefined)
			{	this.server.removeListeners();
			}
			else
			{	addr = faddr_to_addr(addr);
				this.server.removeListener(addr);
				this.routes.remove_addr(addr_to_string(addr));
			}
		}
	}

	/**	`on('error', callback)` - catch FastCGI `Server` errors.
		`on('end', callback)` or `await on('end')` - catch that moment when FastCGI `Server` stops accepting connections (when all listeners removed, and ongoing requests completed).
	 **/
	on(event_name: string, callback?: any)
	{	if (event_name == 'error')
		{	return this.onerror.add(callback);
		}
		else if (event_name == 'end')
		{	return this.onend.add(callback);
		}
	}

	/**	Modify FastCGI `Server` options. This can be done at any time, but the new options can take effect later, on new connections.
	 **/
	options(options: ServerOptions): ServerOptions
	{	if (this.server)
		{	this.init_options = this.server.options(options);
		}
		else
		{	let {structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize} = options;
			let {init_options} = this;
			if (structuredParams != undefined)
			{	init_options.structuredParams = structuredParams;
			}
			if (maxConns != undefined)
			{	init_options.maxConns = maxConns;
			}
			if (maxNameLength != undefined)
			{	init_options.maxNameLength = maxNameLength;
			}
			if (maxValueLength != undefined)
			{	init_options.maxValueLength = maxValueLength;
			}
			if (maxFileSize != undefined)
			{	init_options.maxFileSize = maxFileSize;
			}
		}
		let {structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize} = this.init_options;
		return {structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize};
	}

	fetch(server_options: RequestOptions, input: Request|URL|string, init?: RequestInit): Promise<ResponseWithCookies>
	{	return this.client.fetch(server_options, input, init);
	}

	fetchCapabilities(addr: FcgiAddr): Promise<{FCGI_MAX_CONNS?: number, FCGI_MAX_REQS?: number, FCGI_MPXS_CONNS?: number}>
	{	return this.client.fetch_capabilities(addr);
	}
}

export const fcgi = new Fcgi;
