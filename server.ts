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
	protected n_accepted_conns = 0;
	private requests: ServerRequest[] = [];
	private promises: Promise<Deno.Conn | ServerRequest>[] = []; // promises[0] is promise for accepting new conn, and promises.length-1 == requests.length
	private onerror: (error: Error) => void = () => {};

	constructor(private socket: Deno.Listener, options?: ServerOptions)
	{	this.structuredParams = options?.structuredParams || false;
		this.maxConns = options?.maxConns || MAX_CONNS;
		this.maxNameLength = options?.maxNameLength || MAX_NAME_LENGTH;
		this.maxValueLength = options?.maxValueLength || MAX_VALUE_LENGTH;
		this.maxFileSize = options?.maxFileSize || MAX_FILE_SIZE;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<ServerRequest>
	{	if (this.promises.length == 0)
		{	this.promises[0] = this.socket.accept();
		}
		while (true)
		{	let ready = await Promise.race(this.promises);
			if (!(ready instanceof ServerRequest))
			{	// Accepted connection
				let request = new ServerRequest(this, ready, this.onerror, null, this.structuredParams, this.maxConns, this.maxNameLength, this.maxValueLength, this.maxFileSize);
				this.requests.push(request);
				this.promises.push(request.poll());
				// Immediately start waiting for new
				if (++this.n_accepted_conns < this.maxConns)
				{	this.promises[0] = this.socket.accept();
				}
				else
				{	this.promises[0] = new Promise(() => {}); // promise that will never resolve
				}
			}
			else
			{	// Some ServerRequest is ready (params are read)
				let i = this.requests.indexOf(ready);
				assert(i != -1);
				this.requests.splice(i, 1);
				this.promises.splice(i+1, 1);
				if (!ready.isTerminated())
				{	yield ready;
				}
			}
		}
	}

	nAccepted()
	{	return this.n_accepted_conns;
	}

	retired(request?: ServerRequest)
	{	assert(this.n_accepted_conns>=1 && this.n_accepted_conns<=this.maxConns);
		if (this.n_accepted_conns-- >= this.maxConns)
		{	this.promises[0] = this.socket.accept();
		}
		if (request)
		{	this.requests.push(request);
			this.promises.push(request.poll());
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
	{	for (let request of this.requests)
		{	request.close();
		}
		this.requests.length = 0;
		this.promises.length = 0;
	}
}
