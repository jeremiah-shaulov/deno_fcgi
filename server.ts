import {assert} from './assert.ts';
import {ServerRequest} from './server_request.ts';

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

export class Server
{	private structuredParams: boolean;
	private maxConns: number;
	private maxNameLength: number;
	private maxValueLength: number;
	private maxFileSize: number;
	private promises: Promise<Deno.Conn | ServerRequest>[] = [];
	private requests: ServerRequest[] = [];
	private requests_processing: ServerRequest[] = [];
	private onerror: (error: Error) => void = () => {};
	private is_closed = false;

	constructor(private socket: Deno.Listener, options?: ServerOptions)
	{	this.structuredParams = options?.structuredParams || false;
		this.maxConns = options?.maxConns || MAX_CONNS;
		this.maxNameLength = options?.maxNameLength || MAX_NAME_LENGTH;
		this.maxValueLength = options?.maxValueLength || MAX_VALUE_LENGTH;
		this.maxFileSize = options?.maxFileSize || MAX_FILE_SIZE;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<ServerRequest>
	{	let {socket, promises, requests, requests_processing, onerror, structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize} = this;
		maxConns |= 0;
		maxNameLength |= 0;
		maxValueLength |= 0;
		maxFileSize |= 0;
		let that = this;

		function onretired(request: ServerRequest, new_request?: ServerRequest)
		{	let i = requests_processing.indexOf(request);
			if (i == -1)
			{	if (that.is_closed)
				{	i = requests.indexOf(request);
				}
				if (i == -1)
				{	onerror(new Error('retired(): request not found'));
				}
				else
				{	let j = promises.length==requests.length ? i : i+1;
					requests[i] = requests[requests.length-1];
					promises[j] = promises[promises.length-1];
					requests.length--;
					promises.length--;
				}
			}
			else
			{	if (promises.length == requests.length)
				{	assert(requests.length + requests_processing.length == maxConns);
					if (new_request)
					{	requests[requests.length] = new_request;
						promises[promises.length] = new_request.poll();
					}
					else
					{	promises[promises.length] = socket.accept();
					}
				}
				else if (new_request)
				{	assert(promises.length == requests.length+1);
					let j = requests.length;
					requests[j] = new_request;
					promises[j+1] = promises[j];
					promises[j] = new_request.poll();
				}
				requests_processing[i] = requests_processing[requests_processing.length-1];
				requests_processing.length--;
				assert(requests.length + requests_processing.length <= maxConns);
			}
		}

		if (promises.length == 0)
		{	promises[0] = socket.accept();
		}

		while (!this.is_closed)
		{	assert(requests.length+requests_processing.length <= maxConns);
			assert(promises.length == (requests.length+requests_processing.length == maxConns ? requests.length : requests.length+1));

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
				assert(promises.length == requests.length+1);
				let request = new ServerRequest(onretired, ready, onerror, null, structuredParams, maxConns, maxNameLength, maxValueLength, maxFileSize);
				requests[requests.length] = request;
				promises[promises.length-1] = request.poll();
				if (requests.length+requests_processing.length < maxConns)
				{	// Immediately start waiting for new
					promises[promises.length] = socket.accept();
				}
				else
				{	// Take a break accepting new connections
					assert(promises.length == requests.length);
				}
			}
			else
			{	// Some ServerRequest is ready (params are read)
				let i = requests.indexOf(ready);
				assert(i != -1);
				let j = requests.length - 1;
				requests[i] = requests[j];
				promises[i] = promises[j];
				if (promises.length != requests.length)
				{	assert(promises.length == requests.length+1);
					promises[j] = promises[j+1];
				}
				requests.length--;
				promises.length--;
				if (!ready.isTerminated())
				{	requests_processing[requests_processing.length] = ready;
					yield ready;
				}
			}
		}

		assert(this.is_closed);
		socket.close();
		await Promise.allSettled(promises);
	}

	nAccepted()
	{	return this.requests.length + this.requests_processing.length;
	}

	nProcessing()
	{	return this.requests_processing.length;
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
	{	this.is_closed = true;
		for (let request of this.requests)
		{	request.close();
		}
	}
}
