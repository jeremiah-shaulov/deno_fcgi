import {ServerRequest, pack_nvp} from "../server_request.ts";
import {ServerOptions} from "../server.ts";

export const TEST_CHUNK_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 20, 25, 30, 33, 44, 55, 80, 81, 91, 100, 110, 123, 150, 201, 300, 400, 500, 1000, 10_000, 100_000];
//export const TEST_CHUNK_SIZES = [8];

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


export class MockConn implements Deno.Reader, Deno.Writer, Deno.Closer
{	public is_closed = false;

	protected read_data: Uint8Array;
	protected read_pos = 0;
	protected write_data = new Uint8Array(1024);
	protected write_pos = 0;

	constructor(str='', protected chunk_size=10)
	{	this.read_data = new TextEncoder().encode(str);
	}

	async read(buffer: Uint8Array): Promise<number|null>
	{	if (this.read_pos == this.read_data.length)
		{	return null;
		}
		let chunk_size = Math.min(this.read_data.length-this.read_pos, buffer.length, this.chunk_size);
		buffer.set(this.read_data.subarray(this.read_pos, this.read_pos+chunk_size));
		this.read_pos += chunk_size;
		return chunk_size;
	}

	async write(buffer: Uint8Array): Promise<number>
	{	if (this.write_data.length-this.write_pos < this.chunk_size)
		{	// realloc
			let tmp = new Uint8Array(this.write_data.length * 2);
			tmp.set(this.write_data);
			this.write_data = tmp;
		}
		let chunk_size = Math.min(buffer.length, this.chunk_size);
		this.write_data.set(buffer.subarray(0, chunk_size), this.write_pos);
		return chunk_size;
	}

	close()
	{	this.is_closed = true;
	}

	toString()
	{	return new TextDecoder().decode(this.write_data.subarray(0, this.write_pos));
	}
}

export class MockServer extends MockConn
{	public is_retired = false;
	public is_retired_self = false;

	constructor(private options: ServerOptions, chunk_size: number, private with_padding=true, private split_stream_records=false)
	{	super('', chunk_size);
	}

	pend_read(data: string|Uint8Array)
	{	let bytes = typeof(data)!='string' ? data : new TextEncoder().encode(data);
		let tmp_2 = new Uint8Array(this.read_data.length + bytes.length);
		tmp_2.set(this.read_data);
		tmp_2.set(bytes, this.read_data.length);
		this.read_data = tmp_2;
	}

	pend_read_fcgi(record_type: number, request_id: number, payload: string|Uint8Array)
	{	let offset = this.read_data.length;
		let payload_bytes = typeof(payload)!='string' ? payload : new TextEncoder().encode(payload);
		let padding = !this.with_padding ? 0 : (8 - payload_bytes.length%8) % 8;
		let tmp_2 = new Uint8Array(offset + 8 + payload_bytes.length + padding);
		tmp_2.set(this.read_data);
		tmp_2.set(payload_bytes, offset + 8);
		let header = new DataView(tmp_2.buffer);
		header.setUint8(offset+0, 1); // version
		header.setUint8(offset+1, record_type); // type
		header.setUint16(offset+2, request_id); // request_id
		header.setUint16(offset+4, payload_bytes.length); // content_length
		header.setUint8(offset+6, padding); // padding_length
		this.read_data = tmp_2;
	}

	pend_read_fcgi_begin_request(request_id: number, role: 'responder'|'authorizer'|'filter', keep_conn: boolean)
	{	let payload = new Uint8Array(8);
		let p = new DataView(payload.buffer);
		p.setUint16(0, role=='responder' ? FCGI_RESPONDER : role=='authorizer' ? FCGI_AUTHORIZER : FCGI_FILTER);
		p.setUint8(2, keep_conn ? FCGI_KEEP_CONN : 0);
		this.pend_read_fcgi(FCGI_BEGIN_REQUEST, request_id, payload);
	}

	pend_read_fcgi_params(request_id: number, params: any)
	{	let map = new Map<string, string>(Object.entries(params));
		if (!this.split_stream_records || map.size<=1)
		{	this.pend_read(pack_nvp(FCGI_PARAMS, request_id, map, 100000, 100000));
		}
		else
		{	let k_0 = [...map.keys()][0];
			let map_0 = new Map<string, string>([[k_0, map.get(k_0)+'']]);
			map.delete(k_0);
			this.pend_read(pack_nvp(FCGI_PARAMS, request_id, map_0, 100000, 100000));
			this.pend_read(pack_nvp(FCGI_PARAMS, request_id, map, 100000, 100000));
		}
		this.pend_read_fcgi(FCGI_PARAMS, request_id, new Uint8Array); // empty record terminates stream
	}

	pend_read_fcgi_stdin(request_id: number, str: string)
	{	if (!this.split_stream_records || str.length<=1)
		{	this.pend_read_fcgi(FCGI_STDIN, request_id, str);
		}
		else
		{	this.pend_read_fcgi(FCGI_STDIN, request_id, str.slice(0, 1));
			this.pend_read_fcgi(FCGI_STDIN, request_id, str.slice(1));
		}
		this.pend_read_fcgi(FCGI_STDIN, request_id, new Uint8Array); // empty record terminates stream
	}

	async accept(): Promise<ServerRequest>
	{	let that = this;
		let req = new ServerRequest
		(	{	retired(request?: ServerRequest)
				{	that.is_retired = true;
					that.is_retired_self = request != undefined;
				}
			},
			this,
			console.error.bind(console),
			null,
			this.options.structuredParams || false,
			this.options.maxConns || 1,
			this.options.maxNameLength || 100,
			this.options.maxValueLength || 1000,
			this.options.maxFileSize || 10000,
			false
		);
		await req.poll();
		return req;
	}
}
