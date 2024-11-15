import {debug_assert} from './debug_assert.ts';
import {Conn} from './deno_ifaces.ts';
import {Get} from "./get.ts";
import {Post} from "./post.ts";
import {Cookies} from "./cookies.ts";
import {ServerResponse} from './server_response.ts';
import {AbortedError, TerminatedError, ProtocolError} from './error.ts';
import {writeAll, copy} from './deps.ts';
import {RdStream, WrStream} from './deps.ts';

export const is_processing = Symbol('is_processing');
export const take_next_request = Symbol('take_next_request');
export const poll = Symbol('poll');

const BUFFER_LEN = 8*1024;

const FCGI_BEGIN_REQUEST      =  1;
const FCGI_ABORT_REQUEST      =  2;
const FCGI_END_REQUEST        =  3;
const FCGI_PARAMS             =  4;
const FCGI_STDIN              =  5;
const FCGI_STDOUT             =  6;
const FCGI_STDERR             =  7;
const _FCGI_DATA              =  8;
const FCGI_GET_VALUES         =  9;
const FCGI_GET_VALUES_RESULT  = 10;
const FCGI_UNKNOWN_TYPE       = 11;

const FCGI_REQUEST_COMPLETE   =  0;
const FCGI_CANT_MPX_CONN      =  1;
const _FCGI_OVERLOADED        =  2;
const FCGI_UNKNOWN_ROLE       =  3;

const FCGI_RESPONDER          =  1;
const _FCGI_AUTHORIZER        =  2;
const _FCGI_FILTER            =  3;

const FCGI_KEEP_CONN          =  1;

debug_assert(BUFFER_LEN >= 256+16);

const encoder = new TextEncoder;
const decoder = new TextDecoder;

export class ServerRequest implements Conn
{	readonly localAddr: Deno.Addr;
	readonly remoteAddr: Deno.Addr;
	readonly rid: number;

	/** REQUEST_URI of the request, like '/path/index.html?a=1'
	 **/
	url = '';

	/** Request method, like 'GET'
	 **/
	method = '';

	/** Request protocol, like 'HTTP/1.1' or 'HTTP/2'
	 **/
	proto = '';

	protoMinor = 0;
	protoMajor = 0;

	/** Environment params sent from FastCGI frontend. This usually includes 'REQUEST_URI', 'SCRIPT_URI', 'SCRIPT_FILENAME', 'DOCUMENT_ROOT', can contain 'CONTEXT_DOCUMENT_ROOT' (if using Apache MultiViews), etc.
	 **/
	params = new Map<string, string>();

	/** Request HTTP headers
	 **/
	headers = new Headers;

	/** Access POST body and uploaded files from here.
	 **/
	get = new Get;

	/** Access POST body and uploaded files from here.
	 **/
	post: Post;

	/** Request cookies can be read from here, and modified. Setting or deleting a cookie sets corresponding HTTP headers.
	 **/
	cookies = new Cookies;

	/** Post body can be read from here.
	 **/
	readonly readable = new RdStream({read: v => this.read(v)});

	/**	Write request here.
	 **/
	readonly writable = new WrStream({write: c => this.write(c)});

	/** Set this at any time before calling respond() to be default response HTTP status code (like 200 or 404). However status provided to respond() overrides this. Leave 0 for default 200 status.
	 **/
	responseStatus = 0;

	/** You can set response HTTP headers before calling respond(). Headers provided to respond() will override them. Header called "status" acts as default HTTP status code, if responseStatus is not set.
	 **/
	responseHeaders = new Headers;

	/** True if headers have been sent to client. They will be sent if you write some response data to this request object (it implements `Deno.Writer`).
	 **/
	headersSent = false;

	/** Id that FastCGI server assigned to this request
	 **/
	private request_id = 0;

	/** If reading STDIN stream, how many bytes are available in this.buffer[this.buffer_start ..]. Calling `poll()` without consuming these bytes will discard them. Call `poll()` to fetch more bytes.
	 **/
	private stdin_length = 0;

	/** Finished reading STDIN. This means that FastCGI server is now waiting for response (it's possible to send response earlier, but after reading PARAMS).
	 **/
	private stdin_complete = false;

	/** FastCGI server send ABORT record. The request is assumed to respond soon, and it's response will be probably ignored.
	 **/
	private is_aborted = false;

	/** Response sent back to FastCGI server, and this object is unusable. This can happen after `respond()` called, or if exception thrown during communication.
	 **/
	private is_terminated = false;

	/** poll() sets this (together with is_terminated) if error occures
	 **/
	private last_error: Error|undefined;

	private has_stderr = false;

	private buffer: Uint8Array;
	private buffer_start = 0;
	private buffer_end = 0;

	private cur_nvp_read_state: AsyncGenerator<undefined, void, number> | undefined;

	private stdin_content_length = 0;
	private stdin_padding_length = 0;

	private no_keep_conn = false;
	private is_polling_request = false;
	private ongoing_read: Promise<ServerRequest> | undefined;
	private ongoing_write: Promise<unknown> | undefined;
	private complete_promise: ((request: ServerRequest) => void) | undefined;

	/** Server returned this object to user. If "false", the object is considered to modifiable from outside space.
	 **/
	private is_processing = false;

	/** If FCGI_KEEP_CONN flag is provided, i'll create a new ServerRequest object that uses the same "conn" and "buffer", and let it continue reading records.
	 **/
	private next_request: ServerRequest | undefined;

	/** "this.next_request" will have "prev_request" set to this, so if FCGI_ABORT_REQUEST record comes, it will cancel the previous request
	 **/
	private prev_request: ServerRequest | undefined;

	/** Result of "next_request.poll()"
	 **/
	private next_request_ready: Promise<ServerRequest> | undefined;

	constructor
	(	public conn: Conn,
		private onerror: (error: Error) => void,
		buffer: Uint8Array|null,
		private structuredParams: boolean,
		private maxConns: number,
		private maxNameLength: number,
		private maxValueLength: number,
		private maxFileSize: number
	)
	{	this.localAddr = conn.localAddr;
		this.remoteAddr = conn.remoteAddr;
		this.rid = conn.rid ?? 0;
		this.buffer = buffer ?? new Uint8Array(BUFFER_LEN);
		this.post = new Post(this, onerror);
	}

	ref()
	{
	}

	unref()
	{
	}

	async read(buffer: Uint8Array): Promise<number|null>
	{	while (true)
		{	if (this.stdin_length)
			{	const chunk_size = Math.min(this.stdin_length, buffer.length);
				buffer.set(this.buffer.subarray(this.buffer_start, this.buffer_start+chunk_size));
				this.buffer_start += chunk_size;
				this.stdin_length -= chunk_size;
				return chunk_size;
			}
			else if (this.stdin_complete)
			{	if (this.is_aborted)
				{	throw new AbortedError('Request aborted');
				}
				if (this.is_terminated)
				{	this.throw_terminated_error();
				}
				return null;
			}
			else
			{	await this.poll(true);
			}
		}
	}

	write(buffer: Uint8Array): Promise<number>
	{	if (this.is_aborted)
		{	throw new AbortedError('Request aborted');
		}
		if (this.is_terminated)
		{	throw new TerminatedError('Request already terminated');
		}
		return this.write_stdout(buffer);
	}

	/**	Send error message to SAPI, that probably will be printed to error log file of FastCGI server.
		Call this before `respond()`.
	 **/
	logError(message: string)
	{	if (this.is_aborted)
		{	throw new AbortedError('Request aborted');
		}
		if (this.is_terminated)
		{	throw new TerminatedError('Request already terminated');
		}
		this.write_stdout(encoder.encode(message), FCGI_STDERR);
	}

	private throw_terminated_error(msg='Unexpected end of input')
	{	if (this.last_error)
		{	const e = this.last_error;
			this.last_error = undefined;
			throw e;
		}
		throw new TerminatedError(msg);
	}

	respond(response?: ServerResponse)
	{	return this.do_respond(response);
	}

	private async do_respond(response?: ServerResponse, is_for_abort=false)
	{	const was_terminated = this.is_terminated;
		while (!this.stdin_complete)
		{	await this.poll(true);
		}
		let read_error: Error | undefined;
		try
		{	if (!this.is_terminated && !this.is_aborted)
			{	if (response)
				{	// deno-lint-ignore no-inner-declarations no-var
					var {status, headers, setCookies, body} = response;
				}
				if (!this.headersSent)
				{	if (status)
					{	this.responseStatus = status;
					}
					if (headers)
					{	for (const [k, v] of headers)
						{	this.responseHeaders.set(k, v);
						}
					}
					if (setCookies)
					{	for (const [k, v] of setCookies)
						{	this.cookies.set(k, v.value, v.options);
						}
					}
				}
				if (body)
				{	if (typeof(body) == 'string')
					{	body = encoder.encode(body);
					}
					if (body instanceof Uint8Array)
					{	this.write_stdout(body, FCGI_STDOUT, true);
					}
					else
					{	try
						{	await copy(body, this);
						}
						catch (e)
						{	read_error = e instanceof Error ? e : new Error(e+''); // if it was write error, it is expected to happen again when writing the final packet (at `await ongoing_write`)
						}
						this.write_stdout(this.buffer.subarray(0, 0), FCGI_STDOUT, true);
					}
				}
				else
				{	this.write_stdout(this.buffer.subarray(0, 0), FCGI_STDOUT, true);
				}
			}
			const ongoing_write = (this.next_request || this).ongoing_write;
			if (ongoing_write)
			{	if (this.next_request)
				{	this.next_request.ongoing_write = undefined; // So next request will not suffer from errors in "ongoing_write", if it will throw. It's safe to clear "ongoing_write", because the next request object was not yet returned to the user, so there're no writes
				}
				await ongoing_write;
			}
		}
		catch (e)
		{	const e2 = read_error ?? e;
			if (e2 instanceof AbortedError)
			{	debug_assert(this.is_aborted);
			}
			else
			{	await this.do_close(true);
				throw e2;
			}
		}
		const was_terminated_2 = this.is_terminated;
		// Prepare for further requests on "this.conn"
		debug_assert(this.stdin_content_length==0 && this.stdin_padding_length==0 && this.stdin_complete && !this.prev_request);
		if (!was_terminated_2)
		{	if (this.no_keep_conn)
			{	await this.do_close();
			}
			else if (this.next_request)
			{	this.is_terminated = true;
				this.stdin_complete = true;
				this.next_request.prev_request = undefined;
				this.post.close();
				this.complete_promise!(this);
			}
			else
			{	this.is_terminated = true;
				this.stdin_complete = true;
				this.post.close();
				const next_request = new ServerRequest(this.conn, this.onerror, this.buffer, this.structuredParams, this.maxConns, this.maxNameLength, this.maxValueLength, this.maxFileSize);
				next_request.buffer_start = this.buffer_start;
				next_request.buffer_end = this.buffer_end;
				this.next_request = next_request;
				this.next_request_ready = next_request.poll();
				this.complete_promise!(this);
			}
		}
		if (read_error)
		{	throw read_error;
		}
		if (is_for_abort)
		{	return;
		}
		if (this.is_aborted)
		{	this.is_aborted = false; // after calling `respond()`, must throw TerminatedError
			throw new AbortedError('Request aborted');
		}
		if (was_terminated_2)
		{	this.throw_terminated_error(was_terminated ? 'Request already terminated' : 'Unexpected end of input');
		}
	}

	close()
	{	this.do_close();
	}

	[Symbol.dispose]()
	{	this.do_close();
	}

	private async do_close(ignore_error=false)
	{	if (!this.is_terminated)
		{	this.is_terminated = true;
			this.stdin_complete = true;
			const cur = this.next_request || this;
			if (cur.ongoing_write)
			{	try
				{	await cur.ongoing_write;
				}
				catch (e)
				{	if (!ignore_error)
					{	this.onerror(e instanceof Error ? e : new Error(e+''));
					}
				}
				cur.ongoing_write = undefined;
			}
			if (!this.next_request || this.next_request.is_terminated)
			{	this.next_request = undefined;
				this.conn.close();
			}
			this.post.close();
			this.complete_promise?.(this);
		}
	}

	closeWrite(): Promise<void>
	{	return this.conn.closeWrite();
	}

	complete()
	{	this.is_processing = true;
		debug_assert(!this.is_terminated);
		return new Promise<ServerRequest>
		(	y =>
			{	this.complete_promise = y;
			}
		);
	}

	isTerminated()
	{	return this.is_terminated;
	}

	/**	For internal use.
	 **/
	[is_processing]()
	{	return this.is_processing;
	}

	/**	For internal use.
	 **/
	[take_next_request]()
	{	const {next_request, next_request_ready} = this;
		this.next_request = undefined; // free memory (don't hold links)
		this.next_request_ready = undefined; // free memory (don't hold links)
		return {next_request, next_request_ready};
	}

	private async read_at_least(n_bytes: number, can_eof=false)
	{	debug_assert(n_bytes <= BUFFER_LEN);
		if (this.buffer_start == this.buffer_end)
		{	this.buffer_start = 0;
			this.buffer_end = 0;
		}
		else if (this.buffer_start > BUFFER_LEN-n_bytes)
		{	this.buffer.copyWithin(0, this.buffer_start, this.buffer_end);
			this.buffer_end -= this.buffer_start;
			this.buffer_start = 0;
		}
		const to = this.buffer_start + n_bytes;
		while (this.buffer_end < to)
		{	try
			{	// deno-lint-ignore no-inner-declarations no-var
				var n_read = await this.conn.read(this.buffer.subarray(this.buffer_end));
			}
			catch (e)
			{	if (!can_eof || !this.stdin_complete)
				{	throw e;
				}
				if (!this.is_terminated)
				{	this.onerror(e instanceof Error ? e : new Error(e+''));
				}
				n_read = null;
			}
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

	/**	Parses sequence of FCGI_PARAMS records to "map" and "headers_and_cookies" (if given).
		"len" - length of the record.
		Start by calling "read_nvp()" with length of first such record, and saving the generator result to "this.cur_nvp_read_state".
		It will read everything non-partial from the record, and put to the "map" (and "headers_and_cookies").
		And it will remember intermediate parsing state.
		When next such record arrives, call "this.cur_nvp_read_state.next(len)" with the length of the new record.
	 **/
	private async *read_nvp(len: number, map: Map<string, string>, headers_and_cookies?: {headers: Headers, cookies: Cookies}): AsyncGenerator<undefined, void, number>
	{	const {buffer, maxNameLength, maxValueLength} = this;

		debug_assert(len > 0);

		while (len > 0)
		{	// Read name_len and value_len
			let name_len = -1;
			let value_len = -1;
			while (true)
			{	if (len == 0)
				{	debug_assert(name_len!=-1 && value_len==-1);
					len = (yield)|0; // stand by till next NVP record
					debug_assert(len > 0);
				}
				if (this.buffer_end-this.buffer_start < 1)
				{	await this.read_at_least(1);
				}
				let nv_len = buffer[this.buffer_start++];
				len--;
				if (nv_len > 127)
				{	if (len < 3)
					{	const rest = new Uint8Array(3);
						let rest_len = len;
						if (this.buffer_end-this.buffer_start < len)
						{	await this.read_at_least(len);
						}
						rest.set(buffer.slice(this.buffer_start, this.buffer_start+len)); // rest is 1 or 2 bytes of record, after first byte (which is "nv_len")
						this.buffer_start += len;
						while (rest_len < rest.length)
						{	len = (yield)|0; // stand by till next NVP record
							debug_assert(len > 0);
							const add_len = Math.min(len, rest.length-rest_len);
							if (this.buffer_end-this.buffer_start < add_len)
							{	await this.read_at_least(add_len);
							}
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
				debug_assert(nv_len >= 0);
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
				{	const cur_n = Math.min(n_skip, len);
					n_skip -= cur_n;
					len -= cur_n;
					await this.skip_bytes(cur_n);
					if (n_skip <= 0)
					{	break;
					}
					debug_assert(len == 0);
					len = (yield)|0; // stand by till next NVP record
					debug_assert(len > 0);
				}
			}
			else
			{	// Read name and value
				let name: string | undefined;
				while (true)
				{	let str;
					const str_len = name==undefined ? name_len : value_len;
					if (str_len<=len && str_len<=BUFFER_LEN)
					{	if (this.buffer_end-this.buffer_start < str_len)
						{	await this.read_at_least(str_len);
						}
						str = decoder.decode(buffer.subarray(this.buffer_start, this.buffer_start+str_len));
						this.buffer_start += str_len;
						len -= str_len;
					}
					else
					{	const bytes = new Uint8Array(str_len);
						let bytes_len = 0;
						while (bytes_len < bytes.length)
						{	if (len <= 0)
							{	len = (yield)|0; // stand by till next NVP record
								debug_assert(len > 0);
							}
							const has = Math.min(bytes.length-bytes_len, len, BUFFER_LEN);
							if (this.buffer_end-this.buffer_start < has)
							{	await this.read_at_least(has);
							}
							bytes.set(buffer.subarray(this.buffer_start, this.buffer_start+has), bytes_len);
							bytes_len += has;
							this.buffer_start += has;
							len -= has;
						}
						str = decoder.decode(bytes);
					}
					if (name == undefined)
					{	name = str;
					}
					else
					{	map.set(name, str);
						if (headers_and_cookies && name.startsWith('HTTP_'))
						{	try
							{	headers_and_cookies.headers.set(name.slice(5).replaceAll('_', '-'), str);
							}
							catch (e)
							{	this.onerror(e instanceof Error ? e : new Error(e+''));
							}
							if (name == 'HTTP_COOKIE')
							{	headers_and_cookies.cookies.setHeader(str);
							}
						}
						break;
					}
				}
			}
		}
	}

	private async skip_bytes(len: number)
	{	const n_skip = Math.min(len, this.buffer_end-this.buffer_start);
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

	private schedule_write<T>(callback: () => T | Promise<T>): Promise<T>
	{	const cur = this.next_request || this;
		const promise = (cur.ongoing_write || Promise.resolve()).then(callback);
		cur.ongoing_write = promise;
		return promise;
	}

	private write_raw(value: Uint8Array)
	{	return this.schedule_write(() => writeAll(this.conn, value));
	}

	private write_stdout(value: Uint8Array, record_type=FCGI_STDOUT, is_last=false): Promise<number>
	{	return this.schedule_write
		(	async () =>
			{	debug_assert(this.request_id);
				debug_assert(record_type==FCGI_STDOUT || record_type==FCGI_STDERR);
				debug_assert(!is_last || record_type==FCGI_STDOUT);
				if (this.is_aborted || this.is_terminated)
				{	return value.length;
				}
				// Send response headers
				if (record_type == FCGI_STDOUT)
				{	if (!this.headersSent)
					{	this.headersSent = true;
						const status = this.responseStatus ? this.responseStatus+'' : (this.responseHeaders.get('status') ?? '200');
						let headers_str = `        status: ${status}\r\n`; // 8-byte header
						for (const [k, v] of this.responseHeaders)
						{	if (k != 'status')
							{	headers_str += `${k}: ${v}\r\n`;
							}
						}
						for (const v of this.cookies.headers.values())
						{	headers_str += `set-cookie: ${v}\r\n`;
						}
						headers_str += "\r\n        "; // 8-byte (at most) padding
						const headers_bytes = encoder.encode(headers_str);
						const padding_length = (8 - headers_bytes.length%8) % 8;
						set_record_stdout(headers_bytes, 0, FCGI_STDOUT, this.request_id, headers_bytes.length-16, padding_length);
						await writeAll(this.conn, headers_bytes.subarray(0, headers_bytes.length-(8 - padding_length)));
					}
				}
				else if (value.length > 0)
				{	this.has_stderr = true;
				}
				// Send body
				const orig_len = value.length;
				while (value.length > 0xFFF8) // max packet length without padding is 0xFFF8 (0xFFF9..0xFFFF must be padded, and 0x10000 is impossible, because such number cannot be represented in content_length field)
				{	await writeAll(this.conn, set_record_stdout(new Uint8Array(8), 0, record_type, this.request_id, 0xFFF8));
					await writeAll(this.conn, value.subarray(0, 0xFFF8));
					value = value.subarray(0xFFF8);
				}
				if (value.length > BUFFER_LEN) // i don't want to allocate chunks larger than BUFFER_LEN
				{	const padding_length = (8 - value.length%8) % 8;
					await writeAll(this.conn, set_record_stdout(new Uint8Array(8), 0, record_type, this.request_id, value.length, padding_length));
					await writeAll(this.conn, value);
					if (is_last || padding_length>0)
					{	const all = new Uint8Array(padding_length + (!is_last ? 0 : !this.has_stderr ? 24 : 32));
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
						await writeAll(this.conn, all);
					}
				}
				else if (value.length > 0)
				{	const padding_length = (8 - value.length%8) % 8;
					const all = new Uint8Array((!is_last ? 8 : !this.has_stderr ? 32 : 40) + value.length + padding_length);
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
					await writeAll(this.conn, all);
				}
				else if (is_last)
				{	const all = new Uint8Array(!this.has_stderr ? 24 : 32);
					set_record_stdout(all, 0, FCGI_STDOUT, this.request_id);
					if (this.has_stderr)
					{	set_record_stdout(all, 8, FCGI_STDERR, this.request_id);
						set_record_end_request(all, 16, this.request_id, FCGI_REQUEST_COMPLETE);
					}
					else
					{	set_record_end_request(all, 8, this.request_id, FCGI_REQUEST_COMPLETE);
					}
					await writeAll(this.conn, all);
				}
				return orig_len;
			}
		);
	}

	private write_nvp(value: Map<string, string>)
	{	this.schedule_write(() => writeAll(this.conn, pack_nvp(FCGI_GET_VALUES_RESULT, 0, value, this.maxNameLength, this.maxValueLength)));
	}

	/**	For internal use.
	 **/
	[poll]()
	{	return this.poll();
	}

	private poll(store_error_dont_print=false)
	{	if (this.ongoing_read)
		{	return this.ongoing_read;
		}
		debug_assert(!this.is_terminated && !this.is_aborted && !this.is_polling_request);
		const promise = this.do_poll(store_error_dont_print);
		if (this.is_polling_request)
		{	this.ongoing_read = promise;
		}
		return promise;
	}

	/**	This function doesn't throw exceptions. It always returns "this".
		Before returning it sets one of the following:
		- params (all FCGI_PARAMS records received)
		- stdin_length (a FCGI_STDIN record received, and there're "stdin_length" bytes in buffer available to read)
		- stdin_complete (all FCGI_STDIN records received)
		- is_aborted + stdin_complete (a FCGI_ABORT_REQUEST record received)
		- is_terminated + stdin_complete (if due to error, also last_error is set)
	 **/
	private async do_poll(store_error_dont_print=false)
	{	const {buffer} = this;

		this.is_polling_request = true;

		try
		{	this.buffer_start += this.stdin_length; // discard stdin part if not consumed
			this.stdin_length = 0;
			if (this.stdin_content_length != 0)
			{	// is in the middle of reading FCGI_STDIN
				if (this.stdin_content_length > BUFFER_LEN)
				{	await this.read_at_least(BUFFER_LEN);
					this.stdin_length = BUFFER_LEN;
					this.stdin_content_length -= BUFFER_LEN;
					this.is_polling_request = false;
					this.ongoing_read = undefined;
					return this;
				}
				else
				{	await this.read_at_least(this.stdin_content_length);
					this.stdin_length = this.stdin_content_length;
					this.stdin_content_length = 0;
					this.is_polling_request = false;
					this.ongoing_read = undefined;
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
					{	if (this.prev_request && !this.prev_request.is_terminated)
						{	this.is_terminated = true;
							this.stdin_complete = true;
							this.prev_request.no_keep_conn = true;
							this.prev_request.next_request = undefined;
							this.prev_request.next_request_ready = undefined;
							this.prev_request.ongoing_write = this.ongoing_write;
							this.ongoing_write = undefined;
						}
						else
						{	this.no_keep_conn = true;
							if (!this.stdin_complete)
							{	await this.do_close();
							}
						}
						this.is_polling_request = false;
						this.ongoing_read = undefined;
						return this;
					}
				}
				const record_type = buffer[this.buffer_start+1];
				const request_id = (buffer[this.buffer_start+2] << 8) | buffer[this.buffer_start+3];
				const content_length = (buffer[this.buffer_start+4] << 8) | buffer[this.buffer_start+5];
				const padding_length = buffer[this.buffer_start+6];
				this.buffer_start += 8;

				// 2. Read payload
				switch (record_type)
				{	case FCGI_BEGIN_REQUEST:
					{	if (this.buffer_end-this.buffer_start < 8)
						{	await this.read_at_least(8);
						}
						const role = (buffer[this.buffer_start+0] << 8) | buffer[this.buffer_start+1];
						const flags = buffer[this.buffer_start+2];
						this.buffer_start += 8;
						this.no_keep_conn = (flags&FCGI_KEEP_CONN) == 0;
						if (role != FCGI_RESPONDER)
						{	this.write_raw(set_record_end_request(new Uint8Array(16), 0, request_id, FCGI_UNKNOWN_ROLE));
							break;
						}
						if (this.request_id != 0)
						{	this.write_raw(set_record_end_request(new Uint8Array(16), 0, request_id, FCGI_CANT_MPX_CONN));
							break;
						}
						this.request_id = request_id;
						break;
					}
					case FCGI_ABORT_REQUEST:
					{	this.write_raw(set_record_end_request(new Uint8Array(16), 0, request_id, FCGI_REQUEST_COMPLETE));
						if (request_id == this.request_id)
						{	this.is_aborted = true;
							this.stdin_complete = true;
							// skip content_length + padding_length
							if (this.buffer_end-this.buffer_start < content_length+padding_length)
							{	await this.read_at_least(content_length+padding_length);
							}
							this.buffer_start += content_length + padding_length;
							await this.do_respond(undefined, true).catch(this.onerror); // retired
							this.is_polling_request = false;
							this.ongoing_read = undefined;
							return this;
						}
						else if (this.prev_request && request_id==this.prev_request.request_id && !this.prev_request.is_terminated)
						{	this.prev_request.is_aborted = true;
							this.prev_request.stdin_complete = true;
							this.prev_request.do_respond(undefined, true).catch(this.onerror); // retired
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
								const pos_2 = this.proto.indexOf('.', pos);
								this.protoMajor = parseInt(this.proto.slice(pos+1, pos_2==-1 ? this.proto.length : pos_2)) || 0;
								this.protoMinor = pos_2==-1 ? 0 : parseInt(this.proto.slice(pos_2+1)) || 0;
								const query_string = this.params.get('QUERY_STRING');
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
								if (contentType)
								{	this.post.contentType = contentType.toLocaleLowerCase();
									this.post.formDataBoundary = boundary;
									this.post.contentLength = Number(this.params.get('CONTENT_LENGTH')) || -1;
									this.post.structuredParams = this.structuredParams;
									this.post.maxNameLength = this.maxNameLength;
									this.post.maxValueLength = this.maxValueLength;
									this.post.maxFileSize = this.maxFileSize;
								}
								this.is_polling_request = false;
								this.ongoing_read = undefined;
								return this;
							}
							if (!this.cur_nvp_read_state)
							{	this.cur_nvp_read_state = this.read_nvp(content_length, this.params, this);
							}
							if ((await this.cur_nvp_read_state.next(content_length))?.done)
							{	this.cur_nvp_read_state = undefined;
							}
						}
						else
						{	await this.skip_bytes(content_length);
						}
						break;
					}
					case FCGI_STDIN:
					{	debug_assert(this.stdin_content_length == 0);
						debug_assert(this.stdin_padding_length == 0);
						if (request_id == this.request_id)
						{	if (content_length == 0) // empty record terminates records stream
							{	this.stdin_complete = true;
								// skip padding_length
								if (this.buffer_end-this.buffer_start < padding_length)
								{	await this.read_at_least(padding_length);
								}
								this.buffer_start += padding_length;
								// start listening for potential FCGI_ABORT_REQUEST
								if (this.no_keep_conn)
								{	this.ongoing_read = this.do_poll(false);
								}
								else
								{	// next request will be handled in a new object that uses the same "conn" and "buffer"
									this.next_request = new ServerRequest(this.conn, this.onerror, this.buffer, this.structuredParams, this.maxConns, this.maxNameLength, this.maxValueLength, this.maxFileSize);
									this.next_request.prev_request = this;
									this.next_request.buffer_start = this.buffer_start;
									this.next_request.buffer_end = this.buffer_end;
									// from now on i write only to "this.next_request.ongoing_write", not "this.ongoing_write"
									this.next_request.ongoing_write = this.ongoing_write;
									this.ongoing_write = undefined;
									// from now on i only poll "this.next_request_ready", not "this"
									this.next_request_ready = this.next_request.poll();
									this.is_polling_request = false;
									this.ongoing_read = undefined;
								}
							}
							else
							{	if (this.buffer_end == this.buffer_start)
								{	await this.read_at_least(1);
								}
								this.stdin_length = Math.min(content_length, this.buffer_end-this.buffer_start);
								this.stdin_content_length = content_length - this.stdin_length;
								this.stdin_padding_length = padding_length;
								this.is_polling_request = false;
								this.ongoing_read = undefined;
							}
							return this;
						}
						else
						{	await this.skip_bytes(content_length);
						}
						break;
					}
					case FCGI_GET_VALUES:
					{	const values = new Map<string, string>();
						await this.read_nvp(content_length, values).next();
						const result = new Map<string, string>();
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
		{	if (store_error_dont_print)
			{	this.last_error = e instanceof Error ? e : new Error(e+'');
			}
			else
			{	this.onerror(e instanceof Error ? e : new Error(e+''));
			}
			await this.do_close(true);
			this.is_polling_request = false;
			this.ongoing_read = undefined;
			return this;
		}
	}
}

function set_record_end_request(buffer: Uint8Array, offset: number, request_id: number, protocol_status: number)
{	debug_assert(buffer.byteOffset == 0); // i create such
	const v = new DataView(buffer.buffer, offset);
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
{	const buffer = new Uint8Array(16);
	const v = new DataView(buffer.buffer);
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
{	debug_assert(buffer.byteOffset == 0); // i create such
	const v = new DataView(buffer.buffer, offset);
	v.setUint8(0, 1); // version
	v.setUint8(1, record_type); // record_type
	v.setUint16(2, request_id); // request_id
	v.setUint16(4, content_length); // content_length
	v.setUint8(6, padding_length); // padding_length
	//v.setUint8(7, 0); // reserved
	return buffer;
}

export function pack_nvp(record_type: number, request_id: number, value: Map<string, string>, _maxNameLength: number, _maxValueLength: number): Uint8Array
{	debug_assert(record_type==FCGI_GET_VALUES_RESULT || record_type==FCGI_GET_VALUES || record_type==FCGI_PARAMS);

	let all = new Uint8Array(BUFFER_LEN/2);
	let header_offset = 0;
	let offset = 8; // after packet header (that will be added later)

	function add_header()
	{	// add packet header
		const padding_length = (8 - offset%8) % 8;
		const header = new DataView(all.buffer, header_offset);
		header.setUint8(0, 1); // version
		header.setUint8(1, record_type); // record_type
		header.setUint16(2, request_id); // request_id
		header.setUint16(4, offset-header_offset-8); // content_length
		header.setUint8(6, padding_length); // padding_length
		// add padding
		offset += padding_length;
		realloc(offset);
		header_offset = offset;
	}

	function realloc(new_length: number)
	{	if (new_length > all.length)
		{	const new_all = new Uint8Array(Math.max(new_length, all.length*2));
			new_all.set(all);
			all = new_all;
		}
	}

	function add(part: Uint8Array)
	{	while (offset-header_offset+part.length > 0xFFF8) // max packet length without padding is 0xFFF8 (0xFFF9..0xFFFF must be padded, and 0x10000 is impossible, because such number cannot be represented in content_length field)
		{	realloc(offset + part.length + 8);
			const break_at = 0xFFF8 - (offset-header_offset);
			all.set(part.subarray(0, break_at), offset);
			offset += break_at;
			add_header();
			offset += 8; // space for next header
			part = part.subarray(break_at);
		}
		realloc(offset + part.length);
		all.set(part, offset);
		offset += part.length;
	}

	for (const [k, v] of value)
	{	const k_buf = encoder.encode(k);
		const v_buf = encoder.encode(v);
		const kv_header = new Uint8Array(8);
		let kv_offset = 0;
		// name
		if (k_buf.length <= 127)
		{	kv_header[kv_offset++] = k_buf.length;
		}
		else
		{	kv_header[kv_offset++] = 0x80 | (k_buf.length >> 24);
			kv_header[kv_offset++] = (k_buf.length >> 16) & 0xFF;
			kv_header[kv_offset++] = (k_buf.length >> 8) & 0xFF;
			kv_header[kv_offset++] = k_buf.length & 0xFF;
		}
		// value
		if (v_buf.length <= 127)
		{	kv_header[kv_offset++] = v_buf.length;
		}
		else
		{	kv_header[kv_offset++] = 0x80 | (v_buf.length >> 24);
			kv_header[kv_offset++] = (v_buf.length >> 16) & 0xFF;
			kv_header[kv_offset++] = (v_buf.length >> 8) & 0xFF;
			kv_header[kv_offset++] = v_buf.length & 0xFF;
		}
		add(kv_header.subarray(0, kv_offset));
		add(k_buf);
		add(v_buf);
	}

	add_header();

	// write
	return all.subarray(0, offset);
}
