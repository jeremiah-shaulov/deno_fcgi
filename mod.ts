const ASSERTIONS_ENABLED = true;
const BUFFER_LEN = 4*1024;
const MAX_PARAM_NAME_LEN = BUFFER_LEN;
const MAX_PARAM_VALUE_LEN = BUFFER_LEN;
const MAX_NVP = 256;
const FCGI_MAX_CONNS = 128;

const FCGI_BEGIN_REQUEST      =  1;
const FCGI_ABORT_REQUEST      =  2;
const FCGI_END_REQUEST        =  3;
const FCGI_PARAMS             =  4;
const FCGI_STDIN              =  5;
const FCGI_STDOUT             =  6;
const FCGI_STDERR             =  7;
const FCGI_DATA               =  8;
const FCGI_GET_VALUES         =  9;
const FCGI_GET_VALUES_RESULT  = 10;
const FCGI_UNKNOWN_TYPE       = 11;

const FCGI_REQUEST_COMPLETE   =  0;
const FCGI_CANT_MPX_CONN      =  1;
const FCGI_OVERLOADED         =  2;
const FCGI_UNKNOWN_ROLE       =  3;

const FCGI_RESPONDER          =  1;
const FCGI_AUTHORIZER         =  2;
const FCGI_FILTER             =  3;

const FCGI_KEEP_CONN          =  1;

assert(BUFFER_LEN >= 256+16);
assert(MAX_PARAM_NAME_LEN <= BUFFER_LEN);
assert(MAX_PARAM_VALUE_LEN <= BUFFER_LEN);

function assert(expr: unknown): asserts expr
{	if (ASSERTIONS_ENABLED && !expr)
	{	throw new Error('Assertion failed');
	}
}

export interface ServerResponse
{	status?: number;
	headers?: Headers;
	body?: Uint8Array | Deno.Reader | string;
	trailers?: () => Promise<Headers> | Headers;
}

export class Server
{	private want_close = false;
	private requests: ServerRequest[] = [];
	private promises: Promise<Deno.Conn | ServerRequest>[] = []; // promises[0] is promise for accepting new conn, and promises.length-1 == requests.length
	private n_conns = 0;

	constructor(private socket: Deno.Listener)
	{
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<ServerRequest>
	{	if (this.promises.length == 0)
		{	this.promises[0] = this.socket.accept();
		}
		while (!this.want_close)
		{	let ready = await Promise.race(this.promises);
			if (!(ready instanceof ServerRequest))
			{	// Accepted connection
				let request = new ServerRequest(this, ready, new Uint8Array(BUFFER_LEN), false);
				this.requests.push(request);
				this.promises.push(request.poll());
				// Immediately start waiting for new
				if (++this.n_conns < FCGI_MAX_CONNS)
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
		for (let request of this.requests)
		{	request.terminate();
		}
		await Promise.allSettled(this.promises);
		this.requests.length = 0;
		this.promises.length = 0;
	}

	retired(request?: ServerRequest)
	{	if (this.n_conns-- >= FCGI_MAX_CONNS)
		{	if (!this.want_close)
			{	this.promises[0] = this.socket.accept();
			}
		}
		assert(this.n_conns >= 0);
		if (request && !this.want_close)
		{	this.requests.push(request);
			this.promises.push(request.poll());
		}
	}
}

export class ServerRequest
{	public url = '';
	public method = ''; // like 'GET'
	public proto = ''; // like 'HTTP/1.1'
	public protoMinor = 0;
	public protoMajor = 0;
	public params = new Map<string, string>();
	public headers = new Map<string, string>();

	public body: Deno.Reader;

	private request_id = 0;
	private stdin_length = 0;
	private stdin_complete = false;
	private is_eof = false;
	private is_aborted = false;
	private is_terminated = false;

	private buffer_start = 0;
	private buffer_end = 0;

	private stdin_content_length = 0;
	private stdin_padding_length = 0;

	private no_keep_conn = false;
	private ongoing: Promise<unknown> = Promise.resolve();

	private encoder = new TextEncoder;
	private decoder = new TextDecoder;

	constructor(private server: Server, public conn: Deno.Conn, private buffer: Uint8Array, private is_overload: boolean)
	{	this.body = this;
	}

	async read(buffer: Uint8Array): Promise<number|null>
	{	while (true)
		{	if (this.stdin_length)
			{	let chunk = Math.min(this.stdin_length, buffer.length);
				buffer.set(this.buffer.subarray(this.buffer_start, this.buffer_start+chunk));
				this.buffer_start += chunk;
				return chunk;
			}
			else if (this.stdin_complete)
			{	return null;
			}
			else if (this.is_aborted)
			{	throw new Error('Request aborted');
			}
			else if (this.is_eof)
			{	throw new Error('Incomplete request. Unexpected end of input stream.');
			}
			else
			{	await this.poll();
				assert(this.stdin_length || this.stdin_complete || this.is_aborted || this.is_eof);
			}
		}
	}

	write(buffer: Uint8Array): Promise<number>
	{	return this.write_stdout(buffer);
	}

	async respond(response: ServerResponse)
	{	if (this.is_terminated)
		{	throw new Error('Request already terminated');
		}
		while (!this.stdin_complete && !this.is_eof && !this.is_aborted)
		{	await this.poll();
		}
		let {body} = response;
		try
		{	if (body)
			{	if (typeof(body) == 'string')
				{	body = this.encoder.encode(body);
				}
				if (body instanceof Uint8Array)
				{	await this.write_stdout(body, FCGI_STDOUT, true);
				}
				else
				{	await Deno.copy(body, this);
					await this.write_stdout(new Uint8Array(0), FCGI_STDOUT, true);
				}
			}
			else
			{	await this.write_stdout(new Uint8Array(0), FCGI_STDOUT, true);
			}
		}
		catch (e)
		{	console.error(e);
			this.no_keep_conn = true;
		}
		// Prepare for further requests on this connection
		if (this.no_keep_conn)
		{	this.is_terminated = true;
			this.conn.close();
			this.server.retired();
		}
		else
		{	let new_obj = new ServerRequest(this.server, this.conn, this.buffer, false);
			this.is_terminated = true;
			this.server.retired(new_obj);
		}
	}

	terminate()
	{	this.is_terminated = true;
		this.conn.close();
		this.server.retired();
	}

	private async read_at_least(n_bytes: number, can_eof=false)
	{	if (this.buffer_start == this.buffer_end)
		{	this.buffer_start = 0;
			this.buffer_end = 0;
			assert(n_bytes <= BUFFER_LEN);
		}
		else if (this.buffer_start > BUFFER_LEN-n_bytes)
		{	this.buffer.copyWithin(0, this.buffer_start, this.buffer_end);
			this.buffer_start = 0;
			this.buffer_end = 0;
			assert(n_bytes <= BUFFER_LEN);
		}
		let till = this.buffer_start + n_bytes;
		while (this.buffer_end < till)
		{	let n_read = await this.conn.read(this.buffer.subarray(this.buffer_end));
			if (n_read == null)
			{	if (can_eof && this.buffer_end-this.buffer_start==0)
				{	return false;
				}
				throw new Error('Unexpected end of stream');
			}
			this.buffer_end += n_read;
		}
		return true;
	}

	private async read_string(len: number): Promise<string>
	{	let {buffer} = this;
		if (len <= BUFFER_LEN)
		{	if (this.buffer_end-this.buffer_start < len)
			{	await this.read_at_least(len);
			}
			this.buffer_start += len;
			return this.decoder.decode(buffer.subarray(this.buffer_start-len, this.buffer_start));
		}
		else
		{	let result_buffer = new Uint8Array(len);
			result_buffer.set(buffer.subarray(this.buffer_start, this.buffer_end));
			let offset = this.buffer_end - this.buffer_start;
			this.buffer_start = this.buffer_end;
			while (len-offset > BUFFER_LEN)
			{	await this.read_at_least(BUFFER_LEN);
				result_buffer.set(buffer, offset);
				offset += BUFFER_LEN;
				this.buffer_start = this.buffer_end;
			}
			len -= offset;
			await this.read_at_least(len);
			result_buffer.set(buffer.subarray(this.buffer_start, this.buffer_start+len));
			this.buffer_start += len;
			return this.decoder.decode(result_buffer);
		}
	}

	private async read_nvp(len: number, map: Map<string, string>, http_headers?: Map<string, string>)
	{	let {buffer} = this;
		while (len > 0)
		{	// Read name length
			if (this.buffer_end-this.buffer_start < 2)
			{	await this.read_at_least(2);
			}
			let name_len = buffer[this.buffer_start+0];
			if (name_len > 127)
			{	if (this.buffer_end-this.buffer_start < 8)
				{	await this.read_at_least(8);
				}
				name_len = ((buffer[this.buffer_start+0]&0x7F) << 24) | (buffer[this.buffer_start+1] << 16) | (buffer[this.buffer_start+2] << 8) | buffer[this.buffer_start+3];
				this.buffer_start += 3;
				len -= 3;
			}
			this.buffer_start++;
			len--;
			// Read value length
			assert(this.buffer_end-this.buffer_start >= 1); // i reserved above, when read name length
			let value_len = buffer[this.buffer_start+0];
			if (value_len > 127)
			{	if (this.buffer_end-this.buffer_start < 4)
				{	await this.read_at_least(4);
				}
				value_len = ((buffer[this.buffer_start+0]&0x7F) << 24) | (buffer[this.buffer_start+1] << 16) | (buffer[this.buffer_start+2] << 8) | buffer[this.buffer_start+3];
				this.buffer_start += 3;
				len -= 3;
			}
			this.buffer_start++;
			len--;
			// Read name and value
			len -= name_len + value_len;
			if (name_len>MAX_PARAM_NAME_LEN || value_len>MAX_PARAM_VALUE_LEN || map.size>=MAX_NVP)
			{	// Skip if name or value is too long
				this.skip_bytes(name_len+value_len);
			}
			else
			{	let name;
				if (this.buffer_end-this.buffer_start >= name_len)
				{	name = this.decoder.decode(buffer.subarray(this.buffer_start, this.buffer_start+name_len));
					this.buffer_start += name_len;
				}
				else
				{	name = await this.read_string(name_len);
				}
				let value;
				if (this.buffer_end-this.buffer_start >= value_len)
				{	value = this.decoder.decode(buffer.subarray(this.buffer_start, this.buffer_start+value_len));
					this.buffer_start += value_len;
				}
				else
				{	value = await this.read_string(value_len);
				}
				map.set(name, value);
				if (http_headers && name.startsWith('HTTP_'))
				{	http_headers.set(name.slice(5).toLowerCase().replaceAll('_', '-'), value);
				}
			}
		}
	}

	private async skip_bytes(len: number)
	{	let n_skip = Math.min(len, this.buffer_end-this.buffer_start);
		this.buffer_start += n_skip;
		len -= n_skip;
		while (len > BUFFER_LEN)
		{	await this.read_at_least(BUFFER_LEN);
			len -= BUFFER_LEN;
			this.buffer_start = this.buffer_end;
		}
		await this.read_at_least(len);
		this.buffer_start += len;
	}

	private schedule<T>(callback: () => T | Promise<T>): Promise<T>
	{	let promise = this.ongoing.then(callback);
		this.ongoing = promise;
		return promise;
	}

	private write_raw(value: Uint8Array)
	{	this.schedule(() => Deno.writeAll(this.conn, value));
	}

	private write_stdout(value: Uint8Array, record_type=FCGI_STDOUT, is_last=false): Promise<number>
	{	return this.schedule
		(	async () =>
			{	assert(this.request_id);
				if (this.is_aborted)
				{	throw new Error('Request aborted');
				}
				if (this.is_terminated)
				{	throw new Error('Request already terminated');
				}
				let orig_len = value.length;
				let header = record_stdout(record_type, this.request_id, 0xFFF8, 0);
				while (true)
				{	if (value.length > 0xFFF8) // 0xFFF9 .. 0xFFFF will be padded to 0x10000
					{	await Deno.writeAll(this.conn, header);
						await Deno.writeAll(this.conn, value.subarray(0, 0xFFF8));
						value = value.subarray(0xFFF8);
					}
					else
					{	let padding_length = (8 - value.length%8) % 8;
						header[4] = value.length >> 8; // content_length[1]
						header[5] = value.length & 0xFF; // content_length[0]
						header[6] = padding_length;
						let all = new Uint8Array((is_last ? 16 : 8) + value.length + padding_length);
						all.set(header);
						all.set(value, 8);
						if (is_last)
						{	header = record_stdout(record_type, this.request_id, 0, 0);
							all.set(header, all.length-8);
						}
						await Deno.writeAll(this.conn, all);
						return orig_len;
					}
				}
			}
		);
	}

	private write_nvp(value: Map<string, string>)
	{	this.schedule
		(	async () =>
			{	for (let [k, v] of value)
				{	let k_buf = this.encoder.encode(k);
					let v_buf = this.encoder.encode(v);
					assert(k_buf.length<=0x7FFFFFFF && v_buf.length<=0x7FFFFFFF); // i don't write such nvp
					let header = new Uint8Array(8);
					let offset = 0;
					// name
					if (k_buf.length <= 127)
					{	header[offset++] = k_buf.length;
					}
					else
					{	header[0] = k_buf.length >> 24;
						header[1] = (k_buf.length >> 16) & 0xFF;
						header[2] = (k_buf.length >> 8) & 0xFF;
						header[3] = k_buf.length & 0xFF;
						offset += 4;
					}
					// value
					if (v_buf.length <= 127)
					{	header[offset++] = v_buf.length;
					}
					else
					{	header[offset++] = v_buf.length >> 24;
						header[offset++] = (v_buf.length >> 16) & 0xFF;
						header[offset++] = (v_buf.length >> 8) & 0xFF;
						header[offset++] = v_buf.length & 0xFF;
					}
					let all = new Uint8Array(offset + k_buf.length + v_buf.length);
					all.set(header.subarray(0, offset));
					all.set(k_buf, offset);
					all.set(v_buf, offset+k_buf.length);
					await Deno.writeAll(this.conn, all);
				}
			}
		);
	}

	/**	This function doesn't throw exceptions. It always returns "this".
		Before returning it sets one of the following:
		- is_terminated
		- is_eof
		- is_aborted
		- params
		- stdin_length
		- stdin_complete
	 **/
	async poll()
	{	let {is_overload, buffer} = this;

		if (this.is_terminated)
		{	throw new Error('Request already terminated');
		}

		try
		{	if (this.stdin_content_length != 0)
			{	// is in the middle of reading FCGI_STDIN
				if (this.stdin_content_length > BUFFER_LEN)
				{	await this.read_at_least(BUFFER_LEN);
					this.buffer_start = this.buffer_end;
					this.stdin_length = BUFFER_LEN;
					this.stdin_content_length -= BUFFER_LEN;
					return this;
				}
				else
				{	await this.read_at_least(this.stdin_content_length);
					this.buffer_start += this.stdin_content_length;
					this.stdin_length = this.stdin_content_length;
					this.stdin_content_length = 0;
					return this;
				}
			}
			if (this.stdin_padding_length != 0)
			{	// skip padding_length
				if (this.buffer_end-this.buffer_start < this.stdin_padding_length)
				{	await this.read_at_least(this.stdin_padding_length);
				}
				this.buffer_start += this.stdin_padding_length;
				this.stdin_padding_length = 0;
			}

			while (true)
			{	// 1. Read header
				if (this.buffer_end-this.buffer_start < 8)
				{	if (!await this.read_at_least(8, true))
					{	this.is_eof = true;
						return this;
					}
				}
				let record_type = buffer[this.buffer_start+1];
				let request_id = (buffer[this.buffer_start+2] << 8) | buffer[this.buffer_start+3];
				let content_length = (buffer[this.buffer_start+4] << 8) | buffer[this.buffer_start+5];
				let padding_length = buffer[this.buffer_start+6];
				this.buffer_start += 8;

				// 2. Read payload
				switch (record_type)
				{	case FCGI_BEGIN_REQUEST:
					{	if (this.buffer_end-this.buffer_start < 8)
						{	await this.read_at_least(8);
						}
						let role = (buffer[this.buffer_start+0] << 8) | buffer[this.buffer_start+1];
						let flags = buffer[this.buffer_start+2];
						this.buffer_start += 8;
						if ((flags&FCGI_KEEP_CONN) == 0)
						{	this.no_keep_conn = true;
						}
						if (role != FCGI_RESPONDER)
						{	this.write_raw(record_end_request(request_id, FCGI_UNKNOWN_ROLE));
						}
						else if (is_overload)
						{	this.write_raw(record_end_request(request_id, FCGI_OVERLOADED));
						}
						else if (this.request_id != 0)
						{	this.write_raw(record_end_request(request_id, FCGI_CANT_MPX_CONN));
							request_id = this.request_id;
						}
						this.request_id = request_id;
						break;
					}
					case FCGI_ABORT_REQUEST:
					{	// skip padding_length + content_length (assume: content_length == 8)
						if (this.buffer_end-this.buffer_start < padding_length+8)
						{	await this.read_at_least(padding_length+8);
						}
						this.buffer_start += padding_length+8;
						padding_length = 0;
						// process record
						this.write_raw(record_end_request(request_id, FCGI_REQUEST_COMPLETE));
						if (request_id == this.request_id)
						{	this.is_aborted = true;
							return this;
						}
						break;
					}
					case FCGI_PARAMS:
					{	if (request_id == this.request_id)
						{	if (content_length == 0) // empty record terminates records stream
							{	// skip padding_length
								if (this.buffer_end-this.buffer_start < padding_length)
								{	await this.read_at_least(padding_length);
								}
								this.buffer_start += padding_length;
								this.url = this.params.get('SCRIPT_URL') ?? '';
								this.method = this.params.get('REQUEST_METHOD') ?? '';
								this.proto = this.params.get('SERVER_PROTOCOL') ?? '';
								let pos = this.proto.indexOf('/');
								let pos_2 = this.proto.indexOf('.', pos);
								this.protoMajor = parseInt(this.proto.slice(pos+1, pos_2)) ?? 0;
								this.protoMinor = parseInt(this.proto.slice(pos_2+1)) ?? 0;
								// done read params, stdin remaining
								return this;
							}
							await this.read_nvp(content_length, this.params, this.headers);
						}
						else
						{	this.skip_bytes(content_length);
						}
						break;
					}
					case FCGI_STDIN:
					{	assert(this.stdin_content_length == 0);
						assert(this.stdin_padding_length == 0);
						if (request_id == this.request_id)
						{	if (content_length == 0) // empty record terminates records stream
							{	this.stdin_complete = true;
							}
							else
							{	this.stdin_length = Math.min(content_length, this.buffer_end-this.buffer_start);
								this.stdin_content_length = content_length - this.stdin_length;
								this.stdin_padding_length = padding_length;
							}
							return this;
						}
						else
						{	this.skip_bytes(content_length);
						}
						break;
					}
					case FCGI_GET_VALUES:
					{	let values = new Map<string, string>();
						await this.read_nvp(content_length, values);
						let max_conns = values.get('FCGI_MAX_CONNS');
						let max_reqs = values.get('FCGI_MAX_REQS');
						let mpxs_conns = values.get('FCGI_MPXS_CONNS');
						let result = new Map<string, string>();
						if (max_conns != undefined)
						{	result.set('FCGI_MAX_CONNS', FCGI_MAX_CONNS+'');
						}
						if (max_reqs != undefined)
						{	result.set('FCGI_MAX_REQS', FCGI_MAX_CONNS+'');
						}
						if (mpxs_conns != undefined)
						{	result.set('FCGI_MPXS_CONNS', '0');
						}
						this.write_nvp(result);
						break;
					}
					default:
					{	this.write_raw(record_unknown_type(record_type));
						this.skip_bytes(content_length);
						break;
					}
				}

				// skip padding_length
				if (this.buffer_end-this.buffer_start < padding_length)
				{	await this.read_at_least(padding_length);
				}
				this.buffer_start += padding_length;
			}
		}
		catch (e)
		{	console.error(e);
			try
			{	await this.ongoing;
			}
			catch (e2)
			{	console.error(e2);
			}
			this.conn.close();
			this.is_eof = true;
			this.is_terminated = true;
			return this;
		}
	}
}

function record_end_request(request_id: number, protocol_status: number)
{	let buffer = new Uint8Array(16);
	buffer[0] = 1; // version
	buffer[1] = FCGI_END_REQUEST; // record_type
	buffer[2] = request_id >> 8;
	buffer[3] = request_id & 0xFF;
	//buffer[4] = 0; // content_length[1]
	buffer[5] = 8; // content_length[0]
	//buffer[6] = 0; // padding_length
	//buffer[7] = 0; // reserved
	//buffer[8] = 0; // appStatus[3]
	//buffer[9] = 0; // appStatus[2]
	//buffer[10] = 0; // appStatus[1]
	//buffer[11] = 0; // appStatus[0]
	buffer[12] = protocol_status;
	//buffer[13] = 0; // reserved
	//buffer[14] = 0; // reserved
	//buffer[15] = 0; // reserved
	return buffer;
}

function record_unknown_type(record_type: number)
{	let buffer = new Uint8Array(16);
	buffer[0] = 1; // version
	buffer[1] = FCGI_UNKNOWN_TYPE; // record_type
	buffer[2] = 0; // request_id[1]
	buffer[3] = 0; // request_id[0]
	//buffer[4] = 0; // content_length[1]
	buffer[5] = 8; // content_length[0]
	//buffer[6] = 0; // padding_length
	//buffer[7] = 0; // reserved
	buffer[8] = record_type; // record_type
	//buffer[9] = 0; // reserved
	//buffer[10] = 0; // reserved
	//buffer[11] = 0; // reserved
	//buffer[12] = 0; // reserved
	//buffer[13] = 0; // reserved
	//buffer[14] = 0; // reserved
	//buffer[15] = 0; // reserved
	return buffer;
}

function record_stdout(record_type: number, request_id: number, content_length: number, padding_length: number)
{	let buffer = new Uint8Array(8);
	buffer[0] = 1; // version
	buffer[1] = record_type; // record_type
	buffer[2] = request_id >> 8;
	buffer[3] = request_id & 0xFF;
	buffer[4] = content_length >> 8; // content_length[1]
	buffer[5] = content_length & 0xFF; // content_length[0]
	buffer[6] = padding_length;
	//buffer[7] = 0; // reserved
	return buffer;
}
