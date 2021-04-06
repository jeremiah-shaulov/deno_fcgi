import {debug_assert} from './debug_assert.ts';
import {ServerRequest, poll, takeNextRequest, isProcessing} from './server_request.ts';

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
{	public addr: Deno.Addr;
	public rid: number;

	private structuredParams: boolean;
	private maxConns: number;
	private maxNameLength: number;
	private maxValueLength: number;
	private maxFileSize: number;
	private promises: Promise<Deno.Conn | ServerRequest>[] = [];
	private requests: ServerRequest[] = [];
	private requests_processing: ServerRequest[] = [];
	private onerror: (error: Error) => void = () => {};
	private dont_accept = false;
	private n_processing = 0;

	constructor(private socket: Deno.Listener, options?: ServerOptions)
	{	this.addr = socket.addr;
		this.rid = socket.rid;
		this.structuredParams = options?.structuredParams || false;
		this.maxConns = options?.maxConns || MAX_CONNS;
		this.maxNameLength = options?.maxNameLength || MAX_NAME_LENGTH;
		this.maxValueLength = options?.maxValueLength || MAX_VALUE_LENGTH;
		this.maxFileSize = options?.maxFileSize || MAX_FILE_SIZE;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<ServerRequest>
	{	if (this.dont_accept)
		{	return;
		}

		let {socket, promises, requests, onerror, structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize} = this;
		maxConns |= 0;
		maxNameLength |= 0;
		maxValueLength |= 0;
		maxFileSize |= 0;

		if (promises.length == 0)
		{	promises[0] = socket.accept();
		}

		try
		{	while (promises.length != 0)
			{	debug_assert(requests.length <= maxConns);
				debug_assert(promises.length == (requests.length==maxConns || this.dont_accept ? requests.length : requests.length+1));

				// If requests.length+requests_processing.length < maxConns, then i can accept new connections,
				// and promises[promises.length-1] is a promise for accepting a new connection,
				// and promises.length == requests.length+1,
				// and each requests[i] corresponds to each promises[i].
				//
				// If requests.length+requests_processing.length == maxConns, then i cannot accept new connections,
				// and promises.length == requests.length.
				//
				// When accepted a connection (promises[promises.length-1] resolved), i create new "ServerRequest" object, and put it to "requests", and start polling this object, and poll promise i put to "promises".
				// When some ServerRequest is polled till completion of FCGI_BEGIN_REQUEST and FCGI_PARAMS, i remove it from "requests", and it's resolved promise from "promises",
				// and put this ServerRequest object to "requests_processing", and also yield this object to the caller.
				//
				// When the caller calls "respond()" or when i/o or protocol error occures, the "ServerRequest" object calls it's "close()", and the "close()" calls "onretired()".
				// When a request is retired, it's removed from "requests_processing".

				let ready = await Promise.race(promises);
				if (!(ready instanceof ServerRequest))
				{	// Accepted connection
					debug_assert(promises.length == requests.length+1);
					let request = new ServerRequest(ready, onerror, null, structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize);
					requests[requests.length] = request;
					promises[promises.length-1] = request[poll]();
					if (!this.dont_accept)
					{	if (requests.length < maxConns)
						{	// Immediately start waiting for new
							promises[promises.length] = socket.accept();
						}
						else
						{	// Take a break accepting new connections
							debug_assert(promises.length == requests.length);
						}
					}
				}
				else
				{	// Some ServerRequest is ready (params are read)
					let i = requests.indexOf(ready);
					if (i != -1)
					{	if (!ready.isTerminated())
						{	promises[i] = ready.complete();
							this.n_processing++;
							yield ready;
						}
						else
						{	let {next_request, next_request_ready} = ready[takeNextRequest]();
							if (next_request)
							{	if (!next_request_ready)
								{	// assume: `next_request_ready = next_request.poll(false)` bringed directly to `respond()`, before assigning
									requests[i] = next_request;
									promises[i] = next_request.complete();
									yield next_request;
								}
								else
								{	requests[i] = next_request;
									promises[i] = next_request_ready;
									this.n_processing--;
								}
							}
							else
							{	let j = requests.length - 1;
								requests[i] = requests[j];
								promises[i] = promises[j];
								if (promises.length != requests.length)
								{	debug_assert(promises.length == requests.length+1);
									promises[j] = promises[j+1];
								}
								requests.length--;
								promises.length--;
								if (ready[isProcessing]())
								{	this.n_processing--;
								}
							}
						}
					}
					else
					{	// assume: ready.is_terminated (poll() called onretired(), and then returned this object to Promise.race())
					}
				}
			}
		}
		catch (e)
		{	this.onerror(e);
			this.dont_accept = true;
		}

		debug_assert(this.dont_accept);
		socket.close();
		for (let result of await Promise.allSettled(promises))
		{	if (result.status == 'rejected')
			{	this.onerror(result.reason);
			}
		}
		debug_assert(requests.length == 0);
		promises.length = 0;
	}

	async accept(): Promise<ServerRequest>
	{	let it = this[Symbol.asyncIterator]();
		let {value, done} = await it.next();
		if (done)
		{	throw new Error('Server closed');
		}
		return value;
	}

	nAccepted()
	{	return this.requests.length;
	}

	nProcessing()
	{	return this.n_processing;
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

	stopAccepting()
	{	this.dont_accept = true;
		if (this.promises.length != this.requests.length)
		{	this.promises.length--; // drop promise to accept new connection
		}
	}

	close()
	{	this.dont_accept = true;
		for (let request of this.requests_processing)
		{	request.respond({status: 503, body: '', headers: new Headers});
		}
		for (let request of this.requests)
		{	request.close();
		}
	}
}
