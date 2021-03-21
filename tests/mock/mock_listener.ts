export class MockListener implements Deno.Listener
{	public addr = {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: 999999999};
	public rid = 999999999;

	public is_closed = false;

	private satisfy = [] as {y: (conn: Deno.Conn) => void, n: (error: Error) => void}[];

	constructor(private pending: Deno.Conn[] = [])
	{
	}

	pend_accept(conn: Deno.Conn)
	{	let satisfy = this.satisfy.shift();
		if (satisfy)
		{	satisfy.y(conn);
		}
		else
		{	this.pending.push(conn);
		}
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
