import {MockFcgiConn} from './mod.ts';

export class MockListener implements Deno.Listener
{	public addr = {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: Math.floor(Math.random()*0xFFFF)};
	public rid = Math.floor(Math.random()*0x7FFFFFFF);

	public is_closed = false;

	private satisfy = [] as {y: (conn: Deno.Conn) => void, n: (error: Error) => void}[];

	constructor(private pending: Deno.Conn[] = [])
	{
	}

	pend_accept(chunk_size: number, force_padding=-1, split_stream_records: 'no'|'yes'|'full'='no')
	{	let conn = new MockFcgiConn(chunk_size, force_padding, split_stream_records, this.addr);
		let satisfy = this.satisfy.shift();
		if (satisfy)
		{	satisfy.y(conn);
		}
		else
		{	this.pending.push(conn);
		}
		return conn;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<Deno.Conn, void, unknown>
	{	while (!this.is_closed)
		{	yield await this.accept();
		}
	}

	async accept(): Promise<Deno.Conn>
	{	if (this.is_closed)
		{	throw new Error('Server closed');
		}
		let conn = this.pending.shift();
		return conn || new Promise((y, n) => this.satisfy.push({y, n}));
	}

	close()
	{	this.is_closed = true;
		let s;
		while ((s = this.satisfy.shift()))
		{	s.n(new Error('Server closed'));
		}
	}
}
