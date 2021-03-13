import {MockConn} from "./mock_conn.ts";
import {pack_nvp} from "../../server_request.ts";

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

export class MockFcgiConn extends MockConn
{	private written_pos = new Map<number, number>();

	constructor(chunk_size: number, private without_padding=false, private split_stream_records=false)
	{	super('', chunk_size);
	}

	private pend_read_fcgi(record_type: number, request_id: number, payload: string|Uint8Array)
	{	let payload_bytes = typeof(payload)!='string' ? payload : new TextEncoder().encode(payload);
		let padding = this.without_padding ? 0 : (8 - payload_bytes.length%8) % 8;
		let tmp_2 = new Uint8Array(8 + payload_bytes.length + padding);
		tmp_2.set(payload_bytes, 8);
		let header = new DataView(tmp_2.buffer);
		header.setUint8(0, 1); // version
		header.setUint8(1, record_type); // type
		header.setUint16(2, request_id); // request_id
		header.setUint16(4, payload_bytes.length); // content_length
		header.setUint8(6, padding); // padding_length
		this.pend_read(tmp_2);
	}

	pend_read_fcgi_begin_request(request_id: number, role: 'responder'|'authorizer'|'filter', keep_conn: boolean)
	{	let payload = new Uint8Array(8);
		let p = new DataView(payload.buffer);
		p.setUint16(0, role=='responder' ? FCGI_RESPONDER : role=='authorizer' ? FCGI_AUTHORIZER : FCGI_FILTER);
		p.setUint8(2, keep_conn ? FCGI_KEEP_CONN : 0);
		this.pend_read_fcgi(FCGI_BEGIN_REQUEST, request_id, payload);
	}

	pend_read_fcgi_params(request_id: number, params: any)
	{	let data = pack_nvp(FCGI_PARAMS, request_id, new Map(Object.entries(params)), 100000, 100000);
		let break_at = Math.min(this.chunk_size % 10, data.length-9); // choose break boundary depending on "chunk_size" (so will test many possibilities)
		if (!this.split_stream_records || break_at<=0)
		{	this.pend_read(data);
		}
		else
		{	let part_0 = data.slice(0, 8+break_at); // header + "break_at" bytes
			let part_1 = data.slice(break_at); // space for new header + data starting at byte "break_at"
			let header_0 = new DataView(part_0.buffer);
			let header_1 = new DataView(part_1.buffer);
			let content_length = header_0.getUint16(4);
			let padding_length = header_0.getUint8(6);
			// header_0
			header_0.setUint8(0, 1); // version
			header_0.setUint8(1, FCGI_PARAMS); // record_type
			header_0.setUint16(2, request_id); // request_id
			header_0.setUint16(4, break_at); // content_length
			header_0.setUint8(6, 0); // padding_length
			header_0.setUint8(7, 0); // reserved
			// header_1
			header_1.setUint8(0, 1); // version
			header_1.setUint8(1, FCGI_PARAMS); // record_type
			header_1.setUint16(2, request_id); // request_id
			header_1.setUint16(4, content_length-break_at); // content_length
			header_1.setUint8(6, padding_length); // padding_length
			header_1.setUint8(7, 0); // reserved
			// send
			this.pend_read(part_0);
			this.pend_read(part_1);
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

	pend_read_fcgi_abort_request(request_id: number)
	{	this.pend_read_fcgi(FCGI_ABORT_REQUEST, request_id, new Uint8Array);
	}

	take_written_fcgi(request_id: number): {record_type: number, payload: Uint8Array} | undefined
	{	let written = this.get_written();
		let pos = this.written_pos.get(request_id) || 0;
		while (pos+8 <= written.length)
		{	let header = new DataView(written.buffer, pos);
			let record_type = header.getUint8(1);
			let rec_request_id = header.getUint16(2);
			let content_length = header.getUint16(4);
			let padding_length = header.getUint8(6);
			pos += 8 + content_length + padding_length;
			this.written_pos.set(request_id, pos);
			if (rec_request_id == request_id)
			{	let payload = written.subarray(pos-padding_length-content_length, pos-padding_length);
				return {record_type, payload};
			}
		}
	}

	take_written_fcgi_stdout(request_id: number, is_stderr=false): string | undefined
	{	let record_type = is_stderr ? FCGI_STDERR : FCGI_STDOUT;
		let data = new Uint8Array(0);
		let record;
		while ((record = this.take_written_fcgi(request_id))?.record_type == record_type)
		{	if (record!.payload.length == 0)
			{	break;
			}
			let tmp = new Uint8Array(data.length + record!.payload.length);
			tmp.set(data);
			tmp.set(record!.payload, data.length);
			data = tmp;
		}
		return new TextDecoder().decode(data);
	}

	take_written_fcgi_end_request(request_id: number): string
	{	let record = this.take_written_fcgi(request_id);
		let protocol_status = -1;
		if (record?.record_type == FCGI_END_REQUEST)
		{	let header = new DataView(record!.payload.buffer);
			protocol_status = header.getUint8(4);
		}
		return protocol_status==FCGI_REQUEST_COMPLETE ? 'request_complete' : protocol_status==FCGI_UNKNOWN_ROLE ? 'unknown_role' : '';
	}
}
