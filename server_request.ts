import {assert} from './assert.ts';
import {Server} from './server.ts';
import {Get} from "./get.ts";
import {Post} from "./post.ts";
import {Cookies} from "./cookies.ts";
import {ServerResponse} from './server_response.ts';

const BUFFER_LEN = 4*1024;
const MAX_PARAM_NAME_LEN = BUFFER_LEN;
const MAX_PARAM_VALUE_LEN = BUFFER_LEN;
const MAX_NVP = 256;

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

export class ServerRequest
{	/// The SCRIPT_URL of the request, like '/path/index.html'
	public url = '';
	/// Request method, like 'GET'
	public method = '';
	/// Request protocol, like 'HTTP/1.1' or 'HTTP/2'
	public proto = '';
	public protoMinor = 0;
	public protoMajor = 0;
	/// Environment params sent from FascCGI worker. This usually includes 'REQUEST_URI', 'SCRIPT_URI', 'SCRIPT_FILENAME', 'DOCUMENT_ROOT', can contain 'CONTEXT_DOCUMENT_ROOT' (if using apache MultiViews), etc.
	public params = new Map<string, string>();
	/// Request HTTP headers
	public headers = new Headers;
	/// Set this at any time before calling respond() to be default response HTTP status code (like 200 or 404). However status provided to respond() overrides this. Leave 0 for default 200 status.
	public responseStatus = 0;
	/// You can set response HTTP headers before calling respond(). Headers provided to respond() will override them. Header called "status" acts as default HTTP status code, if responseStatus is not set.
	public responseHeaders = new Headers;

	/// Access POST body and uploaded files from here.
	public get = new Get;
	/// Access POST body and uploaded files from here.
	public post = new Post(this);
	/// Request cookies can be read from here, and modified. Setting or deleting a cookie sets corresponding HTTP headers.
	public cookies = new Cookies;

	/// Post body can be read from here. Also it can be read from "this" directly (`request.body` and `request` are the same `Deno.Reader` implementors).
	public body: Deno.Reader = this;

	/// True if headers have been sent to client. They will be sent if you write some response data to this request object (it implements `Deno.Writer`).
	public headersSent = false;

	private request_id = 0;
	private stdin_length = 0;
	private stdin_complete = false;
	private is_eof = false;
	private is_aborted = false;
	private is_terminated = false;

	private buffer: Uint8Array;
	private buffer_start = 0;
	private buffer_end = 0;

	private stdin_content_length = 0;
	private stdin_padding_length = 0;

	private no_keep_conn = false;
	private ongoing: Promise<unknown> = Promise.resolve();

	private encoder = new TextEncoder;
	private decoder = new TextDecoder;

	constructor(private server: Server, public conn: Deno.Conn, buffer: Uint8Array|null, private max_conns: number, private post_with_structure: boolean, private is_overload: boolean)
	{	this.buffer = buffer ?? new Uint8Array(BUFFER_LEN);
	}

	async read(buffer: Uint8Array): Promise<number|null>
	{	while (true)
		{	if (this.stdin_length)
			{	let chunk_size = Math.min(this.stdin_length, this.buffer_end-this.buffer_start);
				buffer.set(this.buffer.subarray(this.buffer_start, this.buffer_start+chunk_size));
				this.buffer_start += chunk_size;
				this.stdin_length -= chunk_size;
				return chunk_size;
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
		let {status, headers, body} = response;
		if (!this.headersSent)
		{	if (headers)
			{	for (let [k, v] of headers)
				{	this.responseHeaders.set(k, v);
				}
			}
			if (status)
			{	this.responseStatus = status;
			}
		}
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
			this.post.close();
			this.server.retired();
		}
		else
		{	this.post.close();
			let new_obj = new ServerRequest(this.server, this.conn, this.buffer, this.max_conns, this.post_with_structure, false);
			this.is_terminated = true;
			this.server.retired(new_obj);
		}
	}

	close()
	{	this.is_terminated = true;
		this.conn.close();
		this.post.close();
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

	private async read_nvp(len: number, map: Map<string, string>, http_headers?: Headers)
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
				{	http_headers.set(name.slice(5).replaceAll('_', '-'), value);
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
				// Send response headers
				if (!this.headersSent && record_type==FCGI_STDOUT)
				{	this.headersSent = true;
					let status = this.responseStatus ? this.responseStatus+'' : (this.responseHeaders.get('status') ?? '200');
					let headers_str = `        status: ${status}\r\n`; // 8-byte header
					for (let [k, v] of this.responseHeaders)
					{	if (k != 'status')
						{	headers_str += `${k}: ${v}\r\n`;
						}
					}
					for (let v of this.cookies.headers.values())
					{	headers_str += `set-cookie: ${v}\r\n`;
					}
					headers_str += "\r\n        "; // 8-byte (at most) padding
					let headers_bytes = this.encoder.encode(headers_str);
					let padding_length = (8 - headers_bytes.length%8) % 8;
					set_record_stdout(headers_bytes, 0, FCGI_STDOUT, this.request_id, headers_bytes.length-16, padding_length);
					await Deno.writeAll(this.conn, headers_bytes.subarray(0, headers_bytes.length-(8 - padding_length)));
				}
				// Send body
				let orig_len = value.length;
				while (true)
				{	if (value.length > 0xFFF8) // 0xFFF9 .. 0xFFFF will be padded to 0x10000
					{	await Deno.writeAll(this.conn, set_record_stdout(new Uint8Array(8), 0, record_type, this.request_id, 0xFFF8));
						await Deno.writeAll(this.conn, value.subarray(0, 0xFFF8));
						value = value.subarray(0xFFF8);
					}
					else if (value.length > BUFFER_LEN) // i don't want to allocate chunks larger than BUFFER_LEN
					{	let padding_length = (8 - value.length%8) % 8;
						await Deno.writeAll(this.conn, set_record_stdout(new Uint8Array(8), 0, record_type, this.request_id, value.length, padding_length));
						await Deno.writeAll(this.conn, value);
						if (is_last || padding_length>0)
						{	let all = new Uint8Array(padding_length + (is_last ? 8 : 0));
							if (is_last)
							{	set_record_stdout(all, padding_length, record_type, this.request_id);
							}
							await Deno.writeAll(this.conn, all);
						}
					}
					else
					{	let padding_length = (8 - value.length%8) % 8;
						let all = new Uint8Array((is_last ? 16 : 8) + value.length + padding_length);
						set_record_stdout(all, 0, record_type, this.request_id, value.length, padding_length);
						all.set(value, 8);
						if (is_last)
						{	set_record_stdout(all, all.length-8, record_type, this.request_id);
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
			{	let all = new Uint8Array(BUFFER_LEN/2);
				let offset = 8; // after packet header (that will be added later)
				for (let [k, v] of value)
				{	let k_buf = this.encoder.encode(k);
					let v_buf = this.encoder.encode(v);
					assert(k_buf.length<=0x7FFFFFFF && v_buf.length<=0x7FFFFFFF); // i don't write such nvp
					let add_len = 8 + k_buf.length + v_buf.length;
					if (offset+add_len > all.length)
					{	// realloc
						let new_all = new Uint8Array(Math.max(offset+add_len, all.length*2));
						new_all.set(all);
						all = new_all;
					}
					// name
					if (k_buf.length <= 127)
					{	all[offset++] = k_buf.length;
					}
					else
					{	all[0] = k_buf.length >> 24;
						all[1] = (k_buf.length >> 16) & 0xFF;
						all[2] = (k_buf.length >> 8) & 0xFF;
						all[3] = k_buf.length & 0xFF;
						offset += 4;
					}
					// value
					if (v_buf.length <= 127)
					{	all[offset++] = v_buf.length;
					}
					else
					{	all[offset++] = v_buf.length >> 24;
						all[offset++] = (v_buf.length >> 16) & 0xFF;
						all[offset++] = (v_buf.length >> 8) & 0xFF;
						all[offset++] = v_buf.length & 0xFF;
					}
					all.set(k_buf, offset);
					offset += k_buf.length;
					all.set(v_buf, offset);
					offset += v_buf.length;
				}
				// add packet header
				assert(offset <= 0xFFF8); // i don't write such nvp
				let padding_length = (8 - offset%8) % 8;
				all[0] = 1; // version
				all[1] = FCGI_GET_VALUES_RESULT; // record_type
				//buffer[2] = 0; // request_id[1]
				//buffer[3] = 0; // request_id[0]
				all[4] = offset >> 8; // content_length[1]
				all[5] = offset & 0xFF; // content_length[0]
				all[6] = padding_length;
				//buffer[7] = 0; // reserved
				// add padding
				if (offset+padding_length > all.length)
				{	// realloc
					let new_all = new Uint8Array(offset+padding_length);
					new_all.set(all);
					all = new_all;
				}
				offset += padding_length;
				// write
				await Deno.writeAll(this.conn, all.subarray(0, offset));
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
			{	// 1. Read packet header
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
								// done read params, stdin remaining
								// init this request object before handing it to user
								this.url = this.params.get('SCRIPT_URL') ?? '';
								this.method = this.params.get('REQUEST_METHOD') ?? '';
								this.proto = this.params.get('SERVER_PROTOCOL') ?? '';
								let pos = this.proto.indexOf('/');
								let pos_2 = this.proto.indexOf('.', pos);
								this.protoMajor = parseInt(this.proto.slice(pos+1, pos_2==-1 ? this.proto.length : pos_2)) ?? 0;
								this.protoMinor = pos_2==-1 ? 0 : parseInt(this.proto.slice(pos_2+1)) ?? 0;
								let query_string = this.params.get('QUERY_STRING');
								let cookie_header = this.params.get('HTTP_COOKIE');
								let contentType = this.params.get('CONTENT_TYPE') ?? '';
								let boundary = '';
								pos = contentType.indexOf(';');
								if (pos != -1)
								{	let pos_2 = contentType.indexOf('boundary=', pos+1);
									if (pos_2 != -1)
									{	boundary = contentType.slice(pos_2 + 'boundary='.length);
										pos_2 = boundary.indexOf(';');
										if (pos_2 != -1)
										{	boundary = boundary.slice(0, pos_2);
										}
									}
									contentType = contentType.slice(0, pos);
								}
								if (query_string)
								{	this.get.setQueryString(query_string);
									this.get.withStructure = this.post_with_structure;
								}
								if (cookie_header)
								{	this.cookies.setHeader(cookie_header);
								}
								if (contentType)
								{	this.post.contentType = contentType.toLocaleLowerCase();
									this.post.formDataBoundary = boundary;
									this.post.contentLength = Number(this.params.get('CONTENT_LENGTH')) || -1;
									this.post.withStructure = this.post_with_structure;
								}
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
						{	result.set('FCGI_MAX_CONNS', this.max_conns+'');
						}
						if (max_reqs != undefined)
						{	result.set('FCGI_MAX_REQS', this.max_conns+'');
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
	let v = new DataView(buffer.buffer);
	v.setUint8(0, 1); // version
	v.setUint8(1, FCGI_END_REQUEST); // record_type
	v.setUint16(2, request_id); // request_id
	v.setUint16(4, 8); // content_length
	//v.setUint8(6, 0); // padding_length
	//v.setUint8(7, 0); // reserved
	//v.setUint32(8, 0); // appStatus
	v.setUint8(12, protocol_status); // protocol_status
	//v.setUint8(13, 0); // reserved
	//v.setUint8(14, 0); // reserved
	//v.setUint8(15, 0); // reserved
	return buffer;
}

function record_unknown_type(record_type: number)
{	let buffer = new Uint8Array(16);
	let v = new DataView(buffer.buffer);
	v.setUint8(0, 1); // version
	v.setUint8(1, FCGI_UNKNOWN_TYPE); // record_type
	//v.setUint16(2, 0); // request_id
	v.setUint16(4, 8); // content_length
	//v.setUint8(6, 0); // padding_length
	//v.setUint8(7, 0); // reserved
	v.setUint8(8, record_type); // record_type
	//v.setUint8(9, 0); // reserved
	//v.setUint8(10, 0); // reserved
	//v.setUint8(11, 0); // reserved
	//v.setUint32(12, 0); // reserved
	return buffer;
}

function set_record_stdout(buffer: Uint8Array, offset: number, record_type: number, request_id: number, content_length=0, padding_length=0)
{	let v = new DataView(buffer.buffer);
	v.setUint8(offset+0, 1); // version
	v.setUint8(offset+1, record_type); // record_type
	v.setUint16(offset+2, request_id); // request_id
	v.setUint16(offset+4, content_length); // content_length
	v.setUint8(offset+6, padding_length); // padding_length
	//v.setUint8(offset+7, 0); // reserved
	return buffer;
}
