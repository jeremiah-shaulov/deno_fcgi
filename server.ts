import {debug_assert} from './debug_assert.ts';
import {ServerRequest, poll, take_next_request, is_processing} from './server_request.ts';

const MAX_CONNS = 128;
const MAX_NAME_LENGTH = 256;
const MAX_VALUE_LENGTH = 256;
const MAX_FILE_SIZE = 256;

export interface ServerOptions
{	structuredParams?: boolean,
	maxConns?: number,
	maxNameLength?: number,
	maxValueLength?: number,
	maxFileSize?: number,
}

export class Server implements Deno.Listener
{	public readonly addr: Deno.Addr;
	public readonly rid: number;

	private listeners: Deno.Listener[];
	private active_listeners: Deno.Listener[] = [];
	private removed_listeners: Deno.Listener[] = [];
	private structuredParams: boolean;
	private maxConns: number;
	private maxNameLength: number;
	private maxValueLength: number;
	private maxFileSize: number;
	private promises: Promise<Deno.Conn | ServerRequest>[] = [];
	private requests: ServerRequest[] = [];
	private onerror: (error: Error) => void = () => {};
	private is_accepting = false;
	private n_processing = 0;

	constructor(listener: Deno.Listener, options?: ServerOptions)
	{	this.addr = listener.addr;
		this.rid = listener.rid;
		this.listeners = [listener];
		this.structuredParams = options?.structuredParams || false;
		this.maxConns = options?.maxConns || MAX_CONNS;
		this.maxNameLength = options?.maxNameLength || MAX_NAME_LENGTH;
		this.maxValueLength = options?.maxValueLength || MAX_VALUE_LENGTH;
		this.maxFileSize = options?.maxFileSize || MAX_FILE_SIZE;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<ServerRequest>
	{	while (true)
		{	try
			{	yield await this.accept();
			}
			catch (e)
			{	debug_assert(this.listeners.length==0 && this.promises.length==0);
				break;
			}
		}
	}

	async accept(): Promise<ServerRequest>
	{	if (this.is_accepting)
		{	throw new Error('Busy: Another accept task is ongoing');
		}

		let {listeners, active_listeners, removed_listeners, promises, requests, onerror, structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize} = this;

		if (maxConns < listeners.length)
		{	maxConns = listeners.length;
		}

		this.is_accepting = true;

		function find_listener(conn: Deno.Conn)
		{	let {transport, hostname, port, path} = conn.remoteAddr as any;
			let i = active_listeners.length==1 ? 0 : active_listeners.findIndex
			(	l =>
				{	let addr = l.addr as any;
					return addr.port===port && addr.path===path && addr.hostname===hostname && addr.transport===transport
				}
			);
			return i;
		}

		function clear_removed_listeners()
		{	for (let i=0; i<removed_listeners.length; i++)
			{	let {transport, hostname, port, path} = removed_listeners[i].addr as any;
				let j = requests.findIndex
				(	l =>
					{	let l_addr = l.remoteAddr as any;
						return l_addr.port===port && l_addr.path===path && l_addr.hostname===hostname && l_addr.transport===transport
					}
				);
				if (j == -1)
				{	removed_listeners[i--] = removed_listeners[removed_listeners.length - 1];
					removed_listeners.length--;
				}
			}
		}

		while (true)
		{	// "listeners" are all available listeners, added with "addListener()" (plus one passed to the constructor), and not yet removed with "removeListener()".
			// When i call "accept()" on some listener, i add it to "active_listeners".
			//
			// If requests.length < maxConns, then i can accept new connections (and add them to "active_listeners"),
			// and promises[promises.length - active_listeners.length .. promises.length] are promises that "accept()" returned for each corresponding listener from "active_listeners",
			// and promises.length == requests.length + active_listeners.length,
			// and each requests[i] corresponds to each promises[i].
			//
			// When accepted a connection (one of promises[promises.length - active_listeners.length .. promises.length] resolved),
			// i create new "ServerRequest" object, and add it to "requests", and start polling this object, and add the poll promise to "promises".
			// When some ServerRequest is polled till completion of FCGI_BEGIN_REQUEST and FCGI_PARAMS, i return this object to the caller,
			// but before returning i start polling it for termination ("respond()"), and put the poll promise to "promises" overriding the previous (resolved) poll promise.
			//
			// When the caller calls "respond()" or when i/o or protocol error occures, the "ServerRequest" object resolves its "complete_promise", and i remove this terminated request from "requests", and from "promises".

			let to = Math.min(maxConns, requests.length + listeners.length);
			if (promises.length < to)
			{	for (let listener of listeners)
				{	if (active_listeners.indexOf(listener) == -1)
					{	active_listeners.push(listener);
						promises.push(listener.accept());
						if (promises.length >= to)
						{	break;
						}
					}
				}
			}
			clear_removed_listeners();
			if (promises.length == 0)
			{	debug_assert(active_listeners.length==0 && listeners.length==0 && removed_listeners.length==0 && requests.length==0);
				throw new Error('Server shut down');
			}

			debug_assert(promises.length == requests.length + active_listeners.length);
			debug_assert(this.n_processing>=0 && this.n_processing<=requests.length);

			let ready = await Promise.race(promises);
			if (!(ready instanceof ServerRequest))
			{	// Accepted connection
				let i = find_listener(ready);
				if (i == -1)
				{	// assume: the listener removed
					ready.close();
				}
				else
				{	let request = new ServerRequest(ready, onerror, null, structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize);
					let j = requests.length;
					requests[j] = request;
					promises[j+i] = promises[j];
					promises[j] = request[poll]();
					let listener = active_listeners[i];
					active_listeners[i] = active_listeners[0];
					active_listeners.shift();
					if (j+1+listeners.length < maxConns)
					{	active_listeners.push(listener);
						promises.push(listener.accept());
					}
				}
			}
			else
			{	// Some ServerRequest is ready (params are read)
				let i = requests.indexOf(ready);
				debug_assert(i != -1);
				if (!ready.isTerminated())
				{	promises[i] = ready.complete();
					this.n_processing++;
					this.is_accepting = false;
					return ready;
				}
				else
				{	let {next_request, next_request_ready} = ready[take_next_request]();
					if (next_request)
					{	// update requests[i] with new request
						debug_assert(next_request_ready);
						requests[i] = next_request;
						promises[i] = next_request_ready;
						this.n_processing--;
					}
					else
					{	// remove requests[i]
						let j = requests.length - 1;
						requests[i] = requests[j];
						promises[i] = promises[j];
						if (promises.length != requests.length)
						{	debug_assert(promises.length == requests.length+active_listeners.length);
							promises[j] = promises[promises.length-1];
							if (active_listeners.length > 1)
							{	active_listeners.unshift(active_listeners.pop()!);
							}
						}
						requests.length--;
						promises.length--;
						if (ready[is_processing]())
						{	this.n_processing--;
						}
					}
				}
			}
		}
	}

	nConnections()
	{	return this.requests.length;
	}

	nRequests()
	{	return this.n_processing;
	}

	addListener(listener: Deno.Listener)
	{	let {transport, hostname, port, path} = listener.addr as any;
		// find in "listeners"
		let i = this.listeners.findIndex
		(	l =>
			{	let l_addr = l.addr as any;
				return l_addr.port===port && l_addr.path===path && l_addr.hostname===hostname && l_addr.transport===transport
			}
		);
		if (i != -1)
		{	// already added
			return false;
		}
		this.listeners.push(listener);
		return true;
	}

	removeListener(addr: Deno.Addr)
	{	let {transport, hostname, port, path} = addr as any;
		// find in "listeners"
		let i = this.listeners.findIndex
		(	l =>
			{	let l_addr = l.addr as any;
				return l_addr.port===port && l_addr.path===path && l_addr.hostname===hostname && l_addr.transport===transport
			}
		);
		if (i == -1)
		{	// not found
			return false;
		}
		// found
		let listener = this.listeners[i];
		// remove from "listeners"
		this.listeners.splice(i, 1);
		// find in "active_listeners"
		i = this.active_listeners.findIndex
		(	l =>
			{	let l_addr = l.addr as any;
				return l_addr.port===port && l_addr.path===path && l_addr.hostname===hostname && l_addr.transport===transport
			}
		);
		if (i != -1)
		{	// found, so remove from "active_listeners" and corresponding "promises"
			this.active_listeners.splice(i, 1);
			this.promises.splice(this.requests.length+i, 1);
		}
		// some ongoing request belongs to this listener?
		i = this.requests.findIndex
		(	l =>
			{	let l_addr = l.remoteAddr as any;
				return l_addr.port===port && l_addr.path===path && l_addr.hostname===hostname && l_addr.transport===transport
			}
		);
		if (i == -1)
		{	// not found, so can close
			listener.close();
		}
		else
		{	this.removed_listeners.push(listener);
		}
		return true;
	}

	removeListeners()
	{	while (this.listeners.length)
		{	this.removeListener(this.listeners[0].addr);
		}
	}

	on(event_name: string, callback: (error: Error) => void)
	{	if (event_name == 'error')
		{	this.onerror = error =>
			{	try
				{	callback(error);
				}
				catch (e)
				{	console.error(e);
				}
			};
		}
	}

	close()
	{	this.removeListeners();
		for (let request of this.requests)
		{	if (request[is_processing]())
			{	request.respond({status: 503, body: '', headers: new Headers}).catch(this.onerror).then(() => {request.close()});
			}
			else
			{	request.close();
			}
		}
	}
}
