import {debug_assert} from './debug_assert.ts';
import {Conn, Reader} from './deno_ifaces.ts';
import {pack_nvp} from "./server_request.ts";
import {Server} from "./server.ts";
import {SetCookies} from "./set_cookies.ts";
import {writeAll} from './deps.ts';

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
const _FCGI_DATA              =  8;
const FCGI_GET_VALUES         =  9;
const _FCGI_GET_VALUES_RESULT = 10;
const _FCGI_UNKNOWN_TYPE      = 11;

const _FCGI_REQUEST_COMPLETE  =  0;
const FCGI_CANT_MPX_CONN      =  1;
const FCGI_OVERLOADED         =  2;
const FCGI_UNKNOWN_ROLE       =  3;

const FCGI_RESPONDER          =  1;
const FCGI_AUTHORIZER         =  2;
const FCGI_FILTER             =  3;

const FCGI_KEEP_CONN          =  1;

debug_assert(RECYCLE_REQUEST_ID_AFTER>=1 && RECYCLE_REQUEST_ID_AFTER<=0xFFFF); // number must fit uint16_t

const encoder = new TextEncoder;
const decoder = new TextDecoder;

export class FcgiConn
{	request_till = 0; // for connections pool - 0 means no ongoing request, >0 means is executing request with timeout till this time
	use_till = Number.MAX_SAFE_INTEGER; // if keepAliveTimeout specified
	use_n_times = Number.MAX_SAFE_INTEGER; // if keepAliveMax specified

	headers = new Headers;
	cookies = new SetCookies;
	app_status = 0;
	on_log_error: ((error: string) => void) | undefined;

	private request_id = 0;
	private buffer_8 = new Uint8Array(8);

	constructor(private conn: Conn)
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
		{	let promise;
			for await (const chunk of body)
			{	if (promise)
				{	await promise;
				}
				promise = this.write_record_stdin(this.request_id, chunk, false);
			}
			if (promise)
			{	await promise;
			}
		}
		await this.write_record_stdin(this.request_id, this.buffer_8.subarray(0, 0), true);
	}

	get_response_reader(): Reader
	{	let headers_read = false;
		let headers_buffer: Uint8Array | undefined;
		let headers_buffer_len = 0;
		let is_reading_content = false;
		let cur_content_length = 0;
		let cur_padding_length = 0;
		const {headers, cookies, on_log_error} = this;
		// deno-lint-ignore no-this-alias
		const that = this;

		function add_header(line: Uint8Array)
		{	if (line.length == 0)
			{	headers_read = true;
				headers_buffer = undefined;
			}
			else
			{	let pos = line.indexOf(COLON);
				const name = decoder.decode(line.subarray(0, pos)).trim().toLowerCase();
				pos++;
				while (line[pos]==SPACE || line[pos]==TAB)
				{	pos++;
				}
				if (name == 'set-cookie')
				{	cookies?.addSetCookie(line.subarray(pos));
				}
				else
				{	if (headers)
					{	const value = decoder.decode(line.subarray(pos)).trim();
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
						const tmp = new Uint8Array(Math.max(128, (headers_buffer?.length || 0)*2, headers_buffer_len+data.length));
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
							const tmp = new Uint8Array(Math.max(headers_buffer.length*2, headers_buffer_len+pos));
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

		async function read(buffer: Uint8Array)
		{	// deno-lint-ignore no-var
			var content_length = 0;
			// deno-lint-ignore no-var
			var padding_length = 0;
			while (true)
			{	if (!is_reading_content)
				{	// deno-lint-ignore no-inner-declarations no-var no-redeclare
					var {record_type, request_id, content_length, padding_length} = await that.read_record_header();
					if (request_id == that.request_id)
					{	switch (record_type)
						{	case FCGI_STDERR:
								if (record_type==FCGI_STDERR && on_log_error && content_length>0)
								{	const n_skip = content_length + padding_length;
									const stderr = n_skip<=buffer.length ? buffer.subarray(0,  n_skip) : new Uint8Array(n_skip);
									await that.read_exact(stderr);
									on_log_error(decoder.decode(stderr.subarray(0, content_length)));
									continue;
								}
								break;
							case FCGI_STDOUT:
								while (content_length > 0)
								{	const n = await that.conn.read(buffer.subarray(0, Math.min(content_length+padding_length, buffer.length)));
									if (n == null)
									{	throw new Error('Unexpected end of stream');
									}
									let data = buffer.subarray(0, Math.min(n, content_length));
									data = cut_headers(data);
									debug_assert(!headers_read || headers_buffer_len==0);
									content_length -= n; // negative "content_length" means that part of padding is already consumed
									if (headers_read && data.length>0)
									{	const n_shift = data.byteOffset - buffer.byteOffset;
										if (n_shift > 0)
										{	buffer.copyWithin(0, n_shift, n_shift+data.length);
										}
										is_reading_content = true;
										cur_content_length = content_length;
										cur_padding_length = padding_length;
										return data.length;
									}
								}
								break;
							case FCGI_END_REQUEST:
								{	await that.read_exact(that.buffer_8);
									const data = new DataView(that.buffer_8.buffer);
									that.app_status = data.getInt32(0);
									const protocol_status = data.getUint8(4);
									while (padding_length > 0)
									{	const n = await that.conn.read(buffer.subarray(0, Math.min(padding_length, buffer.length)));
										if (n == null)
										{	throw new Error('Unexpected end of stream');
										}
										padding_length -= n;
									}
									if (protocol_status == FCGI_CANT_MPX_CONN)
									{	throw new Error('This service cannot multiplex connections');
									}
									if (protocol_status == FCGI_OVERLOADED)
									{	throw new Error('Service overloaded');
									}
									if (protocol_status == FCGI_UNKNOWN_ROLE)
									{	throw new Error("Service doesn't support responder role");
									}
								}
								return null;
						}
					}
				}
				else if (cur_content_length > 0)
				{	const n = await that.conn.read(buffer.subarray(0, Math.min(cur_content_length+cur_padding_length, buffer.length)));
					if (n == null)
					{	throw new Error('Unexpected end of stream');
					}
					const data = buffer.subarray(0, Math.min(n, cur_content_length));
					cur_content_length -= n; // negative "content_length" means that part of padding is already consumed
					return data.length;
				}
				else
				{	is_reading_content = false;
					content_length = cur_content_length;
					padding_length = cur_padding_length;
				}
				let n_skip = content_length + padding_length; // negative "content_length" means that part of padding is already consumed
				while (n_skip > buffer.length)
				{	await that.read_exact(buffer);
					n_skip -= buffer.length;
				}
				await that.read_exact(buffer.subarray(0,  n_skip));
			}
		}

		return {read};
	}

	write_record(record_type: number, request_id: number, payload: string|Uint8Array)
	{	let payload_bytes = typeof(payload)!='string' ? payload : encoder.encode(payload);
		const padding = (8 - payload_bytes.length%8) % 8;
		const n_records = Math.ceil(payload_bytes.length / 0xFFFF) || 1; // 0..=0xFFFF = 1rec, 0x10000..=0xFFFF*2 = 2rec
		const buffer = new Uint8Array(8*n_records + payload_bytes.length + padding);
		let pos = 0;
		while (payload_bytes.length > 0xFFFF)
		{	// header
			const header = new DataView(buffer.buffer, pos);
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
		const header = new DataView(buffer.buffer, pos);
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
	{	const payload = this.buffer_8;
		const p = new DataView(payload.buffer);
		p.setUint16(0, role=='responder' ? FCGI_RESPONDER : role=='authorizer' ? FCGI_AUTHORIZER : FCGI_FILTER);
		p.setUint8(2, keep_conn ? FCGI_KEEP_CONN : 0);
		return this.write_record(FCGI_BEGIN_REQUEST, request_id, payload);
	}

	async write_record_params(request_id: number, params: Map<string, string>, is_terminal: boolean)
	{	const data = pack_nvp(FCGI_PARAMS, request_id, params, 0x7FFF_FFFF, 0x7FFF_FFFF);
		if (data.length > 8)
		{	await writeAll(this.conn, data);
		}
		if (is_terminal)
		{	await this.write_record(FCGI_PARAMS, request_id, this.buffer_8.subarray(0, 0)); // empty record terminates stream
		}
	}

	async write_record_get_values(params: Map<string, string>)
	{	const data = pack_nvp(FCGI_GET_VALUES, 0, params, 0x7FFF_FFFF, 0x7FFF_FFFF);
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
		{	const n = await this.conn.read(buffer.subarray(pos, buffer.length));
			if (n == null)
			{	throw new Error('Unexpected end of stream');
			}
			pos += n;
		}
	}

	async read_record_header(): Promise<{record_type: number, request_id: number, content_length: number, padding_length: number}>
	{	await this.read_exact(this.buffer_8);
		const header = new DataView(this.buffer_8.buffer);
		const record_type = header.getUint8(1);
		const request_id = header.getUint16(2);
		const content_length = header.getUint16(4);
		const padding_length = header.getUint8(6);
		return {record_type, request_id, content_length, padding_length};
	}

	async read_record_get_values_result(content_length: number, padding_length: number): Promise<Map<string, string>>
	{	// To parse the FCGI_GET_VALUES_RESULT record, i will use Server object with fake listener, and send to it a fake request,
		// where FCGI_GET_VALUES_RESULT will be given in place of FCGI_PARAMS (they are compatible).
		const REC_BEGIN_REQUEST_LEN = 16;
		const REC_PARAMS_HEADER_LEN = 8;
		const REC_STDIN_LEN = 8;
		const data_len = REC_BEGIN_REQUEST_LEN + REC_PARAMS_HEADER_LEN + content_length + padding_length + REC_STDIN_LEN;
		const data = new Uint8Array(data_len);
		const data_view = new DataView(data.buffer);

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
		const end_pos = pos + content_length + padding_length;
		while (pos < end_pos)
		{	const n = await this.conn.read(data.subarray(pos, end_pos));
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
		const server = new Server
		(	{	addr: {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: 1},
				rid: 1,

				async *[Symbol.asyncIterator](): AsyncGenerator<Conn, void, unknown>
				{	yield await this.accept();
				},

				// deno-lint-ignore require-await
				async accept(): Promise<Conn>
				{	if (read_pos != 0)
					{	throw new Error('Failed to get constants');
					}
					const conn =
					{	localAddr: {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: 1},
						remoteAddr: {transport: 'tcp' as 'tcp'|'udp', hostname: 'localhost', port: 2},
						rid: 1,

						get readable(): ReadableStream<Uint8Array>
						{	throw new Error('No need');
						},

						get writable(): WritableStream<Uint8Array>
						{	throw new Error('No need');
						},

						// deno-lint-ignore require-await
						async read(buffer: Uint8Array): Promise<number | null>
						{	const chunk_size = Math.min(buffer.length, data.length-read_pos);
							buffer.set(data.subarray(read_pos, read_pos+chunk_size));
							read_pos += chunk_size;
							return chunk_size || null;
						},

						// deno-lint-ignore require-await
						async write(buffer: Uint8Array): Promise<number>
						{	return buffer.length;
						},

						async closeWrite()
						{
						},

						ref()
						{
						},

						unref()
						{
						},

						close()
						{
						},

						[Symbol.dispose]()
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
		for await (const req of server)
		{	params = req.params;
			await req.respond();
			server.close();
		}

		// 7. Done
		return params || new Map;
	}
}
