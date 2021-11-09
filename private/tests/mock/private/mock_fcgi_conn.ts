import {MockConn} from './mock_conn.ts';
import {MockListener} from './mock_listener.ts';
import {Server} from "../../../server.ts";
import {pack_nvp} from "../../../server_request.ts";
import {assertEquals} from "https://deno.land/std@0.106.0/testing/asserts.ts";

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

const RECORD_TYPE_NAMES = ['', 'BEGIN_REQUEST', 'ABORT_REQUEST', 'END_REQUEST', 'PARAMS', 'STDIN', 'STDOUT', 'STDERR', 'DATA', 'GET_VALUES', 'GET_VALUES_RESULT', 'UNKNOWN_TYPE'];
const PROTOCOL_STATUSES = ['request_complete', 'cant_mpx_conn', 'overloaded', 'unknown_role'];

export class MockFcgiConn extends MockConn
{	private written_pos = new Map<number, number>();

	constructor(chunk_size: number, private force_padding=-1, private split_stream_records: 'no'|'yes'|'full'='no', localAddr?: Deno.Addr)
	{	super('', chunk_size, localAddr);
	}

	pend_read_fcgi(record_type: number, request_id: number, payload: string|Uint8Array)
	{	let payload_bytes = typeof(payload)!='string' ? payload : new TextEncoder().encode(payload);
		let padding = this.force_padding>=0 && this.force_padding<=255 ? this.force_padding : (8 - payload_bytes.length%8) % 8;
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
		assertEquals(pos, buffer.length);
		// pend_read
		this.pend_read(buffer);
	}

	pend_read_fcgi_begin_request(request_id: number, role: 'responder'|'authorizer'|'filter', keep_conn: boolean)
	{	let payload = new Uint8Array(8);
		let p = new DataView(payload.buffer);
		p.setUint16(0, role=='responder' ? FCGI_RESPONDER : role=='authorizer' ? FCGI_AUTHORIZER : FCGI_FILTER);
		p.setUint8(2, keep_conn ? FCGI_KEEP_CONN : 0);
		this.pend_read_fcgi(FCGI_BEGIN_REQUEST, request_id, payload);
	}

	pend_read_fcgi_params(request_id: number, params: any, is_get_values=false)
	{	let record_type = is_get_values ? FCGI_GET_VALUES : FCGI_PARAMS;
		let data = pack_nvp(record_type, request_id, new Map(Object.entries(params)), 0x7FFF_FFFF, 0x7FFF_FFFF);
		if (data.length > 8)
		{	let break_at = Math.min(this.chunk_size % 10, data.length-9); // choose break boundary depending on "chunk_size" (so will test many possibilities)
			if (this.split_stream_records=='no' || break_at<=0 || record_type==FCGI_GET_VALUES)
			{	this.pend_read(data);
			}
			else
			{	let part_0 = data.slice(0, 8+break_at); // header + "break_at" bytes
				let part_1 = data.slice(break_at); // space for new header + data starting at byte "break_at"
				let header_0 = new DataView(part_0.buffer);
				let header_1 = new DataView(part_1.buffer);
				let content_length = header_0.getUint16(4);
				let padding_length = header_0.getUint8(6);
				if (content_length <= break_at)
				{	this.pend_read(data);
				}
				else
				{	// header_0
					header_0.setUint8(0, 1); // version
					header_0.setUint8(1, record_type); // record_type
					header_0.setUint16(2, request_id); // request_id
					header_0.setUint16(4, break_at); // content_length
					header_0.setUint8(6, 0); // padding_length
					header_0.setUint8(7, 0); // reserved
					// header_1
					header_1.setUint8(0, 1); // version
					header_1.setUint8(1, record_type); // record_type
					header_1.setUint16(2, request_id); // request_id
					header_1.setUint16(4, content_length-break_at); // content_length
					header_1.setUint8(6, padding_length); // padding_length
					header_1.setUint8(7, 0); // reserved
					// send
					this.pend_read(part_0);
					this.pend_read(part_1);
				}
			}
		}
		if (!is_get_values)
		{	this.pend_read_fcgi(FCGI_PARAMS, request_id, new Uint8Array); // empty record terminates stream
		}
	}

	pend_read_fcgi_get_values(params: any)
	{	this.pend_read_fcgi_params(0, params, true);
	}

	pend_read_fcgi_stdin(request_id: number, str: string, abort=false, record_type=FCGI_STDIN)
	{	if (str.length > 0)
		{	if (this.split_stream_records=='no' || str.length<=1)
			{	this.pend_read_fcgi(record_type, request_id, str);
			}
			else
			{	this.pend_read_fcgi(record_type, request_id, str.slice(0, 1));
				let data = new TextEncoder().encode(str.slice(1));
				if (this.split_stream_records == 'full')
				{	while (data.length > this.chunk_size)
					{	this.pend_read_fcgi(record_type, request_id, data.subarray(0, this.chunk_size));
						data = data.subarray(this.chunk_size);
					}
				}
				this.pend_read_fcgi(record_type, request_id, data);
			}
		}
		this.pend_read_fcgi(abort ? FCGI_ABORT_REQUEST : record_type, request_id, new Uint8Array); // empty record terminates stream
	}

	pend_read_fcgi_stdout(request_id: number, str: string)
	{	this.pend_read_fcgi_stdin(request_id, str, false, FCGI_STDOUT);
	}

	pend_read_fcgi_abort_request(request_id: number, stdin='')
	{	this.pend_read_fcgi_stdin(request_id, stdin, true);
	}

	pend_read_fcgi_end_request(request_id: number, protocol_status: 'request_complete'|'cant_mpx_conn'|'overloaded'|'unknown_role')
	{	let data = new Uint8Array(8);
		let v = new DataView(data.buffer);
		//v.setUint32(0, 0); // appStatus
		v.setUint8(4, PROTOCOL_STATUSES.indexOf(protocol_status)); // protocol_status
		//v.setUint8(5, 0); // reserved
		//v.setUint8(6, 0); // reserved
		//v.setUint8(7, 0); // reserved
		this.pend_read_fcgi(FCGI_END_REQUEST, request_id, data);
	}

	currupt_last_bytes(n_bytes=1)
	{	this.read_data = this.read_data.slice(0, -n_bytes);
	}

	take_written_fcgi(request_id=-1, only_id_record_type=-1, include_header_and_padding=false): {record_type: number, request_id: number, record_type_name: string, payload: Uint8Array} | undefined
	{	let written = this.get_written();
		let pos = request_id==-1 ? 0 : this.written_pos.get(request_id) || 0;
		while (pos+8 <= written.length)
		{	let header = new DataView(written.buffer, written.byteOffset+pos);
			let record_type = header.getUint8(1);
			let rec_request_id = header.getUint16(2);
			let content_length = header.getUint16(4);
			let padding_length = header.getUint8(6);
			if (only_id_record_type!=-1 && record_type!=only_id_record_type && request_id!=-1 && rec_request_id==request_id)
			{	return;
			}
			let prev_pos = pos;
			pos += 8 + content_length + padding_length;
			if (request_id != -1)
			{	this.written_pos.set(request_id, pos);
			}
			if (request_id!=-1 ? rec_request_id==request_id : prev_pos>=(this.written_pos.get(rec_request_id) ?? 0))
			{	let payload = written.subarray(include_header_and_padding ? prev_pos : prev_pos+8, include_header_and_padding ? pos : pos-padding_length);
				return {request_id: rec_request_id, record_type, record_type_name: RECORD_TYPE_NAMES[record_type] || '', payload};
			}
		}
		if (pos < written.length)
		{	throw new Error('Broken FastCGI record');
		}
	}

	take_written_fcgi_stdout(request_id: number, record_type=FCGI_STDOUT): string | undefined
	{	let data = new Uint8Array(0);
		let record;
		while ((record = this.take_written_fcgi(request_id, record_type)))
		{	if (record.payload.length == 0)
			{	break;
			}
			let tmp = new Uint8Array(data.length + record.payload.length);
			tmp.set(data);
			tmp.set(record.payload, data.length);
			data = tmp;
		}
		return new TextDecoder().decode(data);
	}

	take_written_fcgi_stderr(request_id: number): string | undefined
	{	return this.take_written_fcgi_stdout(request_id, FCGI_STDERR);
	}

	take_written_fcgi_stdin(request_id: number): string | undefined
	{	return this.take_written_fcgi_stdout(request_id, FCGI_STDIN);
	}

	take_written_fcgi_end_request(request_id: number): string
	{	let record = this.take_written_fcgi(request_id, FCGI_END_REQUEST);
		let protocol_status = -1;
		if (record)
		{	let header = new DataView(record.payload.buffer, record.payload.byteOffset);
			protocol_status = header.getUint8(4);
		}
		return PROTOCOL_STATUSES[protocol_status] || '';
	}

	take_written_fcgi_begin_request(request_id: number): {role: ''|'responder'|'authorizer'|'filter', keep_conn: boolean} | undefined
	{	let record = this.take_written_fcgi(request_id, FCGI_BEGIN_REQUEST);
		if (!record)
		{	return;
		}
		let header = new DataView(record.payload.buffer, record.payload.byteOffset);
		let role_num = header.getUint16(0);
		let keep_conn = header.getUint8(2) != 0;
		let role: ''|'responder'|'authorizer'|'filter' = role_num==FCGI_RESPONDER ? 'responder' : role_num==FCGI_AUTHORIZER ? 'authorizer' : role_num==FCGI_FILTER ? 'filter' : '';
		return {role, keep_conn};
	}

	take_written_fcgi_unknown_type(): string
	{	let record = this.take_written_fcgi(0, FCGI_UNKNOWN_TYPE);
		let record_type = -1;
		if (record)
		{	let header = new DataView(record.payload.buffer, record.payload.byteOffset);
			record_type = header.getUint8(0);
		}
		return record_type==-1 ? '' : RECORD_TYPE_NAMES[record_type] || record_type+'';
	}

	async take_written_fcgi_get_values_result(request_id=0, record_type=FCGI_GET_VALUES_RESULT): Promise<Map<string, string> | undefined>
	{	let {payload} = this.take_written_fcgi(request_id, record_type, true) || {};
		if (!payload)
		{	return;
		}
		let data = payload.slice();
		// "payload" contains FCGI_GET_VALUES_RESULT record.
		// I want to convert it to FCGI_PARAMS to parse.
		// To do so, i need to modify 2 fields in header: record_type and request_id
		let header = new DataView(data.buffer, data.byteOffset);
		header.setUint8(1, FCGI_PARAMS); // record_type
		header.setUint16(2, 1); // request_id
		// Parse the FCGI_PARAMS record
		let conn_1 = new MockFcgiConn(1024, -1, 'no');
		let conn_2 = new MockFcgiConn(1024, -1, 'no');
		let listener = new MockListener([conn_1, conn_2]);
		let server = new Server(listener);
		conn_1.pend_read_fcgi_begin_request(1, 'responder', false);
		conn_1.pend_read(data);
		conn_1.pend_read_fcgi(FCGI_PARAMS, 1, new Uint8Array); // empty record terminates stream
		// add 1 correct connection, to avoid "Module evaluation is still pending" in case of parse error
		conn_2.pend_read_fcgi_begin_request(1, 'responder', false);
		conn_2.pend_read_fcgi_params(1, {});
		conn_2.pend_read_fcgi_stdin(1, '');
		for await (let req of server)
		{	return req.params;
		}
	}

	async take_written_fcgi_params(request_id: number): Promise<Map<string, string> | undefined>
	{	// read first params record
		let params = await this.take_written_fcgi_get_values_result(request_id, FCGI_PARAMS);
		let {payload} = this.take_written_fcgi(request_id, FCGI_PARAMS) || {};
		if (!payload || payload.length>0)
		{	return;
		}
		return params;
	}

	toString()
	{	let str = '';
		for (let data of [this.read_data, this.get_written()])
		{	if (data!=this.read_data && data.length)
			{	str += '----------- OUTPUT -----------\n\n';
			}
			let pos = 0;
			while (pos+8 <= data.length)
			{	let header = new DataView(data.buffer, data.byteOffset+pos);
				let record_type = header.getUint8(1);
				let request_id = header.getUint16(2);
				let content_length = header.getUint16(4);
				let padding_length = header.getUint8(6);
				let payload = data.subarray(pos+8, pos+8+content_length);
				str += `@${pos} ID${request_id} ${RECORD_TYPE_NAMES[record_type] || '?'} (${content_length} + ${padding_length} bytes)`;
				if (record_type == FCGI_BEGIN_REQUEST)
				{	let role = header.getUint16(8);
					let keep_conn = (header.getUint8(10) & FCGI_KEEP_CONN)!=0 ? 'keep_conn' : '!keep_conn';
					let role_name = role==FCGI_RESPONDER ? 'responder' : role==FCGI_AUTHORIZER ? 'authorizer' : 'filter';
					str += `: ${role_name} ${keep_conn}`;
				}
				else if (record_type != FCGI_PARAMS)
				{	str += ': ' + new TextDecoder().decode(payload);
				}
				str += '\n\n';
				pos += 8 + content_length + padding_length;
			}
		}
		return str;
	}
}
