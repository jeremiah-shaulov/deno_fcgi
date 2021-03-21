/**	Data can be passed to constructor, and then it can be added with `pend_read()`.
	These data will be read later through `Deno.Reader` interface (`read()`).

	`get_written()` returns what is written through `Deno.Writer`.
 **/
export class MockConn implements Deno.Conn
{	public localAddr = {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: 999999999};
	public remoteAddr = {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: 999999999};
	public rid = 999999999;

	public is_closed = false;

	protected read_data: Uint8Array;
	private read_pos = 0;
	private write_data = new Uint8Array(1024);
	private write_pos = 0;

	constructor(str='', public chunk_size=10)
	{	this.read_data = new TextEncoder().encode(str);
	}

	pend_read(data: Uint8Array)
	{	let tmp = new Uint8Array(this.read_data.length + data.length);
		tmp.set(this.read_data);
		tmp.set(data, this.read_data.length);
		this.read_data = tmp;
	}

	async read(buffer: Uint8Array): Promise<number|null>
	{	if (this.is_closed)
		{	throw new Error('Connection closed');
		}
		if (this.read_pos == this.read_data.length)
		{	return null;
		}
		let chunk_size = Math.min(this.read_data.length-this.read_pos, buffer.length, this.chunk_size);
		buffer.set(this.read_data.subarray(this.read_pos, this.read_pos+chunk_size));
		this.read_pos += chunk_size;
		return chunk_size;
	}

	async write(buffer: Uint8Array): Promise<number>
	{	let chunk_size = Math.min(buffer.length, this.chunk_size);
		if (this.write_data.length-this.write_pos < chunk_size)
		{	// realloc
			let tmp = new Uint8Array(this.write_data.length * 2);
			tmp.set(this.write_data);
			this.write_data = tmp;
		}
		this.write_data.set(buffer.subarray(0, chunk_size), this.write_pos);
		this.write_pos += chunk_size;
		return chunk_size;
	}

	close()
	{	this.is_closed = true;
	}

	async closeWrite(): Promise<void>
	{
	}

	get_written()
	{	return this.write_data.subarray(0, this.write_pos);
	}
}
