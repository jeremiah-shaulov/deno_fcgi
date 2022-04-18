import {Conn, Listener} from '../../../deno_ifaces.ts';
import {MockFcgiConn} from './mock_fcgi_conn.ts';

export class MockListener implements Listener
{	addr = {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: Math.floor(Math.random()*0xFFFF)};
	rid = Math.floor(Math.random()*0x7FFF_FFFF);

	is_closed = false;

	private satisfy = [] as {y: (conn: Conn) => void, n: (error: Error) => void}[];

	constructor(private pending: Conn[] = [])
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

	async *[Symbol.asyncIterator](): AsyncGenerator<Conn, void, unknown>
	{	while (!this.is_closed)
		{	yield await this.accept();
		}
	}

	async accept(): Promise<Conn>
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
