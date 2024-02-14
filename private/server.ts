import {debug_assert} from './debug_assert.ts';
import {Conn, Listener} from './deno_ifaces.ts';
import {ServerRequest, poll, take_next_request, is_processing} from './server_request.ts';
import {is_default_route} from './addr.ts';

const DEFAULT_MAX_CONNS = 128;
const DEFAULT_MAX_NAME_LENGTH = 256;
const DEFAULT_MAX_VALUE_LENGTH = 4*1024; // "HTTP_COOKIE" param can have this length
const DEFAULT_MAX_FILE_SIZE = 1*1024*1024;

export interface ServerOptions
{	structuredParams?: boolean,
	maxConns?: number,
	maxNameLength?: number,
	maxValueLength?: number,
	maxFileSize?: number,
}

class AcceptError
{	constructor(public listener: Listener, public error: Error)
	{
	}
}

export class Server implements Listener
{	readonly addr: Deno.Addr;
	readonly rid: number;

	private listeners: Listener[];
	private active_listeners = new Array<Listener>;
	private removed_listeners = new Array<Listener>;
	private structuredParams: boolean;
	private maxConns: number;
	private maxNameLength: number;
	private maxValueLength: number;
	private maxFileSize: number;
	private promises = new Array<Promise<Conn | ServerRequest | AcceptError>>;
	private requests = new Array<ServerRequest>;
	private onerror: (error: Error) => void = () => {};
	private is_accepting = false;
	private n_processing = 0;

	constructor(listener?: Listener, options?: ServerOptions)
	{	this.addr = listener?.addr ?? {transport: 'tcp', hostname: 'localhost', port: NaN};
		this.rid = listener?.rid ?? -1;
		this.listeners = listener ? [listener] : [];
		this.structuredParams = options?.structuredParams || false;
		this.maxConns = options?.maxConns || DEFAULT_MAX_CONNS;
		this.maxNameLength = options?.maxNameLength || DEFAULT_MAX_NAME_LENGTH;
		this.maxValueLength = options?.maxValueLength || DEFAULT_MAX_VALUE_LENGTH;
		this.maxFileSize = options?.maxFileSize || DEFAULT_MAX_FILE_SIZE;
	}

	/**	Set and/or get configuration.
	 **/
	options(options?: ServerOptions): ServerOptions
	{	this.structuredParams = options?.structuredParams ?? this.structuredParams;
		this.maxConns = options?.maxConns ?? this.maxConns;
		this.maxNameLength = options?.maxNameLength ?? this.maxNameLength;
		this.maxValueLength = options?.maxValueLength ?? this.maxValueLength;
		this.maxFileSize = options?.maxFileSize ?? this.maxFileSize;
		const {structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize} = this;
		return {structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize};
	}

	/**	`onError(callback)` - catch general connection errors. Only one handler is active. Second `onError(callback2)` overrides the previous handler.
		`onError(undefined)` - removes the event handler.
	 **/
	onError(callback?: (error: Error) => unknown)
	{	this.onerror = !callback ? () => {} : error =>
		{	try
			{	const result = callback(error);
				if (result instanceof Promise)
				{	result.catch(e => console.error(e));
				}
			}
			catch (e)
			{	console.error(e);
			}
		};
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<ServerRequest>
	{	while (true)
		{	try
			{	yield await this.accept();
			}
			catch (e)
			{	if (this.listeners.length==0 && this.promises.length==0)
				{	break;
				}
				throw e;
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

		function find_listener(conn: Conn)
		{	const {transport} = conn.localAddr;
			if (transport == 'tcp')
			{	const {hostname, port} = conn.localAddr;
				return active_listeners.findIndex
				(	l => l.addr.transport=='tcp' && l.addr.port===port && (l.addr.hostname===hostname || is_default_route(l.addr.hostname))
				);
			}
			else if (transport == 'unix')
			{	const {path} = conn.localAddr;
				return active_listeners.findIndex
				(	l => l.addr.transport=='unix' && l.addr.path===path
				);
			}
			else
			{	return -1;
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

			let can_add_all = true;
			let to = requests.length + listeners.length;
			if (to > maxConns)
			{	to = maxConns;
				can_add_all = false;
			}
			if (promises.length < to)
			{	if (!can_add_all && listeners.length>1)
				{	// shuffle listeners to establish equal rights
					shuffle_array(listeners);
				}
				for (const listener of listeners)
				{	if (active_listeners.indexOf(listener) == -1)
					{	active_listeners.push(listener);
						promises.push(listener.accept().catch(error => new AcceptError(listener, error)));
						if (promises.length >= to)
						{	break;
						}
					}
				}
			}
			this.clear_removed_listeners();
			if (promises.length == 0)
			{	debug_assert(active_listeners.length==0 && listeners.length==0 && removed_listeners.length==0 && requests.length==0);
				this.is_accepting = false;
				throw new Error('Server shut down');
			}

			debug_assert(promises.length == requests.length + active_listeners.length);
			debug_assert(this.n_processing>=0 && this.n_processing<=requests.length);

			const ready = await Promise.race(promises);
			if (ready instanceof AcceptError)
			{	if (listeners.indexOf(ready.listener) != -1)
				{	this.onerror(ready.error);
					this.removeListener(ready.listener.addr);
				}
				debug_assert(active_listeners.indexOf(ready.listener) == -1);
			}
			else if (!(ready instanceof ServerRequest))
			{	// Accepted connection
				const i = find_listener(ready);
				if (i == -1)
				{	// assume: the listener removed
					try
					{	ready.close();
					}
					catch (e)
					{	this.onerror(e);
					}
				}
				else
				{	const request = new ServerRequest(ready, onerror, null, structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize);
					const j = requests.length;
					requests[j] = request;
					promises[j+i] = promises[j];
					promises[j] = request[poll]();
					const listener = active_listeners[i];
					active_listeners[i] = active_listeners[0];
					active_listeners.shift();
					if (j+1+listeners.length < maxConns)
					{	active_listeners.push(listener);
						promises.push(listener.accept().catch(error => new AcceptError(listener, error)));
					}
				}
			}
			else
			{	// Some ServerRequest is ready (params are read)
				const i = requests.indexOf(ready);
				debug_assert(i != -1);
				if (!ready.isTerminated())
				{	promises[i] = ready.complete();
					this.n_processing++;
					this.is_accepting = false;
					return ready;
				}
				else
				{	const {next_request, next_request_ready} = ready[take_next_request]();
					if (next_request)
					{	// update requests[i] with new request
						debug_assert(next_request_ready);
						requests[i] = next_request;
						promises[i] = next_request_ready;
						this.n_processing--;
					}
					else
					{	// remove requests[i]
						const j = requests.length - 1;
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

	addListener(listener: Listener)
	{	let i = -1;
		// Find in "listeners"
		const {transport} = listener.addr;
		if (transport == 'tcp')
		{	const {hostname, port} = listener.addr;
			i = this.listeners.findIndex(l => l.addr.transport==='tcp' && l.addr.port===port && l.addr.hostname===hostname);
		}
		else if (transport == 'unix')
		{	const {path} = listener.addr;
			i = this.listeners.findIndex(l => l.addr.transport==='unix' && l.addr.path===path);
		}
		else
		{	throw new Error(`Must be TCP or UNIX-socket listener`);
		}
		// Already added?
		if (i != -1)
		{	// Yes
			return false;
		}
		// Add
		this.listeners.push(listener);
		return true;
	}

	getListener(addr: Deno.Addr)
	{	const {transport} = addr;
		if (transport == 'tcp')
		{	const {hostname, port} = addr;
			return this.listeners.find(l => l.addr.transport==='tcp' && l.addr.port===port && l.addr.hostname===hostname);
		}
		else if (transport == 'unix')
		{	const {path} = addr;
			return this.listeners.find(l => l.addr.transport==='unix' && l.addr.path===path);
		}
	}

	removeListener(addr: Deno.Addr)
	{	let i = -1;
		// Find in "listeners"
		const {transport} = addr;
		if (transport == 'tcp')
		{	const {hostname, port} = addr;
			i = this.listeners.findIndex(l => l.addr.transport==='tcp' && l.addr.port===port && l.addr.hostname===hostname);
		}
		else if (transport == 'unix')
		{	const {path} = addr;
			i = this.listeners.findIndex(l => l.addr.transport==='unix' && l.addr.path===path);
		}
		// Not found?
		if (i == -1)
		{	// Yes
			return false;
		}
		// Found
		const listener = this.listeners[i];
		// Remove from "listeners"
		this.listeners.splice(i, 1);
		// Find in "active_listeners"
		i = -1;
		if (transport == 'tcp')
		{	const {hostname, port} = addr;
			i = this.active_listeners.findIndex(l => l.addr.transport==='tcp' && l.addr.port===port && l.addr.hostname===hostname);
		}
		else if (transport == 'unix')
		{	const {path} = addr;
			i = this.active_listeners.findIndex(l => l.addr.transport==='unix' && l.addr.path===path);
		}
		if (i != -1)
		{	// Found, so remove from "active_listeners" and corresponding "promises"
			this.active_listeners.splice(i, 1);
			this.promises.splice(this.requests.length+i, 1);
		}
		this.removed_listeners.push(listener);
		this.clear_removed_listeners();
		return true;
	}

	removeListeners()
	{	while (this.listeners.length)
		{	this.removeListener(this.listeners[0].addr);
		}
	}

	clear_removed_listeners()
	{	const {removed_listeners, requests} = this;
		for (let i=0; i<removed_listeners.length; i++)
		{	const {addr} = removed_listeners[i];
			const {transport} = addr;
			let is_def = false;
			let j = -1;
			if (transport == 'tcp')
			{	const {hostname, port} =addr;
				is_def = is_default_route(hostname);
				j = requests.findIndex
				(	l => l.localAddr.transport==='tcp' && l.localAddr.port===port && (is_def || l.localAddr.hostname===hostname)
				);
			}
			else if (transport == 'unix')
			{	const {path} = addr;
				j = requests.findIndex
				(	l => l.localAddr.transport==='unix' && l.localAddr.path===path
				);
			}
			if (j == -1)
			{	removed_listeners[i].close();
				removed_listeners[i--] = removed_listeners[removed_listeners.length - 1];
				removed_listeners.length--;
			}
		}
	}

	close()
	{	this.removeListeners();
		for (const request of this.requests)
		{	if (request[is_processing]())
			{	request.respond({status: 503, body: '', headers: new Headers}).catch(this.onerror).then(() => {request.close()});
			}
			else
			{	request.close();
			}
		}
	}
}

function shuffle_array<T>(arr: T[])
{	for (let i=arr.length-1; i>0; i--)
	{	const j = Math.floor(Math.random() * (i + 1));
		const tmp = arr[i];
		arr[i] = arr[j];
		arr[j] = tmp;
	}
}
