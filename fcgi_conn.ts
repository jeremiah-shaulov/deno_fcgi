import {debug_assert} from './debug_assert.ts';
import {pack_nvp} from "./server_request.ts";
import {Server} from "./server.ts";
import {SetCookies} from "./set_cookies.ts";
import {writeAll} from 'https://deno.land/std@0.97.0/io/util.ts';

export const RECYCLE_REQUEST_ID_AFTER = 1024; // max: 0xFFFF. big number slows down unit testing

const CR = '\r'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);
const TAB = '\t'.charCodeAt(0);
const SPACE = ' '.charCodeAt(0);
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

debug_assert(RECYCLE_REQUEST_ID_AFTER>=1 && RECYCLE_REQUEST_ID_AFTER<=0xFFFF); // number must fit uint16_t

export class FcgiConn
{	public request_till = 0; // for connections pool - 0 means no ongoing request, >0 means is executing request with timeout till this time
	public use_till = Infinity; // if keepAliveTimeout specified
	public use_n_times = Infinity; // if keepAliveMax specified

	public headers = new Headers;
	public cookies = new SetCookies;
	public on_log_error: ((error: string) => void) | undefined;

	private request_id = 0;
	private buffer_8 = new Uint8Array(8);

	constructor(private conn: Deno.Conn)
	{
	}

	close()
	{	this.conn.close();
	}

	async write_request(params: Map<string, string>, body: AsyncIterable<Uint8Array> | null, keep_conn: boolean)
	{	if (this.request_id >= RECYCLE_REQUEST_ID_AFTER)
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
		await this.write_record_stdin(this.request_id, this.buffer_8.subarray(0, 0), true);
	}

	async *read_response(buffer: Uint8Array): AsyncGenerator<number, void, Uint8Array>
	{	let headers_read = false;
		let headers_buffer: Uint8Array | undefined;
		let headers_buffer_len = 0;
		let {headers, cookies, on_log_error} = this;

		function add_header(line: Uint8Array)
		{	if (line.length == 0)
			{	headers_read = true;
				headers_buffer = undefined;
			}
			else
			{	let pos = line.indexOf(COLON);
				let name = new TextDecoder().decode(line.subarray(0, pos)).trim().toLowerCase();
				pos++;
				while (line[pos]==SPACE || line[pos]==TAB)
				{	pos++;
				}
				if (name == 'set-cookie')
				{	cookies?.addSetCookie(line.subarray(pos));
				}
				else
				{	if (headers)
					{	let value = new TextDecoder().decode(line.subarray(pos)).trim();
						try
						{	headers.set(name, value);
						}
						catch
						{	// assume: "is not a legal HTTP header value"
						}
					}
				}
			}
		}

		function cut_headers(data: Uint8Array)
		{	if (!headers_read && data[0]===LF && headers_buffer && headers_buffer[headers_buffer_len-1]===CR)
			{	add_header(headers_buffer.subarray(0, headers_buffer_len-1));
				data = data.subarray(1);
				headers_buffer_len = 0;
			}
			let pos = 0;
			while (!headers_read && data.length>0)
			{	pos = data.indexOf(CR, pos);
				if (pos==-1 || pos==data.length-1)
				{	if (!headers_buffer || headers_buffer_len+data.length > headers_buffer.length)
					{	// realloc
						let tmp = new Uint8Array(Math.max(128, (headers_buffer?.length || 0)*2, headers_buffer_len+data.length));
						if (headers_buffer)
						{	tmp.set(headers_buffer.subarray(0, headers_buffer_len));
						}
						headers_buffer = tmp;
					}
					headers_buffer.set(data, headers_buffer_len);
					headers_buffer_len += data.length;
					break;
				}
				if (data[pos+1] == LF)
				{	let subj = data;
					if (headers_buffer_len>0 && headers_buffer)
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
					pos = 0;
				}
				else
				{	pos++;
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
					{	let n = await this.conn.read(buffer.subarray(0, Math.min(content_length+padding_length, buffer.length)));
						if (n == null)
						{	throw new Error('Unexpected end of stream');
						}
						let data = buffer.subarray(0, Math.min(n, content_length));
						if (record_type == FCGI_STDOUT)
						{	data = cut_headers(data);
							debug_assert(!headers_read || headers_buffer_len==0);
							if (headers_read && data.length>0)
							{	let n_shift = data.byteOffset - buffer.byteOffset;
								if (n_shift > 0)
								{	buffer.copyWithin(0, n_shift, n_shift+data.length);
								}
								buffer = yield data.length;
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
				}
				else if (record_type == FCGI_END_REQUEST)
				{	await this.read_exact(this.buffer_8);
					let protocol_status = this.buffer_8[4]; // TODO: ...
					while (padding_length > 0)
					{	let n = await this.conn.read(buffer.subarray(0, Math.min(padding_length, buffer.length)));
						if (n == null)
						{	throw new Error('Unexpected end of stream');
						}
						padding_length -= n;
					}
					break;
				}
			}
			let n_skip = content_length + padding_length; // negative "content_length" means that part of padding is already consumed
			while (n_skip > buffer.length)
			{	await this.read_exact(buffer);
				n_skip -= buffer.length;
			}
			await this.read_exact(buffer.subarray(0,  n_skip));
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
	{	let payload = this.buffer_8;
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
		{	await this.write_record(FCGI_PARAMS, request_id, this.buffer_8.subarray(0, 0)); // empty record terminates stream
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
		{	await this.write_record(FCGI_STDIN, request_id, this.buffer_8.subarray(0, 0)); // empty record terminates stream
		}
	}

	write_record_abort_request(request_id: number)
	{	return this.write_record(FCGI_ABORT_REQUEST, request_id, this.buffer_8.subarray(0, 0));
	}

	private async read_exact(buffer: Uint8Array)
	{	let pos = 0;
		while (pos < buffer.length)
		{	let n = await this.conn.read(buffer.subarray(pos, buffer.length));
			if (n == null)
			{	throw new Error('Unexpected end of stream');
			}
			pos += n;
		}
	}

	async read_record_header(): Promise<{record_type: number, request_id: number, content_length: number, padding_length: number}>
	{	await this.read_exact(this.buffer_8);
		let header = new DataView(this.buffer_8.buffer);
		let record_type = header.getUint8(1);
		let request_id = header.getUint16(2);
		let content_length = header.getUint16(4);
		let padding_length = header.getUint8(6);
		return {record_type, request_id, content_length, padding_length};
	}

	async read_record_get_values_result(content_length: number, padding_length: number): Promise<Map<string, string>>
	{	// To parse the FCGI_GET_VALUES_RESULT record, i will use Server object with fake listener, and send to it a fake request,
		// where FCGI_GET_VALUES_RESULT will be given in place of FCGI_PARAMS (they are compatible).
		const REC_BEGIN_REQUEST_LEN = 16;
		const REC_PARAMS_HEADER_LEN = 8;
		const REC_STDIN_LEN = 8;
		let data_len = REC_BEGIN_REQUEST_LEN + REC_PARAMS_HEADER_LEN + content_length + padding_length + REC_STDIN_LEN;
		let data = new Uint8Array(data_len);
		let data_view = new DataView(data.buffer);

		// 1. Set FCGI_BEGIN_REQUEST header
		data_view.setUint8(0, 1); // version
		data_view.setUint8(1, FCGI_BEGIN_REQUEST); // record_type
		data_view.setUint16(2, 1); // request_id
		data_view.setUint16(4, 8); // content_length
		data_view.setUint16(6, 0); // padding_length=0, reserved=0

		// 2. Set FCGI_BEGIN_REQUEST
		data_view.setUint16(8, FCGI_RESPONDER); // role
		data_view.setUint16(10, 0); // flags=0, reserved=0
		data_view.setUint32(12, 0); // reserved

		// 3. Set header of FCGI_PARAMS record, so i can parse it as params.
		data_view.setUint8(16, 1); // version
		data_view.setUint8(17, FCGI_PARAMS); // record_type
		data_view.setUint16(18, 1); // request_id
		data_view.setUint16(20, content_length); // content_length
		data_view.setUint8(22, padding_length); // padding_length
		data_view.setUint8(23, 0); // reserved

		// 4. Read content_length and padding_length of the FCGI_GET_VALUES_RESULT record
		let pos = REC_BEGIN_REQUEST_LEN + REC_PARAMS_HEADER_LEN;
		let end_pos = pos + content_length + padding_length;
		while (pos < end_pos)
		{	let n = await this.conn.read(data.subarray(pos, end_pos));
			if (n == null)
			{	throw new Error('Unexpected end of stream');
			}
			pos += n;
		}

		// 5. Set empty FCGI_STDIN
		pos = end_pos;
		data_view.setUint8(pos+0, 1); // version
		data_view.setUint8(pos+1, FCGI_STDIN); // record_type
		data_view.setUint16(pos+2, 1); // request_id
		data_view.setUint32(pos+4, 0); // content_length=0, padding_length=0, reserved=0

		// 6. Use Server to parse the request
		let read_pos = 0;
		let server = new Server
		(	{	addr: {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: 1},
				rid: 1,

				async *[Symbol.asyncIterator](): AsyncGenerator<Deno.Conn, void, unknown>
				{	yield await this.accept();
				},

				async accept(): Promise<Deno.Conn>
				{	if (read_pos != 0)
					{	throw new Error('Failed to get constants');
					}
					let conn =
					{	localAddr: {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: 1},
						remoteAddr: {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: 2},
						rid: 1,

						async read(buffer: Uint8Array): Promise<number | null>
						{	let chunk_size = Math.min(buffer.length, data.length-read_pos);
							buffer.set(data.subarray(read_pos, read_pos+chunk_size));
							read_pos += chunk_size;
							return chunk_size || null;
						},

						async write(buffer: Uint8Array): Promise<number>
						{	return buffer.length;
						},

						async closeWrite()
						{
						},

						close()
						{
						}
					};
					return conn;
				},

				close()
				{
				}
			}
		);
		let params;
		for await (let req of server)
		{	params = req.params;
			await req.respond();
			server.close();
		}

		// 7. Done
		return params || new Map;
	}
}
