import {assert} from './assert.ts';
import {Get} from "./get.ts";
import {Post} from "./post.ts";
import {Cookies} from "./cookies.ts";
import {ServerResponse} from './server_response.ts';
import {AbortedError, TerminatedError, ProtocolError} from './error.ts';

const BUFFER_LEN = 8*1024;

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
	/// Access POST body and uploaded files from here.
	public get = new Get;
	/// Access POST body and uploaded files from here.
	public post: Post;
	/// Request cookies can be read from here, and modified. Setting or deleting a cookie sets corresponding HTTP headers.
	public cookies = new Cookies;
	/// Post body can be read from here. Also it can be read from "this" directly (`request.body` and `request` are the same `Deno.Reader` implementors).
	public body: Deno.Reader = this;

	/// Set this at any time before calling respond() to be default response HTTP status code (like 200 or 404). However status provided to respond() overrides this. Leave 0 for default 200 status.
	public responseStatus = 0;
	/// You can set response HTTP headers before calling respond(). Headers provided to respond() will override them. Header called "status" acts as default HTTP status code, if responseStatus is not set.
	public responseHeaders = new Headers;

	/// True if headers have been sent to client. They will be sent if you write some response data to this request object (it implements `Deno.Writer`).
	public headersSent = false;

	/// Id that FastCGI server assigned to this request
	private request_id = 0;
	/// If reading STDIN stream, how many bytes are available in this.buffer[this.buffer_start ..]. Calling `poll()` without consuming these bytes will discard them. Call `poll()` to fetch more bytes.
	private stdin_length = 0;
	/// Finished reading STDIN. This means that FastCGI server is now waiting for response (it's possible to send response earlier, but after reading PARAMS).
	private stdin_complete = false;
	/// FastCGI server send ABORT record. The request is assumed to respond soon, and it's response will be probably ignored.
	private is_aborted = false;
	/// Response sent back to FastCGI server, and this object is unusable. This can happen after `respond()` called, or if exception thrown during communication.
	private is_terminated = false;

	private has_stderr = false;

	private buffer: Uint8Array;
	private buffer_start = 0;
	private buffer_end = 0;

	private cur_nvp_read_state: AsyncGenerator<undefined, void, number> | undefined;

	private stdin_content_length = 0;
	private stdin_padding_length = 0;

	private no_keep_conn = false;
	private ongoing: Promise<unknown> = Promise.resolve();

	private encoder = new TextEncoder;
	private decoder = new TextDecoder;

	constructor
	(	private onretired: (request: ServerRequest, new_request?: ServerRequest) => void,
		public conn: Deno.Reader & Deno.Writer & Deno.Closer,
		private onerror: (error: Error) => void,
		buffer: Uint8Array|null,
		private structuredParams: boolean,
		private maxConns: number,
		private maxNameLength: number,
		private maxValueLength: number,
		private maxFileSize: number
	)
	{	this.buffer = buffer ?? new Uint8Array(BUFFER_LEN);
		this.post = new Post(this, onerror);
	}

	async read(buffer: Uint8Array): Promise<number|null>
	{	while (true)
		{	if (this.stdin_length)
			{	let chunk_size = Math.min(this.stdin_length, buffer.length);
				buffer.set(this.buffer.subarray(this.buffer_start, this.buffer_start+chunk_size));
				this.buffer_start += chunk_size;
				this.stdin_length -= chunk_size;
				return chunk_size;
			}
			else if (this.stdin_complete)
			{	return null;
			}
			else if (this.is_terminated)
			{	if (this.is_aborted)
				{	throw new AbortedError('Request aborted');
				}
				throw new TerminatedError('Request already terminated');
			}
			else
			{	await this.poll();
				assert(this.stdin_length || this.stdin_complete || this.is_terminated);
			}
		}
	}

	write(buffer: Uint8Array): Promise<number>
	{	return this.write_stdout(buffer);
	}

	async respond(response?: ServerResponse)
	{	while (!this.stdin_complete && !this.is_terminated)
		{	await this.poll();
		}
		if (this.is_terminated)
		{	if (this.is_aborted)
			{	this.is_aborted = false; // after respond() called, only TerminatedError must be thrown
				throw new AbortedError('Request aborted');
			}
			throw new TerminatedError('Request already terminated');
		}
		if (response)
		{	var {status, headers, body} = response;
		}
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
		{	this.onerror(e);
			this.no_keep_conn = true;
		}
		// Prepare for further requests on this connection
		if (this.no_keep_conn)
		{	this.close();
		}
		else
		{	this.post.close();
			// return to this.server a new object that uses the same this.conn and this.buffer, and leave this object invalid and "is_terminated", so further usage will throw exception
			let new_obj = new ServerRequest(this.onretired, this.conn, this.onerror, this.buffer, this.structuredParams, this.maxConns, this.maxNameLength, this.maxValueLength, this.maxFileSize);
			new_obj.buffer_start = this.buffer_start;
			new_obj.buffer_end = this.buffer_end;
			assert(this.stdin_content_length==0 && this.stdin_padding_length==0 && this.stdin_complete);
			this.is_terminated = true;
			this.onretired(this, new_obj);
		}
	}

	close()
	{	if (!this.is_terminated)
		{	this.is_terminated = true;
			this.conn.close();
			this.post.close();
			this.onretired(this);
		}
	}

	isTerminated()
	{	return this.is_terminated;
	}

	private async read_at_least(n_bytes: number, can_eof=false)
	{	assert(n_bytes <= BUFFER_LEN);
		if (this.buffer_start == this.buffer_end)
		{	this.buffer_start = 0;
			this.buffer_end = 0;
		}
		else if (this.buffer_start > BUFFER_LEN-n_bytes)
		{	this.buffer.copyWithin(0, this.buffer_start, this.buffer_end);
			this.buffer_end -= this.buffer_start;
			this.buffer_start = 0;
		}
		let till = this.buffer_start + n_bytes;
		while (this.buffer_end < till)
		{	let n_read = await this.conn.read(this.buffer.subarray(this.buffer_end));
			if (n_read == null)
			{	if (can_eof && this.buffer_end-this.buffer_start==0)
				{	return false;
				}
				throw new ProtocolError('Unexpected end of stream');
			}
			this.buffer_end += n_read;
		}
		return true;
	}

	private async *read_nvp(len: number, map: Map<string, string>, http_headers?: Headers): AsyncGenerator<undefined, void, number>
	{	let {buffer, maxNameLength, maxValueLength} = this;

		len |= 0;
		maxNameLength |= 0;
		maxValueLength |= 0;

		assert(len > 0);

		while (len > 0)
		{	// Read name_len and value_len
			let name_len = -1;
			let value_len = -1;
			while (true)
			{	if (len == 0)
				{	assert(name_len!=-1 && value_len==-1);
					len = (yield)|0; // stand by till next NVP record
					assert(len > 0);
				}
				if (this.buffer_end-this.buffer_start < 1)
				{	await this.read_at_least(1);
				}
				let nv_len = buffer[this.buffer_start++];
				len--;
				if (nv_len > 127)
				{	if (len < 3)
					{	let rest = new Uint8Array(3);
						let rest_len = len;
						rest.set(buffer.slice(this.buffer_start, this.buffer_start+len)); // rest is 1 or 2 bytes of record, after first byte (which is "nv_len")
						this.buffer_start += len;
						while (rest_len < rest.length)
						{	len = (yield)|0; // stand by till next NVP record
							assert(len > 0);
							let add_len = Math.min(len, rest.length-rest_len);
							rest.set(buffer.slice(this.buffer_start, this.buffer_start+add_len), rest_len);
							rest_len += add_len;
							this.buffer_start += add_len;
							len -= add_len;
						}
						nv_len = ((nv_len&0x7F) << 24) | (rest[0] << 16) | (rest[1] << 8) | rest[2];
					}
					else
					{	if (this.buffer_end-this.buffer_start < 3)
						{	await this.read_at_least(3);
						}
						nv_len = ((nv_len&0x7F) << 24) | (buffer[this.buffer_start] << 16) | (buffer[this.buffer_start+1] << 8) | buffer[this.buffer_start+2];
						this.buffer_start += 3;
						len -= 3;
					}
				}
				assert(nv_len >= 0);
				if (name_len == -1)
				{	name_len = nv_len;
				}
				else
				{	value_len = nv_len;
					break;
				}
			}

			// Read or skip name and value
			if (name_len>maxNameLength || value_len>maxValueLength)
			{	// Skip if name or value is too long
				let n_skip = name_len + value_len;
				while (true)
				{	let cur_n = Math.min(n_skip, len);
					n_skip -= cur_n;
					len -= cur_n;
					await this.skip_bytes(cur_n);
					if (n_skip <= 0)
					{	break;
					}
					assert(len == 0);
					len = (yield)|0; // stand by till next NVP record
					assert(len > 0);
				}
			}
			else
			{	// Read name and value
				let name: string | undefined;
				while (true)
				{	let str;
					let str_len = name==undefined ? name_len : value_len;
					if (str_len<=len && str_len<=BUFFER_LEN)
					{	await this.read_at_least(str_len);
						str = this.decoder.decode(buffer.subarray(this.buffer_start, this.buffer_start+str_len));
						this.buffer_start += str_len;
						len -= str_len;
					}
					else
					{	let bytes = new Uint8Array(str_len);
						let bytes_len = 0;
						while (bytes_len < bytes.length)
						{	if (len <= 0)
							{	len = (yield)|0; // stand by till next NVP record
								assert(len > 0);
							}
							let has = Math.min(bytes.length-bytes_len, len, BUFFER_LEN);
							await this.read_at_least(has);
							bytes.set(buffer.subarray(this.buffer_start, this.buffer_start+has), bytes_len);
							bytes_len += has;
							this.buffer_start += has;
							len -= has;
						}
						str = this.decoder.decode(bytes);
					}
					if (name == undefined)
					{	name = str;
					}
					else
					{	map.set(name, str);
						if (http_headers && name.startsWith('HTTP_'))
						{	http_headers.set(name.slice(5).replaceAll('_', '-'), str);
						}
						break;
					}
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
	{	return this.schedule(() => Deno.writeAll(this.conn, value));
	}

	private write_stdout(value: Uint8Array, record_type=FCGI_STDOUT, is_last=false): Promise<number>
	{	return this.schedule
		(	async () =>
			{	assert(this.request_id);
				assert(record_type==FCGI_STDOUT || record_type==FCGI_STDERR);
				assert(!is_last || record_type==FCGI_STDOUT);
				if (this.is_terminated)
				{	if (this.is_aborted)
					{	throw new AbortedError('Request aborted');
					}
					throw new TerminatedError('Request already terminated');
				}
				// Send response headers
				if (record_type == FCGI_STDOUT)
				{	if (!this.headersSent)
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
				}
				else if (value.length > 0)
				{	this.has_stderr = true;
				}
				// Send body
				let orig_len = value.length;
				while (value.length > 0xFFF8) // 0xFFF9 .. 0xFFFF will be padded to 0x10000
				{	await Deno.writeAll(this.conn, set_record_stdout(new Uint8Array(8), 0, record_type, this.request_id, 0xFFF8));
					await Deno.writeAll(this.conn, value.subarray(0, 0xFFF8));
					value = value.subarray(0xFFF8);
				}
				if (value.length > BUFFER_LEN) // i don't want to allocate chunks larger than BUFFER_LEN
				{	let padding_length = (8 - value.length%8) % 8;
					await Deno.writeAll(this.conn, set_record_stdout(new Uint8Array(8), 0, record_type, this.request_id, value.length, padding_length));
					await Deno.writeAll(this.conn, value);
					if (is_last || padding_length>0)
					{	let all = new Uint8Array(padding_length + (!is_last ? 0 : !this.has_stderr ? 24 : 32));
						if (is_last)
						{	let pos = padding_length;
							set_record_stdout(all, pos, FCGI_STDOUT, this.request_id);
							pos += 8;
							if (this.has_stderr)
							{	set_record_stdout(all, pos, FCGI_STDERR, this.request_id);
								pos += 8;
							}
							set_record_end_request(all, pos, this.request_id, FCGI_REQUEST_COMPLETE);
						}
						await Deno.writeAll(this.conn, all);
					}
				}
				else if (value.length > 0)
				{	let padding_length = (8 - value.length%8) % 8;
					let all = new Uint8Array((!is_last ? 8 : !this.has_stderr ? 32 : 40) + value.length + padding_length);
					set_record_stdout(all, 0, record_type, this.request_id, value.length, padding_length);
					all.set(value, 8);
					if (is_last)
					{	let pos = 8 + value.length + padding_length;
						set_record_stdout(all, pos, FCGI_STDOUT, this.request_id);
						pos += 8;
						if (this.has_stderr)
						{	set_record_stdout(all, pos, FCGI_STDERR, this.request_id);
							pos += 8;
						}
						set_record_end_request(all, pos, this.request_id, FCGI_REQUEST_COMPLETE);
					}
					await Deno.writeAll(this.conn, all);
				}
				else if (is_last)
				{	let all = new Uint8Array(!this.has_stderr ? 24 : 32);
					set_record_stdout(all, 0, FCGI_STDOUT, this.request_id);
					if (this.has_stderr)
					{	set_record_stdout(all, 8, FCGI_STDERR, this.request_id);
						set_record_end_request(all, 16, this.request_id, FCGI_REQUEST_COMPLETE);
					}
					else
					{	set_record_end_request(all, 8, this.request_id, FCGI_REQUEST_COMPLETE);
					}
					await Deno.writeAll(this.conn, all);
				}
				return orig_len;
			}
		);
	}

	private write_nvp(value: Map<string, string>)
	{	this.schedule(() => Deno.writeAll(this.conn, pack_nvp(FCGI_GET_VALUES_RESULT, 0, value, this.maxNameLength, this.maxValueLength)));
	}

	/**	This function doesn't throw exceptions. It always returns "this".
		Before returning it sets one of the following:
		- is_terminated
		- is_aborted + is_terminated
		- params
		- stdin_length
		- stdin_complete
	 **/
	async poll()
	{	let {buffer} = this;

		if (this.is_terminated)
		{	if (this.is_aborted)
			{	throw new AbortedError('Request aborted');
			}
			throw new TerminatedError('Request already terminated');
		}

		try
		{	this.buffer_start += this.stdin_length; // discard stdin part if not read
			if (this.stdin_content_length != 0)
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
					{	this.close();
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
						this.no_keep_conn = (flags&FCGI_KEEP_CONN) == 0;
						if (role != FCGI_RESPONDER)
						{	this.write_raw(set_record_end_request(new Uint8Array(16), 0, request_id, FCGI_UNKNOWN_ROLE));
						}
						else if (this.request_id != 0)
						{	this.write_raw(set_record_end_request(new Uint8Array(16), 0, request_id, FCGI_CANT_MPX_CONN));
							request_id = this.request_id;
						}
						this.request_id = request_id;
						break;
					}
					case FCGI_ABORT_REQUEST:
					{	this.write_raw(set_record_end_request(new Uint8Array(16), 0, request_id, FCGI_REQUEST_COMPLETE));
						if (request_id == this.request_id)
						{	this.is_aborted = true;
							// skip content_length + padding_length
							if (this.buffer_end-this.buffer_start < content_length+padding_length)
							{	await this.read_at_least(content_length+padding_length);
							}
							this.buffer_start += content_length + padding_length;
							this.close();
							return this;
						}
						break;
					}
					case FCGI_PARAMS:
					{	if (request_id == this.request_id)
						{	if (content_length == 0) // empty record terminates records stream
							{	this.cur_nvp_read_state = undefined;
								// skip padding_length
								if (this.buffer_end-this.buffer_start < padding_length)
								{	await this.read_at_least(padding_length);
								}
								this.buffer_start += padding_length;
								// done read params, stdin remaining
								// init this request object before handing it to user
								this.url = this.params.get('REQUEST_URI') ?? '';
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
									this.get.structuredParams = this.structuredParams;
								}
								if (cookie_header)
								{	this.cookies.setHeader(cookie_header);
								}
								if (contentType)
								{	this.post.contentType = contentType.toLocaleLowerCase();
									this.post.formDataBoundary = boundary;
									this.post.contentLength = Number(this.params.get('CONTENT_LENGTH')) || -1;
									this.post.structuredParams = this.structuredParams;
									this.post.maxNameLength = this.maxNameLength;
									this.post.maxValueLength = this.maxValueLength;
									this.post.maxFileSize = this.maxFileSize;
								}
								return this;
							}
							if (!this.cur_nvp_read_state)
							{	this.cur_nvp_read_state = this.read_nvp(content_length, this.params, this.headers);
							}
							await this.cur_nvp_read_state.next(content_length);
						}
						else
						{	await this.skip_bytes(content_length);
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
							{	if (this.buffer_end == this.buffer_start)
								{	await this.read_at_least(1);
								}
								this.stdin_length = Math.min(content_length, this.buffer_end-this.buffer_start);
								this.stdin_content_length = content_length - this.stdin_length;
								this.stdin_padding_length = padding_length;
							}
							return this;
						}
						else
						{	await this.skip_bytes(content_length);
						}
						break;
					}
					case FCGI_GET_VALUES:
					{	let values = new Map<string, string>();
						await this.read_nvp(content_length, values).next();
						let result = new Map<string, string>();
						if (values.has('FCGI_MAX_CONNS'))
						{	result.set('FCGI_MAX_CONNS', this.maxConns+'');
						}
						if (values.has('FCGI_MAX_REQS'))
						{	result.set('FCGI_MAX_REQS', this.maxConns+'');
						}
						if (values.has('FCGI_MPXS_CONNS'))
						{	result.set('FCGI_MPXS_CONNS', '0');
						}
						this.write_nvp(result);
						break;
					}
					default:
					{	this.write_raw(record_unknown_type(record_type));
						await this.skip_bytes(content_length);
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
		{	this.onerror(e);
			try
			{	await this.ongoing;
			}
			catch (e2)
			{	this.onerror(e2);
			}
			this.close();
			return this;
		}
	}
}

function set_record_end_request(buffer: Uint8Array, offset: number, request_id: number, protocol_status: number)
{	assert(buffer.byteOffset == 0); // i create such
	let v = new DataView(buffer.buffer, offset);
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
{	assert(buffer.byteOffset == 0); // i create such
	let v = new DataView(buffer.buffer, offset);
	v.setUint8(0, 1); // version
	v.setUint8(1, record_type); // record_type
	v.setUint16(2, request_id); // request_id
	v.setUint16(4, content_length); // content_length
	v.setUint8(6, padding_length); // padding_length
	//v.setUint8(7, 0); // reserved
	return buffer;
}

export function pack_nvp(record_type: number, request_id: number, value: Map<string, string>, maxNameLength: number, maxValueLength: number): Uint8Array
{	assert(record_type==FCGI_GET_VALUES_RESULT || record_type==FCGI_PARAMS);
	let all = new Uint8Array(BUFFER_LEN/2);
	let offset = 8; // after packet header (that will be added later)
	let encoder = new TextEncoder;
	for (let [k, v] of value)
	{	let k_buf = encoder.encode(k);
		let v_buf = encoder.encode(v);
		if (k_buf.length>maxNameLength || v_buf.length>maxValueLength)
		{	continue;
		}
		let add_len = (k_buf.length>127 ? 4 : 1) + (v_buf.length>127 ? 4 : 1) + k_buf.length + v_buf.length;
		if (offset+add_len > all.length)
		{	if (offset+add_len > 0xFFF0)
			{	throw new Error('NVP is too large'); // i use pack_nvp() only to send FCGI_GET_VALUES_RESULT, and in MockServer
			}
			// realloc
			let new_all = new Uint8Array(Math.max(offset+add_len, all.length*2));
			new_all.set(all);
			all = new_all;
		}
		// name
		if (k_buf.length <= 127)
		{	all[offset++] = k_buf.length;
		}
		else
		{	all[offset++] = 0x80 | (k_buf.length >> 24);
			all[offset++] = (k_buf.length >> 16) & 0xFF;
			all[offset++] = (k_buf.length >> 8) & 0xFF;
			all[offset++] = k_buf.length & 0xFF;
		}
		// value
		if (v_buf.length <= 127)
		{	all[offset++] = v_buf.length;
		}
		else
		{	all[offset++] = 0x80 | (v_buf.length >> 24);
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
	let padding_length = (8 - offset%8) % 8;
	let header = new DataView(all.buffer);
	header.setUint8(0, 1); // version
	header.setUint8(1, record_type); // record_type
	header.setUint16(2, request_id); // request_id
	header.setUint16(4, offset-8); // content_length
	header.setUint8(6, padding_length); // padding_length
	// add padding
	if (offset+padding_length > all.length)
	{	// realloc
		let new_all = new Uint8Array(offset+padding_length);
		new_all.set(all);
		all = new_all;
	}
	offset += padding_length;
	// write
	return all.subarray(0, offset);
}
