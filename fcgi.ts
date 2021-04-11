import {Server, ServerRequest} from './mod.ts';

export type FcgiAddr = number | string | Deno.Addr;

type Callback = (request: ServerRequest) => Promise<unknown>;

class Fcgi
{	private server: Server | undefined;
	private callbacks: {addr: Deno.Addr, callback: Callback}[] = [];
	private onerror: ((error: Error) => void)[] = [];
	private onend: (() => void)[] = [];

	listen(addr_or_listener: FcgiAddr | Deno.Listener, callback: Callback)
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
		this.callbacks.push({addr, callback});
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
					{	L:for await (let request of server)
						{	for (let {callback} of this.callbacks)
							{	try
								{	await callback(request);
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
								{	continue L;
								}
							}
							request.respond({status: 404, body: 'Resource not found'});
						}
					}
					catch (e)
					{	trigger_onerror(e);
					}
					server.removeListeners();
					this.callbacks.length = 0;
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
				// remove callbacks
				let {transport, hostname, port, path} = addr as any;
				let to_remove = this.callbacks.filter
				(	callback =>
					{	let l_addr = callback.addr as any;
						return l_addr.port===port && l_addr.path===path && l_addr.hostname===hostname && l_addr.transport===transport;
					}
				);
				setTimeout
				(	() =>
					{	for (let i=this.callbacks.length-1; i>=0; i--)
						{	if (to_remove.indexOf(this.callbacks[i]) != -1)
							{	this.callbacks.splice(i, 1);
							}
						}
					},
					1000
				);
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
	{	if (addr.charAt(0) == '/')
		{	addr = {transport: 'unix', path: addr};
		}
		else
		{	let n = parseInt(addr);
			if (!Number.isNaN(n))
			{	addr = {transport: 'tcp', hostname: '0.0.0.0', port: n};
			}
			else
			{	throw new Error(`Cannot interpret network address: ${JSON.stringify(addr)}`);
			}
		}
	}
	return addr;
}
