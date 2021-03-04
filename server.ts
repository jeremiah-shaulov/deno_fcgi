import {assert} from './assert.ts';
import {ServerRequest} from './server_request.ts';

const FCGI_MAX_CONNS = 128;

export class Server
{	private max_conns: number;
	private post_with_structure: boolean;
	private n_conns = 0;
	private requests: ServerRequest[] = [];
	private promises: Promise<Deno.Conn | ServerRequest>[] = []; // promises[0] is promise for accepting new conn, and promises.length-1 == requests.length

	constructor(private socket: Deno.Listener, options?: {maxConns: number, postWithStructure: boolean})
	{	this.max_conns = options?.maxConns || FCGI_MAX_CONNS;
		this.post_with_structure = options?.postWithStructure || false;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<ServerRequest>
	{	if (this.promises.length == 0)
		{	this.promises[0] = this.socket.accept();
		}
		while (true)
		{	let ready = await Promise.race(this.promises);
			if (!(ready instanceof ServerRequest))
			{	// Accepted connection
				let request = new ServerRequest(this, ready, null, this.max_conns, this.post_with_structure, false);
				this.requests.push(request);
				this.promises.push(request.poll());
				// Immediately start waiting for new
				if (++this.n_conns < this.max_conns)
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
				yield ready;
			}
		}
	}

	retired(request?: ServerRequest)
	{	if (this.n_conns-- >= this.max_conns)
		{	this.promises[0] = this.socket.accept();
		}
		assert(this.n_conns >= 0);
		if (request)
		{	this.requests.push(request);
			this.promises.push(request.poll());
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
