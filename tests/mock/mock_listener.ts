export class MockListener implements Deno.Listener
{	public addr = {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: 999999999};
	public rid = 999999999;

	public is_closed = false;

	private satisfy = [] as ((conn: Deno.Conn) => void)[];

	constructor(private pending: Deno.Conn[] = [])
	{
	}

	pend_accept(conn: Deno.Conn)
	{	let satisfy = this.satisfy.shift();
		if (satisfy)
		{	satisfy(conn);
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
	{	let conn = this.pending.shift();
		return conn || new Promise(y => this.satisfy.push(y));
	}

	close()
	{	this.is_closed = true;
	}
}
