import {debug_assert} from './debug_assert.ts';
import {faddr_to_addr, addr_to_string} from './addr.ts';
import type {FcgiAddr} from './addr.ts';
import {pack_nvp} from "./server_request.ts";
import {SetCookies} from "./set_cookies.ts";
import {writeAll} from 'https://deno.land/std/io/util.ts';

export const SERVER_SOFTWARE = 'DenoFcgi/0.0';
const BUFFER_LEN = 8*1024;
const DEFAULT_TIMEOUT = 10000;

const CR = '\r'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);;
const TAB = '\t'.charCodeAt(0);
const SPACE = ' '.charCodeAt(0)
const COLON = ':'.charCodeAt(0);

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

debug_assert(BUFFER_LEN >= 255); // record padding must fit

export interface RequestOptions
{	/** FastCGI service address. For example address of PHP-FPM service (what appears in "listen" directive in PHP-FPM pool configuration file). */
	addr: FcgiAddr,
	/** `scriptFilename` can be specified here, or in `params` under 'SCRIPT_FILENAME' key. Note that if sending to PHP-FPM, the response will be empty unless you provide this parameter. This parameter must contain PHP script file name. */
	scriptFilename?: string,
	/** Additional parameters to send to FastCGI server. If sending to PHP, they will be found in $_SERVER. If `params` object is given, it will be modified - `scriptFilename` and parameters inferred from request URL will be added to it. */
	params?: Map<string, string>,
	keepAliveTimeout?: number,
	keepAliveMax?: number,
	timeout?: number,
	/** Handler for errors logged from the requested service. */
	onLogError?: (error: string) => void,
}

export class ResponseWithCookies extends Response
{	constructor(body?: BodyInit|null|undefined, init?: ResponseInit|undefined, public cookies = new SetCookies)
	{	super(body, init);
	}
}

export class Client
{	private conns_manager = new ConnsManager;

	async fcgi_fetch(server_options: RequestOptions, input: Request|URL|string, init?: RequestInit): Promise<ResponseWithCookies>
	{	// server_addr
		let server_addr = faddr_to_addr(server_options.addr);
		let server_addr_str = addr_to_string(server_addr);
		// input
		if (!(input instanceof Request))
		{	input = new Request(input+'', init);
		}
		// params
		let {params, scriptFilename, timeout} = server_options;
		if (params == undefined)
		{	params = new Map;
		}
		if (scriptFilename != undefined)
		{	params.set('SCRIPT_FILENAME', scriptFilename);
		}
		let url_obj = new URL(input.url, 'https://deno.land/x/fcgi/');
		params.set('REQUEST_METHOD', input.method.toUpperCase());
		params.set('REQUEST_SCHEME', url_obj.protocol.slice(0, -1));
		params.set('HTTP_HOST', url_obj.hostname);
		params.set('REQUEST_URI', url_obj.pathname + url_obj.search);
		params.set('QUERY_STRING', url_obj.search.slice(1));
		params.set('SERVER_SOFTWARE', SERVER_SOFTWARE);
		for (let [name, value] of input.headers)
		{	params.set('HTTP_'+name.replaceAll('-', '_').toUpperCase(), value);
		}
		//
		let headers = new Headers;
		let cookies = new SetCookies;
		let {conns_manager} = this;
		// get_conn
		let conn = await conns_manager.get_conn(server_addr_str, server_addr);
		// query
		try
		{	await conn.write_request(params, input.body, false);
			var it = conn.read_response(headers, cookies, server_options.onLogError);
			var {value, done} = await it.next();
		}
		catch (e)
		{	conns_manager.return_conn(server_addr_str, conn);
			throw e;
		}
		// return
		let status_str = headers.get('status') || '';
		let pos = status_str.indexOf(' ');
		let is_terminated = false;
		let h_timeout = setTimeout
		(	() =>
			{	if (!is_terminated)
				{	conn.close();
				}
			},
			timeout || DEFAULT_TIMEOUT
		);
		return new ResponseWithCookies
		(	done ? value : new ReadableStream
			(	{	type: 'bytes',
					start(controller)
					{	controller.enqueue(value);
					},
					async pull(controller)
					{	let {value, done} = await it.next();
						if (done)
						{	is_terminated = true;
							clearTimeout(h_timeout);
							conns_manager.return_conn(server_addr_str, conn);
							controller.close();
						}
						else
						{	controller.enqueue(value);
						}
					}
				}
			),
			{	status: parseInt(status_str) || 200,
				statusText: pos==-1 ? '' : status_str.slice(pos+1).trim(),
				headers
			},
			cookies
		);
	}
}

class ConnsManager
{	private conns_map = new Map<string, FcgiConn[]>();

	async get_conn(server_addr_str: string, server_addr: Deno.Addr)
	{	let conns = this.conns_map.get(server_addr_str);
		if (!conns)
		{	conns = [];
			this.conns_map.set(server_addr_str, conns);
		}
		let conn = conns.pop();
		if (!conn)
		{	conn = new FcgiConn(await Deno.connect(server_addr as any));
		}
		return conn;
	}

	return_conn(server_addr_str: string, conn: FcgiConn)
	{	conn.close();
	}
}

class FcgiConn
{	private request_id = 0;
	private buffer = new Uint8Array(BUFFER_LEN);

	constructor(private conn: Deno.Conn)
	{
	}

	close()
	{	this.conn.close();
	}

	async write_request(params: Map<string, string>, body: ReadableStream<Uint8Array> | null, keep_conn: boolean)
	{	if (this.request_id >= 0xFFFF)
		{	this.request_id = 0;
		}
		this.request_id++;
		await this.write_record_begin_request(this.request_id, 'responder', keep_conn);
		await this.write_record_params(this.request_id, params, true);
		if (body)
		{	for await (let chunk of body)
			{	await this.write_record_stdin(this.request_id, chunk, false);
			}
		}
		await this.write_record_stdin(this.request_id, new Uint8Array, true);
	}

	async *read_response(headers?: Headers, cookies?: SetCookies, on_log_error?: (error: string) => void): AsyncGenerator<Uint8Array>
	{	let headers_read = false;
		let headers_buffer: Uint8Array | undefined;
		let headers_buffer_len = 0;
		function add_header(line: Uint8Array)
		{	if (line.length == 0)
			{	headers_read = true;
				headers_buffer = undefined;
				debug_assert(headers_buffer_len == 0);
			}
			else if (headers || cookies)
			{	let pos = line.indexOf(COLON);
				let name = new TextDecoder().decode(line.subarray(0, pos)).trim().toLowerCase();
				pos++;
				while (line[pos]==SPACE || line[pos]==TAB)
				{	pos++;
				}
				if (name == 'set-cookie')
				{	if (cookies)
					{	cookies.addSetCookie(line.subarray(pos));
					}
				}
				else
				{	if (headers)
					{	let value = new TextDecoder().decode(line.subarray(pos)).trim();
						headers.set(name, value);
					}
				}
			}
		}
		function cut_headers(data: Uint8Array)
		{	if (!headers_read && data.length>0 && headers_buffer && headers_buffer_len>0 && headers_buffer[0]==CR && data[0]==LF)
			{	add_header(headers_buffer.subarray(0, headers_buffer_len-1));
				data = data.subarray(1);
				headers_buffer_len = 0;
			}
			while (!headers_read && data.length>0)
			{	let pos = data.indexOf(CR);
				if (pos!=-1 && pos!=data.length-1)
				{	if (data[pos+1] == LF)
					{	let subj = data;
						if (headers_buffer && headers_buffer_len>0)
						{	if (headers_buffer_len+pos > headers_buffer.length)
							{	// realloc
								let tmp = new Uint8Array(Math.max(headers_buffer.length*2, headers_buffer_len+pos));
								tmp.set(headers_buffer.subarray(0, headers_buffer_len));
								headers_buffer = tmp;
							}
							headers_buffer.set(data.subarray(0, pos), headers_buffer_len);
							subj = headers_buffer;
						}
						add_header(subj.subarray(0, headers_buffer_len+pos));
						headers_buffer_len = 0;
						data = data.subarray(pos+2); // after \r\n
					}
					else
					{	pos++;
					}
				}
				else
				{	if (!headers_buffer || headers_buffer_len+data.length > headers_buffer.length)
					{	// realloc
						let tmp = new Uint8Array(Math.max((headers_buffer?.length || 0)*2, headers_buffer_len+data.length));
						if (headers_buffer)
						{	tmp.set(headers_buffer.subarray(0, headers_buffer_len));
						}
						headers_buffer = tmp;
					}
					headers_buffer.set(data, headers_buffer_len);
					headers_buffer_len += data.length;
					break;
				}
			}
			return data;
		}
		while (true)
		{	let {record_type, request_id, content_length, padding_length} = await this.read_record_header();
			if (request_id == this.request_id)
			{	if (record_type==FCGI_STDOUT || record_type==FCGI_STDERR)
				{	let stderr: Uint8Array | undefined;
					let stderr_len = 0;
					while (content_length > 0)
					{	let n = await this.conn.read(this.buffer.subarray(0, Math.min(content_length+padding_length, BUFFER_LEN)));
						if (n == null)
						{	throw new Error('Unexpected end of stream');
						}
						let data = this.buffer.subarray(0, Math.min(n, content_length));
						if (record_type == FCGI_STDOUT)
						{	data = cut_headers(data);
							if (data.length > 0)
							{	yield data;
							}
						}
						else
						{	if (!stderr || stderr_len+data.length>stderr.length)
							{	// realloc
								let tmp = new Uint8Array(Math.max((stderr?.length || 0)*2, stderr_len+data.length));
								if (stderr)
								{	tmp.set(stderr.subarray(0, stderr_len));
								}
								stderr = tmp;
							}
							stderr.set(data, stderr_len);
							stderr_len += data.length;
						}
						content_length -= n;
					}
					if (stderr)
					{	on_log_error?.(new TextDecoder().decode(stderr.subarray(0, stderr_len)));
					}
					padding_length += content_length;
					while (padding_length > 0)
					{	let n = await this.conn.read(this.buffer.subarray(0, padding_length));
						if (n == null)
						{	throw new Error('Unexpected end of stream');
						}
						padding_length -= n;
					}
				}
				else if (record_type == FCGI_END_REQUEST)
				{	break;
				}
			}
		}
	}

	write_record(record_type: number, request_id: number, payload: string|Uint8Array)
	{	let payload_bytes = typeof(payload)!='string' ? payload : new TextEncoder().encode(payload);
		let padding = (8 - payload_bytes.length%8) % 8;
		let n_records = Math.ceil(payload_bytes.length / 0xFFFF) || 1; // 0..=0xFFFF = 1rec, 0x10000..=0xFFFF*2 = 2rec
		let buffer = new Uint8Array(8*n_records + payload_bytes.length + padding);
		let pos = 0;
		while (payload_bytes.length > 0xFFFF)
		{	// header
			let header = new DataView(buffer.buffer, pos);
			header.setUint8(0, 1); // version
			header.setUint8(1, record_type); // type
			header.setUint16(2, request_id); // request_id
			header.setUint16(4, 0xFFFF); // content_length
			header.setUint8(6, 0); // padding_length
			pos += 8;
			// payload
			buffer.set(payload_bytes.subarray(0, 0xFFFF), pos);
			payload_bytes = payload_bytes.subarray(0xFFFF);
			pos += 0xFFFF;
		}
		// header
		let header = new DataView(buffer.buffer, pos);
		header.setUint8(0, 1); // version
		header.setUint8(1, record_type); // type
		header.setUint16(2, request_id); // request_id
		header.setUint16(4, payload_bytes.length); // content_length
		header.setUint8(6, padding); // padding_length
		pos += 8;
		// payload
		buffer.set(payload_bytes, pos);
		pos += payload_bytes.length + padding;
		debug_assert(pos == buffer.length);
		// pend_read
		return writeAll(this.conn, buffer);
	}

	write_record_begin_request(request_id: number, role: 'responder'|'authorizer'|'filter', keep_conn: boolean)
	{	let payload = new Uint8Array(8);
		let p = new DataView(payload.buffer);
		p.setUint16(0, role=='responder' ? FCGI_RESPONDER : role=='authorizer' ? FCGI_AUTHORIZER : FCGI_FILTER);
		p.setUint8(2, keep_conn ? FCGI_KEEP_CONN : 0);
		return this.write_record(FCGI_BEGIN_REQUEST, request_id, payload);
	}

	async write_record_params(request_id: number, params: Map<string, string>, is_terminal: boolean)
	{	let data = pack_nvp(FCGI_PARAMS, request_id, params, 0x7FFFFFFF, 0x7FFFFFFF);
		if (data.length > 8)
		{	await writeAll(this.conn, data);
		}
		if (is_terminal)
		{	await this.write_record(FCGI_PARAMS, request_id, new Uint8Array); // empty record terminates stream
		}
	}

	async write_record_get_values(params: Map<string, string>)
	{	let data = pack_nvp(FCGI_GET_VALUES, 0, params, 0x7FFFFFFF, 0x7FFFFFFF);
		if (data.length > 8)
		{	await writeAll(this.conn, data);
		}
	}

	async write_record_stdin(request_id: number, str: string|Uint8Array, is_terminal: boolean)
	{	if (str.length > 0)
		{	await this.write_record(FCGI_STDIN, request_id, str);
		}
		if (is_terminal)
		{	await this.write_record(FCGI_STDIN, request_id, new Uint8Array); // empty record terminates stream
		}
	}

	write_record_abort_request(request_id: number)
	{	return this.write_record(FCGI_ABORT_REQUEST, request_id, new Uint8Array);
	}

	private async read_record_header(): Promise<{record_type: number, request_id: number, content_length: number, padding_length: number}>
	{	// read first 8 bytes
		let buffer = new Uint8Array(8);
		let pos = 0;
		while (pos < 8)
		{	let n = await this.conn.read(buffer.subarray(pos));
			if (n == null)
			{	throw new Error('Unexpected end of stream');
			}
			pos += n;
		}
		// interpret first 8 bytes as header
		let header = new DataView(buffer.buffer);
		let record_type = header.getUint8(1);
		let request_id = header.getUint16(2);
		let content_length = header.getUint16(4);
		let padding_length = header.getUint8(6);
		return {record_type, request_id, content_length, padding_length};
	}
}
