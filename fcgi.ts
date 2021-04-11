import {Server, ServerRequest} from './mod.ts';
import {pathToRegexp} from "https://deno.land/x/path_to_regexp@v6.2.0/index.ts";

export type FcgiAddr = number | string | Deno.Addr;

type Callback = (request: ServerRequest, params: any) => Promise<unknown>;
type PathPattern = string | string[] | RegExp;
type Route = {addr_str: string, regexp: RegExp | undefined, param_names: string[], callback: Callback};

class Routes extends Map<string, Map<string, Route[]>>
{	add_route(addr_str: string, path_pattern: PathPattern, callback: Callback)
	{	let prefix = '';
		let suffix = '';
		let regexp: RegExp | undefined;
		let param_names: string[] = [];
		if (path_pattern)
		{	let params: {name: string}[] = [];
			regexp = pathToRegexp(path_pattern, params as any);
			param_names = params.map(v => v.name);
			let {source} = regexp;
			let re_prefix = source.match(/^(?:[^\\\[\](){}<>^$|?+*]|\\[\S\s])*/)![0];
			let re_suffix = source.slice(re_prefix.length).match(/(?:[^\\\[\](){}<>^$|?+*]|\\[\S\s])*$/)![0];
			source = source.slice(re_prefix.length, source.length-re_suffix.length);
			regexp = source ? new RegExp(source, regexp.flags) : undefined;
			prefix = re_prefix.replace(/\\[\S\s]/g, m => m.charAt(1));
			suffix = re_suffix.replace(/\\[\S\s]/g, m => m.charAt(1));
		}
		// add
		let level_1 = this.get(prefix);
		if (level_1 == undefined)
		{	level_1 = new Map<string, Route[]>();
			this.set(prefix, level_1);
		}
		let level_2 = level_1.get(suffix);
		if (level_2 == undefined)
		{	level_2 = [];
			level_1.set(suffix, level_2);
		}
		level_2.push({addr_str, regexp, param_names, callback});
	}

	*get_callback_and_params(addr_str: string, path: string)
	{	for (let [prefix, level_1] of this)
		{	if (path.startsWith(prefix))
			{	for (let [suffix, level_2] of level_1)
				{	if (path.endsWith(suffix))
					{	for (let {addr_str: a, regexp, param_names, callback} of level_2)
						{	if (addr_str == a)
							{	if (!regexp)
								{	yield {callback, params: {}};
								}
								else
								{	let m = path.match(regexp);
									if (m)
									{	let params: any = {};
										for (let i=0, i_end=param_names.length; i<i_end; i++)
										{	params[param_names[i]] = m[i+1];
										}
										yield {callback, params};
									}
								}
							}
						}
					}
				}
			}
		}
	}

	remove_addr(addr_str: string)
	{	let to_remove_0 = [];
		for (let [prefix, level_1] of this)
		{	let to_remove_1 = [];
			for (let [suffix, level_2] of level_1)
			{	for (let i=level_2.length-1; i>=0; i--)
				{	if (level_2[i].addr_str == addr_str)
					{	level_2.splice(i, 1);
					}
				}
				if (level_2.length == 0)
				{	to_remove_1.push(suffix);
				}
			}
			for (let suffix of to_remove_1)
			{	level_1.delete(suffix);
			}
			if (level_1.size == 0)
			{	to_remove_0.push(prefix);
			}
		}
		for (let prefix of to_remove_0)
		{	this.delete(prefix);
		}
	}
}

class Fcgi
{	private server: Server | undefined;
	private routes = new Routes;
	private onerror: ((error: Error) => void)[] = [];
	private onend: (() => void)[] = [];

	listen(addr_or_listener: FcgiAddr | Deno.Listener, path_pattern: PathPattern, callback: Callback)
	{	if (typeof(addr_or_listener)=='object' && (addr_or_listener as Deno.Listener).addr)
		{	var addr = (addr_or_listener as Deno.Listener).addr;
			var listener = addr_or_listener as Deno.Listener;
		}
		else
		{	addr = fcgi_addr_to_addr(addr_or_listener as FcgiAddr);
			if (addr.transport == 'tcp')
			{	listener = Deno.listen({transport: 'tcp', port: addr.port, hostname: addr.hostname});
			}
			else if (addr.transport == 'unix')
			{	listener = Deno.listen({transport: 'unix', path: addr.path});
			}
			else
			{	throw new Error('Can only listen to tcp/unix');
			}
		}
		this.routes.add_route(addr_to_string(addr), path_pattern, callback);
		if (this.server)
		{	this.server.addListener(listener);
		}
		else
		{	let server = new Server(listener);
			let that = this;
			function trigger_onerror(error: Error)
			{	for (let oe of that.onerror)
				{	try
					{	oe(error);
					}
					catch (e)
					{	console.error(e);
					}
				}
			}
			function trigger_onend()
			{	for (let oe of that.onend)
				{	try
					{	oe();
					}
					catch (e)
					{	console.error(e);
					}
				}
			}
			server.on('error', trigger_onerror);
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
										{	trigger_onerror(e);
											try
											{	await request.respond({status: 500, body: ''});
											}
											catch (e2)
											{	trigger_onerror(e2);
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
					{	trigger_onerror(e);
					}
					server.removeListeners();
					this.routes.clear();
					this.server = undefined;
					trigger_onend();
				}
			)();
		}
		return listener;
	}

	unlisten(addr?: FcgiAddr)
	{	if (this.server)
		{	if (addr == undefined)
			{	this.server.removeListeners();
			}
			else
			{	addr = fcgi_addr_to_addr(addr);
				this.server.removeListener(addr);
				this.routes.remove_addr(addr_to_string(addr));
			}
		}
	}

	on(event_name: string, callback: any)
	{	if (event_name == 'error')
		{	this.onerror.push(callback);
		}
		else if (event_name == 'end')
		{	this.onend.push(callback);
		}
	}
}

export const fcgi = new Fcgi;

function fcgi_addr_to_addr(addr: FcgiAddr): Deno.Addr
{	if (typeof(addr) == 'number')
	{	addr = {transport: 'tcp', hostname: '0.0.0.0', port: addr};
	}
	else if (typeof(addr) == 'string')
	{	if (addr.indexOf('/') != -1)
		{	addr = {transport: 'unix', path: addr};
		}
		else if (/^\s*\d+\s*$/.test(addr))
		{	addr = {transport: 'tcp', hostname: '0.0.0.0', port: parseInt(addr)};
		}
		else
		{	let pos = addr.lastIndexOf(':');
			if (pos>0 && addr.charAt(pos-1)!=':')
			{	let port = parseInt(addr.slice(pos+1));
				if (addr.charAt(0)=='[' && addr.charAt(pos-1)==']')
				{	// assume: IPv6 address, like [::1]:10000
					var hostname = addr.slice(1, pos-1);
				}
				else
				{	hostname = addr.slice(0, pos);
				}
				addr = {transport: 'tcp', hostname, port};
			}
			else
			{	throw new Error(`Cannot interpret network address: ${JSON.stringify(addr)}`);
			}
		}
	}
	return addr;
}

function addr_to_string(addr: Deno.Addr)
{	if (addr.transport == 'tcp')
	{	return (addr.hostname.indexOf(':')==-1 ? addr.hostname+':' : '['+addr.hostname+']:') + addr.port;
	}
	else if (addr.transport == 'unix')
	{	return addr.path;
	}
	return '';
}
